import { describe, it, expect } from 'vitest';
import { McpConnectionPool, poolKeyManaged, poolKeyRaw, type PoolEntry } from './connectionPool.js';

function fakeEntry(lastUsedMs = Date.now(), cleanup?: () => void): PoolEntry {
  return {
    client: { close: async () => {} } as unknown as PoolEntry['client'],
    transport: {} as unknown as PoolEntry['transport'],
    lastUsedMs,
    ...(cleanup ? { cleanups: [cleanup] } : {}),
  };
}

describe('McpConnectionPool', () => {
  it('returns undefined when key is absent', () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    expect(pool.get('missing')).toBeUndefined();
  });

  it('returns the same entry on subsequent gets', () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    const entry = fakeEntry();
    pool.set('k', entry);
    expect(pool.get('k')).toBe(entry);
  });

  it('evicts the least-recently-used entry when at capacity', () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    pool.set('a', fakeEntry(100));
    pool.set('b', fakeEntry(200));
    expect(pool.get('a')).toBeDefined();
    pool.set('c', fakeEntry(300)); // forces eviction of 'a' (oldest)
    expect(pool.get('a')).toBeUndefined();
    expect(pool.get('b')).toBeDefined();
    expect(pool.get('c')).toBeDefined();
  });

  it('does not evict when replacing an existing key', () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    pool.set('a', fakeEntry(100));
    pool.set('b', fakeEntry(200));
    pool.set('a', fakeEntry(300)); // overwrite, not insertion
    expect(pool.get('a')).toBeDefined();
    expect(pool.get('b')).toBeDefined();
  });

  it('touch() updates the timestamp so LRU eviction respects recent use', () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    pool.set('a', fakeEntry(100)); // oldest
    pool.set('b', fakeEntry(200));
    pool.touch('a'); // a is now most recently used
    pool.set('c', fakeEntry(300)); // should evict 'b' instead of 'a'
    expect(pool.get('a')).toBeDefined();
    expect(pool.get('b')).toBeUndefined();
    expect(pool.get('c')).toBeDefined();
  });

  it('remove() drops a specific entry', async () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    pool.set('a', fakeEntry());
    await pool.remove('a');
    expect(pool.get('a')).toBeUndefined();
  });

  it('removeMatching() drops keys matching a predicate', async () => {
    const pool = new McpConnectionPool({ maxEntries: 4 });
    pool.set('m:srv-1|bind-1', fakeEntry());
    pool.set('m:srv-2|bind-2', fakeEntry());
    pool.set('r:https://x.example.com/mcp', fakeEntry());

    await pool.removeMatching((k) => k.startsWith('m:'));

    expect(pool.get('m:srv-1|bind-1')).toBeUndefined();
    expect(pool.get('m:srv-2|bind-2')).toBeUndefined();
    expect(pool.get('r:https://x.example.com/mcp')).toBeDefined();
  });

  it('calls entry.cleanup() on remove (Plan 103 §7.2 — list_changed handler teardown)', async () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    let cleanupCalled = 0;
    pool.set(
      'm:srv|bid|spc',
      fakeEntry(Date.now(), () => cleanupCalled++),
    );
    await pool.remove('m:srv|bid|spc');
    expect(cleanupCalled).toBe(1);
  });

  it('calls entry.cleanup() on LRU eviction', async () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    let cleanupCalled = 0;
    pool.set(
      'a',
      fakeEntry(100, () => cleanupCalled++),
    );
    pool.set('b', fakeEntry(200));
    pool.set('c', fakeEntry(300)); // forces eviction of 'a' (oldest with cleanup)
    // eviction runs cleanup async; flush microtasks + macrotasks
    await new Promise((r) => setTimeout(r, 10));
    expect(cleanupCalled).toBe(1);
    expect(pool.get('a')).toBeUndefined();
  });

  it('runs ALL cleanups on an entry, not just the first', async () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    const calls: string[] = [];
    const entry = fakeEntry();
    entry.cleanups = [() => calls.push('list_changed'), () => calls.push('elicitation')];
    pool.set('k', entry);
    await pool.remove('k');
    expect(calls).toEqual(['list_changed', 'elicitation']);
  });

  it('fires inflightAborters before cleanups so suspended handlers see lease_lost before client closes', async () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    const order: string[] = [];
    const entry = fakeEntry();
    entry.inflightAborters = new Set([() => order.push('aborter')]);
    entry.cleanups = [() => order.push('cleanup')];
    pool.set('k', entry);
    await pool.remove('k');
    expect(order).toEqual(['aborter', 'cleanup']);
  });

  it('LRU prefers inactive entries — busy entries are protected', async () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    // 'a' is older but busy (parked elicitation); 'b' is newer but
    // inactive. Inserting 'c' should evict 'b', not 'a'.
    const busy = fakeEntry(100);
    busy.inflightAborters = new Set([(): void => {}]);
    pool.set('a', busy);
    pool.set('b', fakeEntry(200));
    pool.set('c', fakeEntry(300));
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.get('a')).toBeDefined(); // protected
    expect(pool.get('b')).toBeUndefined(); // evicted
    expect(pool.get('c')).toBeDefined();
  });

  it('LRU falls back to busy entries when nothing inactive remains', async () => {
    const pool = new McpConnectionPool({ maxEntries: 2 });
    const busyOld = fakeEntry(100);
    busyOld.inflightAborters = new Set([(): void => {}]);
    const busyNew = fakeEntry(200);
    busyNew.inflightAborters = new Set([(): void => {}]);
    pool.set('a', busyOld);
    pool.set('b', busyNew);
    pool.set('c', fakeEntry(300));
    await new Promise((r) => setTimeout(r, 10));
    // 'a' is the oldest; fallback path evicts it even though busy.
    expect(pool.get('a')).toBeUndefined();
    expect(pool.get('b')).toBeDefined();
    expect(pool.get('c')).toBeDefined();
  });
});

describe('McpConnectionPool — narrow-key invalidation (Plan 103 Phase 4)', () => {
  it('removeMatching with binding-segment substring leaves OTHER bindings intact', async () => {
    const pool = new McpConnectionPool({ maxEntries: 4 });
    pool.set('m:tenant-a|kaggle|kaggle-default|space-a', fakeEntry());
    pool.set('m:tenant-a|kaggle|kaggle-admin|space-a', fakeEntry());
    pool.set('m:tenant-a|linear|linear-default|space-a', fakeEntry());

    // Mirror invalidateSpace(tenantId, spaceId, { bindingId: 'kaggle-default' })
    const tenantPrefix = `m:tenant-a|`;
    const needle = `|kaggle-default|`;
    await pool.removeMatching((k) => k.startsWith(tenantPrefix) && k.includes(needle));

    expect(pool.get('m:tenant-a|kaggle|kaggle-default|space-a')).toBeUndefined();
    expect(pool.get('m:tenant-a|kaggle|kaggle-admin|space-a')).toBeDefined();
    expect(pool.get('m:tenant-a|linear|linear-default|space-a')).toBeDefined();
  });

  it('removeMatching with binding-segment substring works across spaces', async () => {
    const pool = new McpConnectionPool({ maxEntries: 4 });
    pool.set('m:tenant-a|kaggle|kaggle-default|space-a', fakeEntry());
    pool.set('m:tenant-a|kaggle|kaggle-default|space-b', fakeEntry());

    const tenantPrefix = `m:tenant-a|`;
    const needle = `|kaggle-default|`;
    await pool.removeMatching((k) => k.startsWith(tenantPrefix) && k.includes(needle));

    // Same bindingId across spaces: both go (different binding row in each
    // space, but the call-site is signalling "this bindingId mutated tenant-wide").
    expect(pool.get('m:tenant-a|kaggle|kaggle-default|space-a')).toBeUndefined();
    expect(pool.get('m:tenant-a|kaggle|kaggle-default|space-b')).toBeUndefined();
  });

  it('tenant-scoped invalidation leaves OTHER tenants intact (cross-tenant leakage guard)', async () => {
    const pool = new McpConnectionPool({ maxEntries: 4 });
    // Two tenants happen to share the same stable bindingId (e.g.
    // platform-seeded defaults). Without the tenant prefix, an
    // invalidation on tenant-a would have closed tenant-b's warm session.
    pool.set('m:tenant-a|kaggle|kaggle-default|space-a', fakeEntry());
    pool.set('m:tenant-b|kaggle|kaggle-default|space-b', fakeEntry());

    const tenantPrefix = `m:tenant-a|`;
    const needle = `|kaggle-default|`;
    await pool.removeMatching((k) => k.startsWith(tenantPrefix) && k.includes(needle));

    expect(pool.get('m:tenant-a|kaggle|kaggle-default|space-a')).toBeUndefined();
    expect(pool.get('m:tenant-b|kaggle|kaggle-default|space-b')).toBeDefined();
  });
});

describe('poolKey helpers', () => {
  it('produces distinct keys for managed vs raw paths', () => {
    expect(poolKeyManaged('tenant-a', 'kaggle', 'kaggle-default', 'space-a')).toBe(
      'm:tenant-a|kaggle|kaggle-default|space-a',
    );
    expect(poolKeyRaw('https://mcp.example.com/mcp')).toBe('r:https://mcp.example.com/mcp');
    expect(poolKeyManaged('tenant-a', 'kaggle', 'kaggle-default', 'space-a')).not.toBe(
      poolKeyRaw('m:tenant-a|kaggle|kaggle-default|space-a'),
    );
  });

  it('keys are distinct across spaces for the same (tenantId, serverId, bindingId)', () => {
    expect(poolKeyManaged('tenant-a', 'kaggle', 'kaggle-default', 'space-a')).not.toBe(
      poolKeyManaged('tenant-a', 'kaggle', 'kaggle-default', 'space-b'),
    );
  });

  it('keys are distinct across tenants for the same (serverId, bindingId, spaceId)', () => {
    // Critical for multi-tenancy: platform-seeded defaults like
    // `kaggle-default` exist in every tenant and would alias without
    // the tenant prefix.
    expect(poolKeyManaged('tenant-a', 'kaggle', 'kaggle-default', 'space-a')).not.toBe(
      poolKeyManaged('tenant-b', 'kaggle', 'kaggle-default', 'space-a'),
    );
  });
});
