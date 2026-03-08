import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import {
    generateMobilePairingCode,
    getMobilePairingStatus,
} from "../api/mobile-chat.js";
import { fetchPrivacyMode } from "../api/settings.js";
import { Modal } from "./Modal.js";

const DEFAULT_TTL_MS = 60_000;

interface MobileBindingModalProps {
    isOpen: boolean;
    onClose: () => void;
    onBindingSuccess: () => void;
}

export function MobileBindingModal({ isOpen, onClose, onBindingSuccess }: MobileBindingModalProps) {
    const { t } = useTranslation();

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [pairingCode, setPairingCode] = useState<string | null>(null);
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [existingCount, setExistingCount] = useState(0);
    const [privacyMode, setPrivacyMode] = useState(false);
    const [qrRevealed, setQrRevealed] = useState(false);
    const [expired, setExpired] = useState(false);
    const [remainingSeconds, setRemainingSeconds] = useState(0);

    const pollIntervalRef = useRef<number | null>(null);
    const baseCountRef = useRef(0);
    const expiryTimerRef = useRef<number | null>(null);
    const countdownRef = useRef<number | null>(null);
    // Stable ref for onBindingSuccess to avoid re-triggering useEffect
    const onBindingSuccessRef = useRef(onBindingSuccess);
    onBindingSuccessRef.current = onBindingSuccess;

    // Load privacy mode setting and listen for changes
    useEffect(() => {
        fetchPrivacyMode().then(setPrivacyMode).catch(() => {});

        function onPrivacyChanged() {
            fetchPrivacyMode().then(setPrivacyMode).catch(() => {});
        }
        window.addEventListener("privacy-settings-changed", onPrivacyChanged);
        return () => window.removeEventListener("privacy-settings-changed", onPrivacyChanged);
    }, []);

    // Reset revealed state when modal opens
    useEffect(() => {
        if (isOpen) setQrRevealed(false);
    }, [isOpen]);

    const clearTimers = useCallback(() => {
        if (expiryTimerRef.current) { clearTimeout(expiryTimerRef.current); expiryTimerRef.current = null; }
        if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    }, []);

    const generateCode = useCallback(async () => {
        try {
            setError(null);
            setLoading(true);
            setExpired(false);
            clearTimers();

            const res = await generateMobilePairingCode();
            setPairingCode(res.code || null);

            if (res.code) {
                const qrContent = res.qrUrl || `https://chat.zhuazhuaai.cn?code=${res.code}`;
                const qrData = await QRCode.toDataURL(qrContent, {
                    margin: 2,
                    width: 250,
                    color: { dark: "#000000FF", light: "#FFFFFFFF" }
                });
                setQrDataUrl(qrData);

                const ttl = res.ttlMs ?? DEFAULT_TTL_MS;
                const ttlSeconds = Math.round(ttl / 1000);
                setRemainingSeconds(ttlSeconds);
                countdownRef.current = window.setInterval(() => {
                    setRemainingSeconds(prev => {
                        if (prev <= 1) {
                            if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
                            return 0;
                        }
                        return prev - 1;
                    });
                }, 1000);
                expiryTimerRef.current = window.setTimeout(() => {
                    setExpired(true);
                }, ttl);
            } else {
                setQrDataUrl(null);
            }
        } catch (err: any) {
            setError(t("mobile.generationFailed", { error: err.message || "Unknown error" }));
        } finally {
            setLoading(false);
        }
    }, [t, clearTimers]);

    // Stable ref for generateCode so the effect doesn't re-run when it changes
    const generateCodeRef = useRef(generateCode);
    generateCodeRef.current = generateCode;

    // Main effect: generate code once and start polling when modal opens
    useEffect(() => {
        if (!isOpen) {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }
            return;
        }

        let cancelled = false;

        (async () => {
            // Load initial pairing count and generate code (once per modal open)
            try {
                const res = await getMobilePairingStatus();
                const count = res.pairings?.length ?? 0;
                if (!cancelled) {
                    setExistingCount(count);
                    baseCountRef.current = count;
                }
            } catch { /* ignore */ }
            if (!cancelled) await generateCodeRef.current();
        })();

        // Poll: detect when a NEW pairing appears (count increases)
        pollIntervalRef.current = window.setInterval(async () => {
            try {
                const res = await getMobilePairingStatus();
                const count = res.pairings?.length ?? 0;
                setExistingCount(count);
                if (count > baseCountRef.current && pollIntervalRef.current) {
                    clearInterval(pollIntervalRef.current);
                    pollIntervalRef.current = null;
                    onBindingSuccessRef.current();
                }
            } catch { /* ignore */ }
        }, 3000);

        return () => {
            cancelled = true;
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }
            clearTimers();
        };
    }, [isOpen, clearTimers]);

    const showBlur = privacyMode && !qrRevealed;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("mobile.statusTitle")}
            maxWidth={420}
        >
            <div className="modal-form-col">
                {error && <div className="modal-error-box">{error}</div>}

                <div className="mobile-pairing-modal-body">
                    {loading && !pairingCode ? (
                        <p>{t("common.loading")}</p>
                    ) : (
                        <div className="mobile-pairing-view">
                            {existingCount > 0 && (
                                <p className="mobile-existing-hint">
                                    {t("mobile.existingPairings", { count: existingCount })}
                                </p>
                            )}

                            {expired
                                ? <div className="status-badge badge-danger">{t("mobile.codeExpired")}</div>
                                : <div className="status-badge badge-warning">{t("mobile.waitingForConnection")}</div>
                            }
                            <p className="mobile-scan-hint">
                                {expired ? t("mobile.codeExpiredHint") : t("mobile.scanHint")}
                            </p>

                            {qrDataUrl && (
                                <div
                                    className={`mobile-qr-container${showBlur ? " qr-privacy-blur" : ""}${expired ? " qr-expired" : ""}`}
                                    onClick={showBlur ? () => setQrRevealed(true) : expired ? () => generateCode() : undefined}
                                >
                                    <img src={qrDataUrl} alt="Pairing QR Code" width={250} height={250} />
                                    {showBlur && (
                                        <div className="qr-privacy-overlay">
                                            {t("settings.app.clickToReveal")}
                                        </div>
                                    )}
                                    {expired && !showBlur && (
                                        <div className="qr-expired-overlay">
                                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                                                <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                                            </svg>
                                            <span>{t("mobile.clickToRefresh")}</span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {!expired && !showBlur && (
                                <p className="mobile-countdown">{t("mobile.expiresIn", { seconds: remainingSeconds })}</p>
                            )}

                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}
