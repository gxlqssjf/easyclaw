import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MobileSyncEngine } from './sync-engine';
import { RelayTransport } from './relay-transport';

// Mock transport
function createMockTransport(): RelayTransport {
    const handlers = new Map<string, Function>();
    const statusSubs = new Set<Function>();
    const sent: any[] = [];

    return {
        registerHandler: vi.fn((pairingId: string, handler: Function) => {
            handlers.set(pairingId, handler);
        }),
        unregisterHandler: vi.fn((pairingId: string) => {
            handlers.delete(pairingId);
        }),
        subscribeStatus: vi.fn((cb: Function) => {
            statusSubs.add(cb);
            cb('offline');
            return () => statusSubs.delete(cb);
        }),
        send: vi.fn((pairingId: string, msg: any) => {
            sent.push({ pairingId, msg });
        }),
        isConnected: vi.fn(() => true),
        // Test helpers
        _handlers: handlers,
        _statusSubs: statusSubs,
        _sent: sent,
    } as any;
}

describe('MobileSyncEngine', () => {
    let api: any;
    let transport: ReturnType<typeof createMockTransport>;
    let engine: MobileSyncEngine;

    beforeEach(() => {
        api = {};
        transport = createMockTransport();
        engine = new MobileSyncEngine(api, transport as any, 'pairing-1', 'desktop-xyz', 'mobile-123');
    });

    it('should register handler with transport on start()', () => {
        engine.start();

        expect(transport.registerHandler).toHaveBeenCalledWith('pairing-1', expect.any(Function));
        expect(transport.subscribeStatus).toHaveBeenCalled();
    });

    it('should unregister handler on stop()', () => {
        engine.start();
        engine.stop();

        expect(transport.unregisterHandler).toHaveBeenCalledWith('pairing-1');
    });

    it('should queue outbound messages and send via transport', () => {
        engine.start();
        const id = engine.queueOutbound('mobile-123', { type: 'text', text: 'Hello' });

        expect(id).toBeDefined();
        expect(transport.send).toHaveBeenCalledWith('pairing-1', expect.objectContaining({
            type: 'msg',
            id,
            sender: 'desktop',
            payload: { type: 'text', text: 'Hello' },
        }));

        // Should be in outbox
        const cached = (engine as any).outbox.get(id);
        expect(cached).toBeDefined();
        expect(cached.payload.text).toBe('Hello');
    });

    it('should delete from outbox when receiving an ACK', async () => {
        engine.start();
        const id = engine.queueOutbound('mobile-123', { type: 'text', text: 'Hello' });
        expect((engine as any).outbox.has(id)).toBe(true);

        // Simulate incoming ACK via handler
        const handler = (transport as any)._handlers.get('pairing-1');
        await handler({ type: 'ack', id });

        expect((engine as any).outbox.has(id)).toBe(false);
    });

    it('should send ACK via transport when receiving a message', async () => {
        engine.start();
        transport.send.mockClear();

        const handler = (transport as any)._handlers.get('pairing-1');
        await handler({
            type: 'msg',
            id: 'msg-1',
            sender: 'mobile',
            payload: { type: 'text', text: 'Hi from phone' }
        });

        expect(transport.send).toHaveBeenCalledWith('pairing-1', { type: 'ack', id: 'msg-1' });
    });

    it('should update mobileOnline on peer_status', async () => {
        engine.start();
        expect(engine.mobileOnline).toBe(false);

        const handler = (transport as any)._handlers.get('pairing-1');
        await handler({ type: 'peer_status', pairingId: 'pairing-1', status: 'online' });
        expect(engine.mobileOnline).toBe(true);

        await handler({ type: 'peer_status', pairingId: 'pairing-1', status: 'offline' });
        expect(engine.mobileOnline).toBe(false);
    });

    it('should call onUnpaired when receiving unpair message', async () => {
        engine.start();
        const spy = vi.fn();
        engine.onUnpaired = spy;

        const handler = (transport as any)._handlers.get('pairing-1');
        await handler({ type: 'unpair', pairingId: 'pairing-1' });

        expect(spy).toHaveBeenCalled();
    });

    it('should send unpair message via transport on sendUnpairAndStop()', () => {
        engine.start();
        transport.send.mockClear();

        engine.sendUnpairAndStop();

        expect(transport.send).toHaveBeenCalledWith('pairing-1', { type: 'unpair' });
    });
});
