import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { loadCoachFeedback } from './coachFeedback.js';

function streamEntry(
  eventType: string,
  summary: string,
  ts: number = Date.now(),
): [string, string[]] {
  return [
    `${String(ts)}-0`,
    [
      'eventType',
      eventType,
      'timestamp',
      String(ts),
      'summary',
      summary,
      'payload',
      JSON.stringify({}),
    ],
  ];
}

function mockRedis(entries: Array<[string, string[]]>): Redis {
  return {
    xrevrange: vi.fn().mockResolvedValue(entries),
  } as unknown as Redis;
}

describe('loadCoachFeedback', () => {
  it('loads entity.coach.ratified and entity.coach.rejected events', async () => {
    const redis = mockRedis([
      streamEntry('entity.coach.ratified', 'ok-1', 1_000),
      streamEntry('entity.coach.rejected', 'no-1', 2_000),
    ]);
    const entries = await loadCoachFeedback(redis, 'tenant', 'space-uuid', 10);
    expect(entries).toHaveLength(2);
    const types = entries.map((e) => e.eventType);
    expect(types).toContain('entity.coach.ratified');
    expect(types).toContain('entity.coach.rejected');
  });

  it('loads entity.coach.apply_failed events (Plan 163 §6.6)', async () => {
    const redis = mockRedis([streamEntry('entity.coach.apply_failed', 'apply failure', 3_000)]);
    const entries = await loadCoachFeedback(redis, 'tenant', 'space-uuid', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventType).toBe('entity.coach.apply_failed');
  });

  it('does NOT load entity.coach.preview_failed events (telemetry only)', async () => {
    const redis = mockRedis([
      streamEntry('entity.coach.preview_failed', 'preview failure', 4_000),
      streamEntry('entity.coach.ratified', 'should-survive', 5_000),
    ]);
    const entries = await loadCoachFeedback(redis, 'tenant', 'space-uuid', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventType).toBe('entity.coach.ratified');
  });

  it('does NOT load other entity.coach.* event types (e.g. ratification_failed) into the envelope', async () => {
    const redis = mockRedis([
      streamEntry('entity.coach.ratification_failed', 'rat-fail', 6_000),
      streamEntry('entity.coach.proposal', 'proposal', 7_000),
      streamEntry('entity.coach.activated', 'activated', 8_000),
    ]);
    const entries = await loadCoachFeedback(redis, 'tenant', 'space-uuid', 10);
    expect(entries).toHaveLength(0);
  });
});
