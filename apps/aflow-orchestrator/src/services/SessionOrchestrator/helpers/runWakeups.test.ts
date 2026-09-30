import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { hasUnreadRunWakeups, readRunWakeups } from './runWakeups.js';

beforeEach(() => {
  rows.length = 0;
});

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

describe('hasUnreadRunWakeups', () => {
  const turnInput = (eventIds: string[]) => ({
    prompt: 'p',
    ...(eventIds.length > 0
      ? {
          newRunWakeups: eventIds.map((eventId) => ({
            eventId,
            envelope: { runId: 'run-a', outcome: 'paused', waiterId: 'w1' },
          })),
        }
      : {}),
  });

  it('is false for a session no run has reported to, without reading the turn', async () => {
    const payloadStore = { retrieve: vi.fn() };
    await expect(
      hasUnreadRunWakeups({} as never, payloadStore, 'tenant-1' as never, 's1', 'gs://b/turn'),
    ).resolves.toBe(false);
    expect(payloadStore.retrieve).not.toHaveBeenCalled();
  });

  it('is false when the turn was handed every wakeup in the window', async () => {
    rows.push({ eventId: 'e2', payloadRef: 'gs://b/2' }, { eventId: 'e1', payloadRef: 'gs://b/1' });
    const payloadStore = { retrieve: vi.fn(async () => turnInput(['e1', 'e2'])) };
    await expect(
      hasUnreadRunWakeups({} as never, payloadStore, 'tenant-1' as never, 's1', 'gs://b/turn'),
    ).resolves.toBe(false);
  });

  it('is true for a wakeup that landed after the turn’s input was built', async () => {
    rows.push({ eventId: 'e2', payloadRef: 'gs://b/2' }, { eventId: 'e1', payloadRef: 'gs://b/1' });
    const payloadStore = { retrieve: vi.fn(async () => turnInput(['e1'])) };
    await expect(
      hasUnreadRunWakeups({} as never, payloadStore, 'tenant-1' as never, 's1', 'gs://b/turn'),
    ).resolves.toBe(true);
  });

  it('counts a wakeup as unread when the turn’s input cannot be read', async () => {
    rows.push({ eventId: 'e1', payloadRef: 'gs://b/1' });
    const payloadStore = { retrieve: vi.fn(async () => Promise.reject(new Error('gone'))) };
    await expect(
      hasUnreadRunWakeups({} as never, payloadStore, 'tenant-1' as never, 's1', 'gs://b/turn'),
    ).resolves.toBe(true);
  });
});
