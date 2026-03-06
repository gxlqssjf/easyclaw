import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Storage, MobilePairing } from "@easyclaw/storage";
import { createLogger } from "@easyclaw/logger";

const log = createLogger("mobile-manager");

export class MobileManager {
    private activeCode: { code: string; expiresAt: number } | null = null;
    private desktopDeviceId: string | null = null;
    private waitAbort: AbortController | null = null;
    private waitingForCode: string | null = null;

    constructor(
        private readonly storage: Storage,
        private readonly controlPlaneUrl: string = "https://api.easy-claw.com",
        private readonly stateDir?: string,
    ) { }

    public getDesktopDeviceId(): string {
        if (this.desktopDeviceId) {
            return this.desktopDeviceId;
        }

        // Persist desktop device ID to disk so pairings survive restarts
        if (this.stateDir) {
            const idDir = join(this.stateDir, "identity");
            const idPath = join(idDir, "mobile-desktop-id.txt");
            try {
                const stored = readFileSync(idPath, "utf-8").trim();
                if (stored) {
                    this.desktopDeviceId = stored;
                    return stored;
                }
            } catch {
                // File doesn't exist yet — will create below
            }

            const id = randomUUID();
            try {
                mkdirSync(idDir, { recursive: true });
                writeFileSync(idPath, id, "utf-8");
            } catch (err) {
                log.error("Failed to persist desktop device ID:", err);
            }
            this.desktopDeviceId = id;
            return id;
        }

        this.desktopDeviceId = randomUUID();
        return this.desktopDeviceId;
    }

    public async requestPairingCode(): Promise<{ code: string; qrUrl?: string }> {
        const deviceId = this.getDesktopDeviceId();

        try {
            const response = await fetch(`${this.controlPlaneUrl}/graphql`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: `mutation GeneratePairingCode($desktopDeviceId: String!) {
  generatePairingCode(desktopDeviceId: $desktopDeviceId) {
    code
    qrUrl
  }
}`,
                    variables: { desktopDeviceId: deviceId },
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to generate pairing code: ${response.statusText}`);
            }

            const json = await response.json() as {
                data?: { generatePairingCode: { code: string; qrUrl?: string } };
                errors?: Array<{ message: string }>;
            };

            if (json.errors?.length) {
                throw new Error(`GraphQL error: ${json.errors[0].message}`);
            }

            if (!json.data) {
                throw new Error("Failed to generate pairing code: no data in response");
            }

            const data = json.data.generatePairingCode;
            this.activeCode = {
                code: data.code,
                expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
            };

            return { code: data.code, ...(data.qrUrl ? { qrUrl: data.qrUrl } : {}) };
        } catch (error) {
            log.error("Error requesting pairing code:", error);
            throw error;
        }
    }

    public getActivePairing() {
        return this.storage.mobilePairings.getActivePairing();
    }

    public getAllPairings(): MobilePairing[] {
        return this.storage.mobilePairings.getAllPairings();
    }

    public disconnectPairing(pairingId?: string): void {
        if (pairingId) {
            this.storage.mobilePairings.removePairingById(pairingId);
            log.info("Mobile pairing disconnected:", pairingId);
        } else {
            this.storage.mobilePairings.clearPairing();
            this.activeCode = null;
            log.info("All mobile pairings disconnected");
        }
    }

    public getActiveCode(): { code: string; expiresAt: number } | null {
        if (this.activeCode && this.activeCode.expiresAt > Date.now()) {
            return this.activeCode;
        }
        this.activeCode = null;
        return null;
    }

    public clearActiveCode(): void {
        this.activeCode = null;
        this.abortWait();
    }

    /** Abort any in-flight waitForControlPlaneToken request. */
    private abortWait(): void {
        if (this.waitAbort) {
            this.waitAbort.abort();
            this.waitAbort = null;
        }
        this.waitingForCode = null;
    }

    public async waitForControlPlaneToken(code: string): Promise<{
        paired: boolean;
        pairingId?: string;
        accessToken?: string;
        relayUrl?: string;
        desktopDeviceId?: string;
        mobileDeviceId?: string;
    }> {
        // Deduplicate: if already waiting for the same code, skip
        if (this.waitingForCode === code) {
            return { paired: false };
        }

        // Abort any previous wait for a different code
        this.abortWait();

        const ac = new AbortController();
        this.waitAbort = ac;
        this.waitingForCode = code;

        try {
            const response = await fetch(`${this.controlPlaneUrl}/graphql`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query: `query WaitForPairing($code: String!) {
  waitForPairing(code: $code) {
    paired
    pairingId
    accessToken
    relayUrl
    desktopDeviceId
    mobileDeviceId
    reason
  }
}`,
                    variables: { code },
                }),
                signal: ac.signal,
            });
            if (!response.ok) return { paired: false };

            const json = await response.json() as {
                data?: {
                    waitForPairing: {
                        paired: boolean;
                        pairingId?: string;
                        accessToken?: string;
                        relayUrl?: string;
                        desktopDeviceId?: string;
                        mobileDeviceId?: string;
                        reason?: string;
                    };
                };
                errors?: Array<{ message: string }>;
            };

            if (json.errors?.length) {
                log.error("GraphQL error waiting for pairing:", json.errors[0].message);
                return { paired: false };
            }

            if (!json.data) {
                return { paired: false };
            }

            return json.data.waitForPairing;
        } catch (error: any) {
            if (error?.name === "AbortError") {
                log.info("Pairing wait aborted for code:", code);
                return { paired: false };
            }
            log.error("Error waiting for pairing status:", error);
            return { paired: false };
        } finally {
            // Clean up if this is still the active wait
            if (this.waitingForCode === code) {
                this.waitAbort = null;
                this.waitingForCode = null;
            }
        }
    }
}
