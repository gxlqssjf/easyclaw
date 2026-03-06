/**
 * Shared WebSocket transport for multiplexed relay connections (Node.js / desktop).
 * One transport manages a single WebSocket connection, with multiple
 * pairings multiplexed by pairingId.
 */

import { WebSocket } from 'ws';

export type TransportStatus = 'connecting' | 'online' | 'offline';
export type MessageHandler = (msg: any) => void;

interface PendingJoin {
    resolve: (result: { pairingId: string; peerOnline: boolean }) => void;
    reject: (err: Error) => void;
    accessToken: string;
}

export class RelayTransport {
    private ws: WebSocket | null = null;
    private status: TransportStatus = 'offline';
    private handlers: Map<string, MessageHandler> = new Map();       // pairingId -> handler
    private pairingTokens: Map<string, string> = new Map();          // pairingId -> accessToken
    private statusSubscribers: Set<(status: TransportStatus) => void> = new Set();
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private relayUrl: string = '';
    private pendingJoins: Map<string, PendingJoin> = new Map();      // accessToken -> pending

    /**
     * Start the transport with the initial pairing credentials.
     */
    start(relayUrl: string, accessToken: string, pairingId: string): void {
        this.stopped = false;
        this.relayUrl = relayUrl;
        this.pairingTokens.set(pairingId, accessToken);
        this.connect();
    }

    /**
     * Add a new pairing to this transport.
     */
    async joinPairing(pairingId: string, accessToken: string): Promise<{ pairingId: string; peerOnline: boolean }> {
        this.pairingTokens.set(pairingId, accessToken);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return new Promise((resolve, reject) => {
                this.pendingJoins.set(accessToken, { resolve, reject, accessToken });
                this.ws!.send(JSON.stringify({ type: 'join', accessToken }));

                setTimeout(() => {
                    if (this.pendingJoins.has(accessToken)) {
                        this.pendingJoins.delete(accessToken);
                        reject(new Error('join timeout'));
                    }
                }, 10_000);
            });
        }

        return { pairingId, peerOnline: false };
    }

    leavePairing(pairingId: string): void {
        this.pairingTokens.delete(pairingId);
        this.handlers.delete(pairingId);
    }

    send(pairingId: string, message: object): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ ...message, pairingId }));
    }

    registerHandler(pairingId: string, handler: MessageHandler): void {
        this.handlers.set(pairingId, handler);
    }

    unregisterHandler(pairingId: string): void {
        this.handlers.delete(pairingId);
    }

    subscribeStatus(cb: (status: TransportStatus) => void): () => void {
        this.statusSubscribers.add(cb);
        cb(this.status);
        return () => this.statusSubscribers.delete(cb);
    }

    getStatus(): TransportStatus {
        return this.status;
    }

    isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    hasPairings(): boolean {
        return this.pairingTokens.size > 0;
    }

    disconnect(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (_) { /* ignore */ }
            this.ws = null;
        }
        this.updateStatus('offline');
        this.pairingTokens.clear();
        this.handlers.clear();
        for (const pending of this.pendingJoins.values()) {
            pending.reject(new Error('transport disconnected'));
        }
        this.pendingJoins.clear();
    }

    // --- Internal ---

    /**
     * If the relay returned a real pairingId that differs from our local key
     * (e.g. old DB records keyed by mobileDeviceId), re-key all internal maps.
     */
    private rekeyIfNeeded(realPairingId: string, accessToken: string): void {
        for (const [oldKey, token] of this.pairingTokens) {
            if (token === accessToken && oldKey !== realPairingId) {
                console.log(`[DesktopRelayTransport] Re-keying pairing: ${oldKey} -> ${realPairingId}`);
                this.pairingTokens.delete(oldKey);
                this.pairingTokens.set(realPairingId, token);
                const handler = this.handlers.get(oldKey);
                if (handler) {
                    this.handlers.delete(oldKey);
                    this.handlers.set(realPairingId, handler);
                }
                break;
            }
        }
    }

    private connect(): void {
        if (this.stopped || this.pairingTokens.size === 0) return;

        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (_) { /* ignore */ }
            this.ws = null;
        }

        this.updateStatus('connecting');

        const [_firstPairingId, firstToken] = this.pairingTokens.entries().next().value!;

        let routeUrl = this.relayUrl.endsWith('/')
            ? `${this.relayUrl}mobile-chat`
            : `${this.relayUrl}/mobile-chat`;

        const wsUrl = `${routeUrl}?token=${firstToken}&client=desktop`;

        try {
            this.ws = new WebSocket(wsUrl);

            this.ws.on('open', () => {
                console.log('[DesktopRelayTransport] Connected to relay.');
                this.updateStatus('online');

                // Send rejoin for all pairings
                const tokens = Array.from(this.pairingTokens.values());
                if (tokens.length > 0) {
                    this.ws!.send(JSON.stringify({ type: 'rejoin', tokens }));
                }

                // Flush outbox of all handlers (engines will handle this themselves)
            });

            this.ws.on('message', (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString('utf-8'));
                    this.handleIncoming(msg);
                } catch (err: any) {
                    console.error('[DesktopRelayTransport] Invalid WS payload:', err.message);
                }
            });

            this.ws.on('close', () => {
                console.log('[DesktopRelayTransport] Disconnected from relay.');
                this.ws = null;
                this.updateStatus('offline');
                this.scheduleReconnect();
            });

            this.ws.on('error', (err) => {
                console.error('[DesktopRelayTransport] WebSocket error:', err.message);
                this.ws?.close();
            });

        } catch (err: any) {
            console.error('[DesktopRelayTransport] Failed to initialize WebSocket:', err.message);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            console.log('[DesktopRelayTransport] Attempting to reconnect...');
            this.connect();
        }, 3000);
    }

    private handleIncoming(data: any): void {
        if (data.type === 'join_ack') {
            for (const [token, pending] of this.pendingJoins) {
                this.pendingJoins.delete(token);
                pending.resolve({ pairingId: data.pairingId, peerOnline: data.peerOnline });
                break;
            }
            return;
        }

        if (data.type === 'join_err') {
            const pending = this.pendingJoins.get(data.accessToken);
            if (pending) {
                this.pendingJoins.delete(data.accessToken);
                pending.reject(new Error(data.error || 'join failed'));
            }
            return;
        }

        if (data.type === 'rejoin_ack') {
            if (Array.isArray(data.pairings)) {
                for (const p of data.pairings) {
                    // The relay returns the real pairingId from backend.
                    // If our local key differs (e.g. old DB record without pairingId),
                    // re-key our internal maps so future messages route correctly.
                    if (p.accessToken) {
                        this.rekeyIfNeeded(p.pairingId, p.accessToken);
                    }

                    const handler = this.handlers.get(p.pairingId);
                    if (handler) {
                        handler({ type: 'peer_status', pairingId: p.pairingId, status: p.peerOnline ? 'online' : 'offline' });
                    }
                }
            }
            return;
        }

        // Dispatch by pairingId
        const pairingId = data.pairingId;
        if (pairingId) {
            const handler = this.handlers.get(pairingId);
            if (handler) {
                handler(data);
            }
        }
    }

    private updateStatus(status: TransportStatus): void {
        if (this.status === status) return;
        this.status = status;
        for (const sub of this.statusSubscribers) {
            sub(status);
        }
    }
}
