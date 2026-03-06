import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import fs from "node:fs/promises";
import { RelayTransport } from './relay-transport';

// Ensure the local media directory exists.
const MEDIA_DIR = join(homedir(), ".easyclaw", "openclaw", "media", "inbound", "mobile");

export class MobileSyncEngine {
    private outbox: Map<string, any> = new Map();
    private unsubTransport: (() => void) | null = null;

    public readonly mobileDeviceId: string;
    public pairingId: string;
    public mobileOnline: boolean = false;
    public onUnpaired: (() => void) | null = null;

    constructor(
        private readonly api: any, // GatewayPluginApi
        private transport: RelayTransport,
        pairingId: string,
        private desktopDeviceId: string,
        mobileDeviceId: string,
    ) {
        this.pairingId = pairingId;
        this.mobileDeviceId = mobileDeviceId;
        this.ensureMediaDir();
    }

    private async ensureMediaDir() {
        await fs.mkdir(MEDIA_DIR, { recursive: true });
    }

    public start() {
        // Register handler for this pairing's messages
        this.transport.registerHandler(this.pairingId, (msg) => this.handleIncoming(msg));

        // Subscribe to transport connection status for reconnect outbox flush
        this.unsubTransport = this.transport.subscribeStatus((status) => {
            if (status === 'online') {
                // On reconnect, flush outbox
                for (const [_id, msg] of this.outbox.entries()) {
                    this.transport.send(this.pairingId, msg);
                }
            }
            if (status === 'offline') {
                this.mobileOnline = false;
            }
        });
    }

    public stop() {
        this.mobileOnline = false;
        this.transport.unregisterHandler(this.pairingId);
        if (this.unsubTransport) {
            this.unsubTransport();
            this.unsubTransport = null;
        }
    }

    /** Notify the mobile peer that this pairing is being removed, then stop. */
    public sendUnpairAndStop() {
        this.transport.send(this.pairingId, { type: "unpair" });
        // Small delay to let the message flush before unregistering
        setTimeout(() => this.stop(), 200);
    }

    public get isRelayConnected(): boolean {
        return this.transport.isConnected();
    }

    public queueOutbound(_destination: string, content: any) {
        const id = randomUUID();
        const msg = {
            type: "msg",
            id,
            sender: "desktop",
            timestamp: Date.now(),
            payload: content
        };

        // Cache for ACK
        this.outbox.set(id, msg);

        // Send immediately if possible (transport.send adds pairingId)
        this.transport.send(this.pairingId, msg);
        return id;
    }

    private async handleIncoming(msg: any) {
        switch (msg.type) {
            case "ack":
                if (msg.id) {
                    this.outbox.delete(msg.id);
                }
                break;

            case "sync_req":
                this.transport.send(this.pairingId, {
                    type: "sync_res",
                    id: randomUUID(),
                    messages: []
                });
                break;

            case "peer_status":
                this.mobileOnline = msg.status === "online";
                console.log(`[MobileSync:${this.pairingId.slice(0,8)}] Mobile peer is now ${msg.status}`);
                break;

            case "unpair":
                console.log(`[MobileSync:${this.pairingId.slice(0,8)}] Received unpair from mobile`);
                this.onUnpaired?.();
                break;

            case "msg":
                // Send ACK via transport
                this.transport.send(this.pairingId, { type: "ack", id: msg.id });
                await this.processIncomingPayload(msg);
                break;
        }
    }

    private async processIncomingPayload(msg: any) {
        const { payload, sender } = msg;

        if (sender !== "mobile" || !payload) return;

        try {
            const core = this.api.runtime;
            const cfg = this.api.config;

            let messageText = "";
            let mediaPaths: string[] = [];
            let mediaTypes: string[] = [];

            if (payload.type === "text") {
                messageText = payload.text;
            } else if (payload.type === "image") {
                const fileName = `mobile-img-${Date.now()}.jpg`;
                const filePath = join(MEDIA_DIR, fileName);

                const b64Data = payload.data.replace(/^data:image\/\w+;base64,/, "");
                await fs.writeFile(filePath, Buffer.from(b64Data, 'base64'));

                messageText = payload.text || "[Image from mobile]";
                mediaPaths.push(filePath);
                mediaTypes.push(payload.mimeType || "image/jpeg");
            } else if (payload.type === "voice") {
                const ext = (payload.mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm";
                const fileName = `mobile-voice-${Date.now()}.${ext}`;
                const filePath = join(MEDIA_DIR, fileName);

                const b64Data = (payload.data || "").replace(/^data:audio\/\w+;base64,/, "");
                await fs.writeFile(filePath, Buffer.from(b64Data, "base64"));

                messageText = payload.text || "[Voice message]";
                mediaPaths.push(filePath);
                mediaTypes.push(payload.mimeType || "audio/webm");
            } else if (payload.type === "file") {
                const ext = (payload.mimeType || "application/octet-stream").split("/").pop() || "bin";
                const fileName = `mobile-file-${Date.now()}.${ext}`;
                const filePath = join(MEDIA_DIR, fileName);

                const b64Data = (payload.data || "").replace(/^data:[^;]+;base64,/, "");
                await fs.writeFile(filePath, Buffer.from(b64Data, "base64"));

                messageText = payload.text || "[File from mobile]";
                mediaPaths.push(filePath);
                mediaTypes.push(payload.mimeType || "application/octet-stream");
            }

            if (!messageText && mediaPaths.length === 0) return;

            const route = core.channel.routing.resolveAgentRoute({
                cfg,
                channel: "mobile",
                accountId: this.pairingId,
                peer: { kind: "direct", id: this.pairingId },
            });

            const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
            const storePath = core.channel.session.resolveStorePath(
                (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
                { agentId: route.agentId },
            );
            const previousTimestamp = core.channel.session.readSessionUpdatedAt({
                storePath,
                sessionKey: route.sessionKey,
            });

            const body = core.channel.reply.formatAgentEnvelope({
                channel: "Mobile",
                from: this.pairingId,
                timestamp: msg.timestamp || Date.now(),
                previousTimestamp,
                envelope: envelopeOptions,
                body: messageText,
            });

            const ctxPayload = core.channel.reply.finalizeInboundContext({
                Body: body,
                BodyForAgent: messageText,
                RawBody: messageText,
                CommandBody: messageText,
                From: `mobile:${this.pairingId}`,
                To: `mobile:${this.pairingId}`,
                SessionKey: route.sessionKey,
                AccountId: route.accountId,
                ChatType: "direct",
                ConversationLabel: `Mobile ${this.pairingId.slice(0, 8)}`,
                Provider: "mobile",
                Surface: "mobile",
                MessageSid: msg.id,
                Timestamp: msg.timestamp || Date.now(),
                OriginatingChannel: "mobile",
                OriginatingTo: `mobile:${this.pairingId}`,
                CommandAuthorized: true,
                ...(mediaPaths.length > 0 ? { MediaPaths: mediaPaths, MediaTypes: mediaTypes } : {}),
            });

            await core.channel.session.recordInboundSession({
                storePath,
                sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
                ctx: ctxPayload,
                onRecordError: (err: any) => {
                    console.error("[MobileSync] session meta error:", err);
                },
            });

            // Track last block text to dedup block+final deliveries.
            // The buffered dispatcher calls deliver() for both streaming blocks
            // and the final reply, which often carry identical text.
            let lastBlockText: string | null = null;
            await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg,
                dispatcherOptions: {
                    deliver: async (replyPayload: any, info: { kind: string }) => {
                        const text = replyPayload.text ?? "";
                        if (!text) return;
                        if (info.kind === "block") {
                            lastBlockText = text;
                            this.queueOutbound(this.pairingId, { type: "text", text });
                            return;
                        }
                        // Skip final reply if it matches the last block (already delivered)
                        if (info.kind === "final" && text === lastBlockText) return;
                        this.queueOutbound(this.pairingId, { type: "text", text });
                    },
                    onError: (err: any, info: any) => {
                        console.error(`[MobileSync] ${info.kind} reply failed:`, err);
                    },
                },
            });

            console.log("[MobileSync] Message dispatched to agent. sessionKey:", route.sessionKey);

        } catch (err: any) {
            console.error("[MobileSync] Failed to pass message to Gateway Agent:", err.message, err.stack);
        }
    }
}
