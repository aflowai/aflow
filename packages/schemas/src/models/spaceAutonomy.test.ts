import { describe, expect, it } from 'vitest';
import { requiresWriteApproval } from './apiDefinition.js';
import { effectiveSpaceWritePolicy, resolveSpaceAutonomyPolicy } from './spaceAutonomy.js';

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
});
