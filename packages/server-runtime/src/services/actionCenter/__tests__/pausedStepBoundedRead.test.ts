/**
 * The paused-step list is one bounded read per open: the SQL window caps the
 * sessions read, every read session costs exactly one payload read, and the
 * reads run a bounded number at a time rather than one after another. The
 * list built from them keeps the row order and the per-kind discrimination.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

const mockWithTenantSchema = vi.fn();

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: (...args: unknown[]) => mockWithTenantSchema(...args),
  sessions: {
    sessionId: 'sessionId',
    spaceId: 'spaceId',
    status: 'status',
    currentStepExecutionId: 'currentStepExecutionId',
    requestedInputRef: 'requestedInputRef',
    pauseReason: 'pauseReason',
    startedAt: 'startedAt',
    hotStateSnapshot: 'hotStateSnapshot',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  isNotNull: (...args: unknown[]) => args,
  desc: (col: unknown) => col,
}));

import {
  createPausedStepSource,
  PAUSED_SESSION_QUERY_CAP,
  PAYLOAD_READ_CONCURRENCY,
  type PausedStepSourceDeps,
} from '../sources/pausedStepSource.js';
import type { ActionCenterScope } from '../types.js';

const TENANT = '00000000-0000-4000-8000-000000000001' as unknown as TenantId;
const SPACE = '00000000-0000-4000-8000-000000000002';
const SCOPE: ActionCenterScope = { tenantId: TENANT, spaceId: SPACE };

interface FakeSessionRow {
  sessionId: string;
  spaceId: string | null;
  status: string;
  currentStepExecutionId: string | null;
  requestedInputRef: string | null;
  pauseReason: string | null;
  startedAt: Date;
  hotStateSnapshot: unknown;
}

/** Row `i`'s pause kind: input, approval, then an unrecognised kind the list drops. */
function kindOf(i: number): string {
  return ['input', 'approval', 'unknown'][i % 3]!;
}

function rows(count: number): FakeSessionRow[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `sess-${i}`,
    spaceId: SPACE,
    status: 'PAUSED',
    currentStepExecutionId: `step-${i}`,
    requestedInputRef: `ref-${i}`,
    pauseReason: 'input_required',
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)),
    hotStateSnapshot: null,
  }));
}

interface Harness {
  deps: PausedStepSourceDeps;
  reads: string[];
  sqlLimits: number[];
  maxInFlight: () => number;
}

function harness(stored: FakeSessionRow[], readDelayMs = 0): Harness {
  const sqlLimits: number[] = [];
  mockWithTenantSchema.mockImplementation(async (_db, _ctx, cb: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: (n: number) => {
        sqlLimits.push(n);
        return Promise.resolve(stored.slice(0, n));
      },
    };
    return cb(builder);
  });

  const reads: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const payloadStore: Pick<PayloadStore, 'retrieve'> = {
    retrieve: async (ref) => {
      reads.push(ref as string);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs));
      else await Promise.resolve();
      inFlight--;
      const i = Number((ref as string).slice('ref-'.length));
      return { kind: kindOf(i), title: `Pause ${i}`, prompt: `Prompt ${i}` } as never;
    },
  };

  return {
    deps: {
      db: {} as never,
      redis: {} as never,
      payloadStore: payloadStore as PayloadStore,
      sessionService: { resumeSession: vi.fn() } as never,
    },
    reads,
    sqlLimits,
    maxInFlight: () => maxInFlight,
  };
}

describe('pausedStepSource — bounded payload read per open', () => {
  beforeEach(() => {
    mockWithTenantSchema.mockReset();
  });

  it('reads only the cap when the space holds more paused sessions than it', async () => {
    const stored = rows(PAUSED_SESSION_QUERY_CAP + 250);
    const h = harness(stored);

    const items = await createPausedStepSource(h.deps).listOpen(SCOPE);

    expect(h.sqlLimits).toEqual([PAUSED_SESSION_QUERY_CAP]);
    expect(h.reads).toHaveLength(PAUSED_SESSION_QUERY_CAP);
    expect(new Set(h.reads).size).toBe(PAUSED_SESSION_QUERY_CAP);

    const read = stored.slice(0, PAUSED_SESSION_QUERY_CAP);
    const expected = read.filter((_, i) => kindOf(i) !== 'unknown');
    expect(items.map((i) => i.id)).toEqual(expected.map((r) => `step:${r.currentStepExecutionId}`));
    for (const item of items) {
      const i = Number(item.id.slice('step:step-'.length));
      expect(item.kind).toBe(kindOf(i) === 'input' ? 'human_input' : 'human_approval');
      expect(item.title).toBe(`Pause ${i}`);
    }
  });

  it('keeps no more than the concurrency bound of payload reads in flight', async () => {
    const h = harness(rows(97), 1);

    const items = await createPausedStepSource(h.deps).listOpen(SCOPE);

    expect(h.reads).toHaveLength(97);
    expect(h.maxInFlight()).toBeGreaterThan(1);
    expect(h.maxInFlight()).toBeLessThanOrEqual(PAYLOAD_READ_CONCURRENCY);
    // Rows 2, 5, …, 95 carry the unrecognised kind: 32 of the 97 drop out.
    expect(items).toHaveLength(65);
  });

  it('builds the same list from the same rows when reads finish out of order', async () => {
    const stored = rows(40);
    const h = harness(stored);
    const inOrder = await createPausedStepSource(h.deps).listOpen(SCOPE);

    const shuffled = harness(stored);
    const retrieve = shuffled.deps.payloadStore.retrieve.bind(shuffled.deps.payloadStore);
    shuffled.deps.payloadStore.retrieve = async (ref) => {
      const i = Number((ref as string).slice('ref-'.length));
      await new Promise((r) => setTimeout(r, (40 - i) % 7));
      return retrieve(ref);
    };
    const outOfOrder = await createPausedStepSource(shuffled.deps).listOpen(SCOPE);

    expect(outOfOrder).toEqual(inOrder);
  });

  it('returns an empty list without reading when no session is paused', async () => {
    const h = harness([]);
    expect(await createPausedStepSource(h.deps).listOpen(SCOPE)).toEqual([]);
    expect(h.reads).toEqual([]);
  });
});
