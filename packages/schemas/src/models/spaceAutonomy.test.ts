import { describe, expect, it } from 'vitest';
import { requiresWriteApproval } from './apiDefinition.js';
import {
  effectiveSpaceWritePolicy,
  parseSpaceAutonomyRaiseDirectiveLabel,
  resolveSpaceAutonomyPolicy,
  spaceAutonomyRaiseDirectiveLabel,
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

  it('keeps a stored full with the directive its raise recorded', () => {
    expect(
      resolveSpaceAutonomyPolicy({
        autonomy: 'full',
        directive: {
          nodeId: '22222222-2222-4222-8222-222222222222',
          documentRef: 'docs/plans/345-nothing-waits-on-the-operator.md@0123abc',
          label: spaceAutonomyRaiseDirectiveLabel('2026-11-21'),
          givenOn: '2026-11-21',
        },
      }).autonomy,
    ).toBe('full');
  });

  it('reads the day of a raise directive from its link label, and nothing from any other label', () => {
    const today = '2026-11-22';
    expect(
      parseSpaceAutonomyRaiseDirectiveLabel(spaceAutonomyRaiseDirectiveLabel('2026-11-21'), today),
    ).toBe('2026-11-21');
    expect(
      parseSpaceAutonomyRaiseDirectiveLabel(
        'operator directive 2026-11-21: autonomy full — "absolute autonomy please.. nothing waits on me."',
        today,
      ),
    ).toBe('2026-11-21');
    for (const label of [
      null,
      'operator directive: autonomy full',
      'operator directive 2026-11-21: autonomy ratify',
      'operator directive 2026-11-21: autonomy fullest',
      'operator directive 2026-02-30: autonomy full',
      'operator directive 2026-11-23: autonomy full',
      'plan document',
    ]) {
      expect(parseSpaceAutonomyRaiseDirectiveLabel(label, today)).toBeUndefined();
    }
  });
});
