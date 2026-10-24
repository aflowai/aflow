import { describe, expect, it } from 'vitest';
import { FlowScheduleCreateInputSchema, MAX_FIRINGS_CAP } from './operations.js';
import { resolveInputTemplate } from './inputResolution.js';
import { isScheduleRenewalDue, SCHEDULE_RENEWAL_WINDOW, scheduleFiringsLeft } from './renewal.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const SCHEDULE_ID = '5247eee7-0000-4000-8000-000000000001';

function recurring(firingCount: number) {
  return {
    kind: 'cron' as const,
    status: 'active' as const,
    maxFirings: MAX_FIRINGS_CAP,
    firingCount,
    expiresAt: '2026-11-23T12:00:00Z',
  };
}

describe('a recurring schedule is due for renewal only within the window of its firing cap', () => {
  it(`is due with ${String(SCHEDULE_RENEWAL_WINDOW)} firings left and after`, () => {
    for (let left = SCHEDULE_RENEWAL_WINDOW; left >= 0; left -= 1) {
      expect(isScheduleRenewalDue(recurring(MAX_FIRINGS_CAP - left), NOW)).toBe(true);
    }
  });

  it(`is not due with ${String(SCHEDULE_RENEWAL_WINDOW + 1)} firings left`, () => {
    expect(
      isScheduleRenewalDue(recurring(MAX_FIRINGS_CAP - SCHEDULE_RENEWAL_WINDOW - 1), NOW),
    ).toBe(false);
  });

  it('is not due where its owner paused it, or it is deleted or expired', () => {
    for (const status of ['paused', 'deleted', 'expired'] as const) {
      expect(isScheduleRenewalDue({ ...recurring(MAX_FIRINGS_CAP - 1), status }, NOW)).toBe(false);
    }
  });

  it('is not due for a one-shot or an on-completion schedule', () => {
    for (const kind of ['one_shot', 'on_completion'] as const) {
      expect(isScheduleRenewalDue({ ...recurring(MAX_FIRINGS_CAP - 1), kind }, NOW)).toBe(false);
    }
  });

  it('is not due past its expiry: the chain ends at its time bound', () => {
    expect(
      isScheduleRenewalDue(
        { ...recurring(MAX_FIRINGS_CAP - 1), expiresAt: '2026-10-24T11:59:59Z' },
        NOW,
      ),
    ).toBe(false);
  });

  it('is not due where nothing caps its firings', () => {
    expect(isScheduleRenewalDue({ ...recurring(10), maxFirings: null }, NOW)).toBe(false);
    expect(scheduleFiringsLeft({ maxFirings: null, firingCount: 10 })).toBeNull();
  });

  it('counts the firings left, never below zero', () => {
    expect(scheduleFiringsLeft({ maxFirings: 50, firingCount: 46 })).toBe(4);
    expect(scheduleFiringsLeft({ maxFirings: 50, firingCount: 52 })).toBe(0);
  });
});

describe('agent.schedule.create — renews', () => {
  it('a renewal is renews alone', () => {
    const parsed = FlowScheduleCreateInputSchema.safeParse({ renews: SCHEDULE_ID });
    expect(parsed.success).toBe(true);
  });

  it('a renewal that also describes a schedule is refused, naming the field', () => {
    const parsed = FlowScheduleCreateInputSchema.safeParse({
      renews: SCHEDULE_ID,
      cron: '*/5 * * * *',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(['cron']);
    }
  });

  it('a new schedule still needs its name, action and input', () => {
    const parsed = FlowScheduleCreateInputSchema.safeParse({ cron: '*/5 * * * *' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['name', 'action', 'input']));
    }
  });
});

describe('a schedule template names the firing schedule', () => {
  it('resolves { $schedule: "id" } to the schedule that is firing', async () => {
    const resolved = await resolveInputTemplate(
      { input: 'tend', config: { scheduleId: { $schedule: 'id' } } },
      { schedule: { id: SCHEDULE_ID }, now: NOW },
    );
    expect(resolved).toEqual({ input: 'tend', config: { scheduleId: SCHEDULE_ID } });
  });

  it('refuses { $schedule } where no schedule is firing', async () => {
    await expect(resolveInputTemplate({ id: { $schedule: 'id' } }, { now: NOW })).rejects.toThrow(
      '$schedule',
    );
  });
});
