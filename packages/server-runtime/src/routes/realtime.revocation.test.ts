/**
 * Membership revocation must cut live realtime transport: subscriptions
 * authorize only at subscribe time, so the invalidation path closes the
 * user's connections — clients reconnect and re-subscribe against freshly
 * invalidated caches, where revoked topics get subscribe_denied.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeConnection,
  closeRealtimeConnectionsForUser,
  __registerRealtimeConnectionForTests,
} from './realtime.js';

interface FakeSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function makeConnection(
  tenantId: string,
  userId: string,
): {
  conn: RealtimeConnection;
  socket: FakeSocket;
  unregister: () => void;
} {
  const socket: FakeSocket = { send: vi.fn(), close: vi.fn(), on: vi.fn() };
  const conn = new RealtimeConnection({
    id: `conn-${tenantId}-${userId}`,
    socket: socket as never,
    token: { tenantId, userId, authMethod: 'test' } as never,
    clientId: 'client-1',
    tabId: 'tab-1',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
  });
  const unregister = __registerRealtimeConnectionForTests(conn);
  return { conn, socket, unregister };
}

describe('closeRealtimeConnectionsForUser', () => {
  it('notifies and closes every connection the user holds in the tenant', () => {
    const a = makeConnection('tenant-1', 'user-1');
    const b = makeConnection('tenant-1', 'user-1');
    try {
      const closed = closeRealtimeConnectionsForUser('tenant-1', 'user-1');
      expect(closed).toBe(2);
      for (const { socket } of [a, b]) {
        expect(socket.send).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(socket.send.mock.calls[0]?.[0] as string) as {
          type: string;
          code: string;
          retryable: boolean;
        };
        expect(sent).toMatchObject({ type: 'error', code: 'access_revoked', retryable: true });
        expect(socket.close).toHaveBeenCalledWith(4403, 'access_revoked');
      }
    } finally {
      a.unregister();
      b.unregister();
    }
  });

  it('leaves the same user’s connections in OTHER tenants untouched', () => {
    const target = makeConnection('tenant-1', 'user-1');
    const other = makeConnection('tenant-2', 'user-1');
    try {
      const closed = closeRealtimeConnectionsForUser('tenant-1', 'user-1');
      expect(closed).toBe(1);
      expect(target.socket.close).toHaveBeenCalledTimes(1);
      expect(other.socket.close).not.toHaveBeenCalled();
      expect(other.socket.send).not.toHaveBeenCalled();
    } finally {
      target.unregister();
      other.unregister();
    }
  });

  it('is a no-op for a user with no live connections', () => {
    expect(closeRealtimeConnectionsForUser('tenant-1', 'user-none')).toBe(0);
  });
});
