/**
 * The eval trial grant (D5): live trials hold a READ-ONLY grant in the home
 * space — the mechanism that makes the live tier tolerable — while seeded
 * trials may write inside their own fixture space. The grant schema-parses
 * so `enforceGrant` consumes it exactly like a compiled one.
 */
import { describe, it, expect } from 'vitest';
import { RunAccessGrantSchema, enforceGrant } from '@aflow/schemas';
import { buildEvalTrialGrant, EVAL_TRIAL_GRANT_LIFETIME_SECONDS } from '../evalTrialGrant.js';

const HOME = '33333333-3333-4333-8333-333333333333';
const FIXTURE = '55555555-5555-4555-8555-555555555555';

describe('buildEvalTrialGrant', () => {
  it('is a schema-valid RunAccessGrant with no privileged surface', () => {
    const grant = RunAccessGrantSchema.parse(
      buildEvalTrialGrant({ runSpaceId: HOME, fixtureTier: 'live' }),
    );
    expect(grant.capabilities.allowPrivileged).toBe(false);
    expect(grant.capabilities.allowedCapabilities).toEqual([]);
  });

  it('live tier: mutating operations are denied non-retryably; reads (even external ones) pass', () => {
    const grant = buildEvalTrialGrant({ runSpaceId: HOME, fixtureTier: 'live' });
    expect(grant.accessLevel).toBe('read');
    expect(grant.spaceId).toBe(HOME);

    const write = enforceGrant(grant, 'memory.store.put', true, false, 'memory.store', 'write', []);
    expect(write.allowed).toBe(false);
    // The refusal names the read-only posture, which the step gate turns into
    // the non-retryable permission error a Runner answers with signal_blocked.
    if (!write.allowed) expect(write.reason).toContain('read-only');

    const read = enforceGrant(
      grant,
      'memory.store.query',
      false,
      false,
      'memory.store',
      'read',
      [],
    );
    expect(read).toEqual({ allowed: true });

    const externalRead = enforceGrant(
      grant,
      'search.web.query',
      false,
      false,
      'search.web',
      'read',
      ['external_side_effect'],
    );
    expect(externalRead).toEqual({ allowed: true });
  });

  it('live tier: the Runner loop itself (non-mutating, accessMode write) is not starved', () => {
    const grant = buildEvalTrialGrant({ runSpaceId: HOME, fixtureTier: 'live' });
    const turn = enforceGrant(grant, 'ai.agent.turn', false, false, 'ai.agent', 'write', []);
    expect(turn).toEqual({ allowed: true });
  });

  it('seeded tier: writes are allowed, scoped to the fixture space', () => {
    const grant = buildEvalTrialGrant({ runSpaceId: FIXTURE, fixtureTier: 'seeded' });
    expect(grant.accessLevel).toBe('write');
    expect(grant.spaceId).toBe(FIXTURE);
    const write = enforceGrant(grant, 'memory.store.put', true, false, 'memory.store', 'write', []);
    expect(write).toEqual({ allowed: true });
  });

  it('privileged operations are denied in both tiers', () => {
    for (const fixtureTier of ['live', 'seeded'] as const) {
      const grant = buildEvalTrialGrant({ runSpaceId: HOME, fixtureTier });
      const priv = enforceGrant(
        grant,
        'agent.manage.create',
        true,
        true,
        'agent.manage',
        'write',
        [],
      );
      expect(priv.allowed).toBe(false);
    }
  });

  it('outlives any bounded trial so renewal (which recompiles from the space profile) never fires', () => {
    const grant = buildEvalTrialGrant({ runSpaceId: HOME, fixtureTier: 'live' });
    const remainingMs = new Date(grant.expiresAt).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan((EVAL_TRIAL_GRANT_LIFETIME_SECONDS - 60) * 1000);
  });
});
