import { describe, expect, it, vi } from 'vitest';

const rows: Array<{ eventId: string; payloadRef: string | null }> = [];
vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(() => ({})),
  eventLog: {
    eventId: 'event_id',
    payloadRef: 'payload_ref',
    sessionId: 's',
    eventType: 't',
    timestamp: 'ts',
  },
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([...rows]) }) }),
        }),
      }),
    }),
  ),
}));

import { readRunWakeups } from './runWakeups.js';

describe('readRunWakeups', () => {
  it('returns the window oldest first, each keyed by its event, skipping what does not read', async () => {
    // Newest first, as the log returns it.
    rows.push(
      { eventId: 'e3', payloadRef: 'gs://b/unreadable' },
      { eventId: 'e2', payloadRef: 'gs://b/completed' },
      { eventId: 'e1', payloadRef: 'gs://b/paused' },
      { eventId: 'e0', payloadRef: null },
    );
    const envelopes: Record<string, unknown> = {
      'gs://b/paused': { runId: 'run-a', outcome: 'paused', waiterId: 'w1' },
      'gs://b/completed': { runId: 'run-a', outcome: 'completed', waiterId: 'w1' },
      'gs://b/unreadable': { nothing: 'here' },
    };
    const payloadStore = { retrieve: vi.fn(async (ref: string) => envelopes[ref]) };

    const entries = await readRunWakeups(
      {} as never,
      payloadStore,
      'tenant-1' as never,
      'session-1',
    );

    expect(entries).toEqual([
      { eventId: 'e1', envelope: { runId: 'run-a', outcome: 'paused', waiterId: 'w1' } },
      { eventId: 'e2', envelope: { runId: 'run-a', outcome: 'completed', waiterId: 'w1' } },
    ]);
  });
});
