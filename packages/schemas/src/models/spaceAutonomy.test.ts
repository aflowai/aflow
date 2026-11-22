import { describe, expect, it } from 'vitest';
import { requiresWriteApproval } from './apiDefinition.js';
import {
  effectiveSpaceWritePolicy,
  nextSpaceAutonomyPolicy,
  spaceAutonomySettingOf,
  SpaceAutonomyPolicySchema,
  SpaceAutonomySettingSchema,
  resolveSpaceAutonomyPolicy,
} from './spaceAutonomy.js';

describe('the space autonomy setting (Plan 345 D)', () => {
  it('takes ratify and follow-catalog where nothing is stored, or what is stored does not parse', () => {
    const defaults = { autonomy: 'ratify', storeUpdates: 'follow-catalog' };
    expect(resolveSpaceAutonomyPolicy(null)).toEqual(defaults);
    expect(resolveSpaceAutonomyPolicy({})).toEqual(defaults);
    expect(resolveSpaceAutonomyPolicy({ autonomy: 'sometimes' })).toEqual(defaults);
    expect(resolveSpaceAutonomyPolicy({ autonomy: 'full' })).toEqual({
      autonomy: 'full',
      storeUpdates: 'follow-catalog',
    });
    expect(resolveSpaceAutonomyPolicy({ storeUpdates: 'manual' })).toEqual({
      autonomy: 'ratify',
      storeUpdates: 'manual',
    });
  });

  it('under full, ungates a medium write unless the write policy gates it, and keeps the high gate', () => {
    const full = (policy: Parameters<typeof effectiveSpaceWritePolicy>[0]) =>
      effectiveSpaceWritePolicy(policy, 'full');
    expect(requiresWriteApproval('medium', full(null))).toBe(false);
    expect(requiresWriteApproval('high', full(null))).toBe(true);
    expect(requiresWriteApproval('medium', full({ requireApprovalByTier: { medium: true } }))).toBe(
      true,
    );
    expect(requiresWriteApproval('high', full({ requireApprovalByTier: { high: false } }))).toBe(
      false,
    );
  });

  it('under ratify, leaves the write policy as it is', () => {
    expect(effectiveSpaceWritePolicy(null, 'ratify')).toBeNull();
    expect(requiresWriteApproval('medium', effectiveSpaceWritePolicy(null, 'ratify'))).toBe(true);
  });

  it('keeps a stored full with the directive its raise spent, and takes no directive in the REST setting', () => {
    const directive = {
      sessionId: '33333333-3333-4333-8333-333333333333',
      eventId: '44444444-4444-4444-8444-444444444444',
      eventType: 'SessionResumed',
      authorUserId: '00000000-0000-4000-8000-0000000000aa',
      postedAt: '2026-11-21T19:15:00.000Z',
      words: 'absolute autonomy please.. nothing waits on me.',
      spentAt: '2026-11-22T09:00:00.000Z',
    };
    expect(SpaceAutonomyPolicySchema.safeParse({ autonomy: 'full', directive }).success).toBe(true);
    expect(resolveSpaceAutonomyPolicy({ autonomy: 'full', directive }).autonomy).toBe('full');
    expect(
      SpaceAutonomyPolicySchema.safeParse({
        autonomy: 'full',
        directive: { ...directive, eventType: 'SessionStarted' },
      }).success,
    ).toBe(false);
    expect(SpaceAutonomySettingSchema.safeParse({ autonomy: 'full', directive }).success).toBe(
      false,
    );
    expect(
      SpaceAutonomySettingSchema.safeParse({ autonomy: 'full', storeUpdates: 'manual' }).success,
    ).toBe(true);
  });

  it('records the time of each change of autonomy, and keeps both times on a write that changes none', () => {
    const raise = new Date('2026-11-22T09:00:00.000Z');
    const lower = new Date('2026-11-22T10:00:00.000Z');
    const later = new Date('2026-11-22T11:00:00.000Z');

    const raised = nextSpaceAutonomyPolicy({
      stored: null,
      setting: { autonomy: 'full' },
      at: raise,
    });
    expect(raised).toEqual({ autonomy: 'full', raisedAt: raise.toISOString() });

    const lowered = nextSpaceAutonomyPolicy({ stored: raised, setting: null, at: lower });
    expect(lowered).toEqual({ raisedAt: raise.toISOString(), loweredAt: lower.toISOString() });
    expect(SpaceAutonomyPolicySchema.safeParse(lowered).success).toBe(true);

    const store = nextSpaceAutonomyPolicy({
      stored: lowered,
      setting: { ...spaceAutonomySettingOf(lowered), storeUpdates: 'manual' },
      at: later,
    });
    expect(store).toEqual({
      storeUpdates: 'manual',
      raisedAt: raise.toISOString(),
      loweredAt: lower.toISOString(),
    });
    expect(nextSpaceAutonomyPolicy({ stored: null, setting: null, at: later })).toBeNull();
  });
});
