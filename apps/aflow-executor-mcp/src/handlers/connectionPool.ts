import { type Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBackgroundTaskRunner, type BackgroundTaskRunner } from '@aflow/lib';
import { backgroundTaskControlPlane } from '@aflow/schemas';

const SWEEPER_TASK_ID = 'executor.mcp.connection_pool_reaper';

export interface PoolEntry {
  client: Client;
  transport: StreamableHTTPClientTransport;
  lastUsedMs: number;
  /** Negotiated session metadata captured at connect; populated by the handler. */
  protocolVersion?: string;
  serverInfo?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  cleanups?: Array<() => void | Promise<void>>;
  inflightAborters?: Set<() => void>;
  inflightCalls?: Map<string, InflightMcpCall>;
}

export interface InflightMcpCall {
  stepExecutionId: string;
  tenantId: string;
  spaceId: string;
  bindingId: string;
  serverId: string;
  /** Empty for workflow-task dispatch (no host session). */
  sessionId?: string;
  /** Lease TTL to use when an elicitation fires for this call. */
  elicitationLeaseMs: number;
  /**
   * The slot controller bound to the in-flight job. The elicitation
   * handler releases this slot during suspend and re-acquires before
   * returning. The handler was installed at acquire time and may not
   * have the right slotController for the *current* in-flight call;
   * carrying it on the call ctx ensures correctness.
   *
   * Untyped here to keep this file free of executor-runtime depend.
   */
  slotController?: { release(): void; acquire(): Promise<void>; readonly held: boolean };
}

export interface ConnectionPoolOptions {
  /** Maximum pooled connections. Default: 10. */
  maxEntries?: number;
  /** Idle TTL — close + evict after this many ms unused. Default: 5 min. */
  idleTtlMs?: number;
  /** Connect-attempt timeout. Default: 30s. */
  connectTimeoutMs?: number;
}

const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

/**
 * LRU pool of connected MCP clients. Not thread-safe but the executor runtime
 * routes each step to a single async slot so concurrent acquires on the same
 * key won't race in practice. The race would manifest as a duplicate connect
 * — acceptable cost vs the locking complexity.
 */
export class McpConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private sweeper: BackgroundTaskRunner | undefined;

  constructor(opts: ConnectionPoolOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  /** Start the idle-eviction sweeper. Call once at executor boot. */
  start(): void {
    if (this.sweeper) return;
    // Closing an upstream transport is unbounded work; a fixed interval would
    // start the next sweep on top of closes still in flight.
    const runtime = backgroundTaskControlPlane().resolve(SWEEPER_TASK_ID);
    this.sweeper = createBackgroundTaskRunner(
      {
        taskId: SWEEPER_TASK_ID,
        scope: runtime.scope,
        intervalMs: runtime.intervalMs ?? 30_000,
        maxBatch: runtime.maxBatch,
        maxCycleMs: runtime.maxCycleMs,
        mode: runtime.mode,
      },
      async (ctx) => {
        if (ctx.mode === 'observe') return { candidates: this.entries.size };
        const processed = await this.evictIdle(ctx.maxBatch);
        return { candidates: this.entries.size, processed };
      },
    );
    this.sweeper.start();
  }

  /** Stop sweeper and close all connections. Call at shutdown. */
  async shutdown(): Promise<void> {
    if (this.sweeper) {
      await this.sweeper.stop();
      this.sweeper = undefined;
    }
    const closes = Array.from(this.entries.values()).map(async (e) => {
      await runCleanup(e);
      await e.client.close().catch(() => undefined);
    });
    this.entries.clear();
    await Promise.all(closes);
  }

  /**
   * Get an existing pooled entry by key, or undefined.
   * Caller is responsible for `touch()`ing on use.
   */
  get(key: string): PoolEntry | undefined {
    return this.entries.get(key);
  }

  /** Mark an entry as recently used. */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedMs = Date.now();
  }

  /**
   * Insert a new entry, evicting LRU if at capacity.
   */
  set(key: string, entry: PoolEntry): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      this.evictOldest();
    }
    this.entries.set(key, entry);
  }

  /**
   * Drop and close a specific entry — used when a tenant invalidation arrives
   * or a connect fails mid-call.
   */
  async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await runCleanup(entry);
    await entry.client.close().catch(() => undefined);
  }

  /**
   * Drop all entries whose key matches a predicate. Used by the catalog
   * invalidation subscriber to flush a tenant's connections after a binding
   * update (auth might have changed).
   */
  async removeMatching(pred: (key: string) => boolean): Promise<void> {
    const keys = Array.from(this.entries.keys()).filter(pred);
    await Promise.all(keys.map((k) => this.remove(k)));
  }

  /**
   * True if the entry has parked work (an in-flight `mcp.tool.call` OR a
   * suspended elicitation). LRU + idle sweepers prefer to evict
   * inactive entries; closing a busy entry is correct (we wake the
   * suspended handler with `lease_lost` via `runCleanup`) but wasteful —
   * the tool call dies along with the warm session. Skip when possible.
   */
  private isBusy(e: PoolEntry): boolean {
    return (e.inflightCalls?.size ?? 0) > 0 || (e.inflightAborters?.size ?? 0) > 0;
  }

  private evictOldest(): void {
    // Two-pass: prefer to evict the oldest INACTIVE entry. Fall back to
    // the oldest entry overall only if everything is busy — at that
    // point we'd block forever otherwise.
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    let fallbackKey: string | undefined;
    let fallbackTs = Infinity;
    for (const [k, e] of this.entries) {
      if (e.lastUsedMs < fallbackTs) {
        fallbackTs = e.lastUsedMs;
        fallbackKey = k;
      }
      if (!this.isBusy(e) && e.lastUsedMs < oldestTs) {
        oldestTs = e.lastUsedMs;
        oldestKey = k;
      }
    }
    const chosen = oldestKey ?? fallbackKey;
    if (chosen !== undefined) {
      const evicted = this.entries.get(chosen)!;
      this.entries.delete(chosen);
      void (async (): Promise<void> => {
        await runCleanup(evicted);
        await evicted.client.close().catch(() => undefined);
      })();
    }
  }

  private async evictIdle(maxBatch: number): Promise<number> {
    const cutoff = Date.now() - this.idleTtlMs;
    const stale: string[] = [];
    for (const [k, e] of this.entries) {
      if (stale.length >= maxBatch) break;
      // Idle sweep only takes truly idle entries — busy entries by
      // definition have lastUsedMs touched recently OR have parked
      // handlers that have suppressed the touch. Skip the busy ones so
      // a server with mid-tool-call elicitations isn't surprise-evicted
      // by the sweeper.
      if (e.lastUsedMs < cutoff && !this.isBusy(e)) stale.push(k);
    }
    // Awaited rather than fire-and-forget: the close is the work this cycle is
    // accountable for, and an unobserved one outlives the budget that bounds it.
    for (const k of stale) {
      const entry = this.entries.get(k)!;
      this.entries.delete(k);
      await runCleanup(entry);
      await entry.client.close().catch(() => undefined);
    }
    return stale.length;
  }
}

/**
 * Tear down an entry's registered hooks. Order:
 *   1. Fire every aborter — wakes parked elicitation handlers BEFORE the
 *      SDK transport closes underneath them. Aborter callbacks are
 *      synchronous Promise resolvers; firing first means the handlers
 *      observe `lease_lost` cleanly instead of a thrown error.
 *   2. Run every registered cleanup hook (list_changed handler removal,
 *      elicitation request-handler removal).
 *
 * Per-step errors are swallowed; one bad hook must not block the rest.
 */
async function runCleanup(entry: PoolEntry): Promise<void> {
  if (entry.inflightAborters) {
    for (const abort of entry.inflightAborters) {
      try {
        abort();
      } catch {
        /* best-effort */
      }
    }
    entry.inflightAborters.clear();
  }
  if (entry.cleanups) {
    for (const fn of entry.cleanups) {
      try {
        await fn();
      } catch {
        /* best-effort — cleanup failures don't block client.close */
      }
    }
  }
}

/**
 * Compose a pool key for the managed path. Includes:
 *   - `tenantId` — the pool is process-global and shared across tenants on
 *     the executor. Without the tenant segment, two tenants that happen to
 *     use the same stable `bindingId` (e.g. platform-seeded defaults like
 *     `kaggle-default`) would alias to the same warm session, and a
 *     tenant-scoped binding invalidation would close the other tenant's
 *     in-flight calls (cross-tenant leakage).
 *   - `spaceId` — the same `bindingId` can exist in multiple spaces
 *     post-migration 84 (composite PK), each with potentially different
 *     credentials/policies — they must not share a warm session.
 */
export function poolKeyManaged(
  tenantId: string,
  serverId: string,
  bindingId: string,
  spaceId: string,
): string {
  return `m:${tenantId}|${serverId}|${bindingId}|${spaceId}`;
}

/** Compose a pool key for the raw path (dev-only). */
export function poolKeyRaw(serverUrl: string): string {
  return `r:${serverUrl}`;
}
