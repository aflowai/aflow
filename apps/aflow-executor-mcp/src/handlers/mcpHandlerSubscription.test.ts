import { describe, it, expect, vi } from 'vitest';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpHandler } from './mcpHandler.js';
import type { PoolEntry } from './connectionPool.js';

function makeEntry(capabilities?: Record<string, unknown>): {
  entry: PoolEntry;
  setSpy: ReturnType<typeof vi.fn>;
  removeSpy: ReturnType<typeof vi.fn>;
} {
  const setSpy = vi.fn();
  const removeSpy = vi.fn();
  const entry: PoolEntry = {
    client: {
      setNotificationHandler: setSpy,
      removeNotificationHandler: removeSpy,
      close: async () => {},
    } as unknown as PoolEntry['client'],
    transport: { protocolVersion: '2025-11-25' } as unknown as PoolEntry['transport'],
    lastUsedMs: Date.now(),
    ...(capabilities ? { capabilities } : {}),
  };
  return { entry, setSpy, removeSpy };
}

interface PrivateAccess {
  attachListChangedSubscription(
    entry: PoolEntry,
    tenantId: string,
    spaceId: string,
    serverId: string,
    bindingId: string,
    serverName: string,
    pinnedOrigin: string,
  ): void;
}

const attach = (handler: McpHandler, entry: PoolEntry): void =>
  (handler as unknown as PrivateAccess).attachListChangedSubscription(
    entry,
    'tenant-1',
    'space-a',
    'kaggle',
    'kaggle-default',
    'Kaggle',
    'https://www.kaggle.com',
  );

/**
 * Pick the list_changed cleanup hook off the entry's composable cleanups
 * array. Hooks tag themselves with `_kind` so the test (and the pool's
 * idempotent re-attach guard) can find them without index-juggling.
 */
function findListChangedCleanup(entry: PoolEntry): (() => void | Promise<void>) | undefined {
  return entry.cleanups?.find((fn) => (fn as { _kind?: string })._kind === 'list_changed');
}

describe('attachListChangedSubscription', () => {
  it('skips subscription when server does not advertise tools.listChanged', () => {
    const handler = new McpHandler({});
    const { entry, setSpy } = makeEntry({ tools: { listChanged: false } });
    attach(handler, entry);
    expect(setSpy).not.toHaveBeenCalled();
    // No list_changed cleanup pushed when the subscription was skipped.
    expect(findListChangedCleanup(entry)).toBeUndefined();
  });

  it('skips subscription when capabilities are absent', () => {
    const handler = new McpHandler({});
    const { entry, setSpy } = makeEntry(undefined);
    attach(handler, entry);
    expect(setSpy).not.toHaveBeenCalled();
    expect(findListChangedCleanup(entry)).toBeUndefined();
  });

  it('registers a notification handler when server advertises tools.listChanged', () => {
    const handler = new McpHandler({});
    const { entry, setSpy } = makeEntry({ tools: { listChanged: true } });
    attach(handler, entry);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![0]).toBe(ToolListChangedNotificationSchema);
    expect(typeof setSpy.mock.calls[0]![1]).toBe('function');
    expect(findListChangedCleanup(entry)).toBeDefined();
  });

  it('cleanup deregisters using the schema-derived method name', () => {
    const handler = new McpHandler({});
    const { entry, removeSpy } = makeEntry({ tools: { listChanged: true } });
    attach(handler, entry);
    findListChangedCleanup(entry)!();
    expect(removeSpy).toHaveBeenCalledWith('notifications/tools/list_changed');
    // The literal must match the SDK schema so a future SDK rename can't
    // silently break cleanup.
    expect(removeSpy.mock.calls[0]![0]).toBe(ToolListChangedNotificationSchema.shape.method.value);
  });

  it('is idempotent — re-attach on an already-attached entry is a no-op', () => {
    const handler = new McpHandler({});
    const { entry, setSpy } = makeEntry({ tools: { listChanged: true } });
    attach(handler, entry);
    attach(handler, entry);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
