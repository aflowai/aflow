import { describe, it, expect } from 'vitest';
import { enforceGrant, type RunAccessGrant } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import { resolveGrantRenewalSource } from './grantRenewal.js';

const SPACE = '9e842431-cb9a-477d-b090-e33e601a4c83';
const USER = '1eab6e64-861a-4b99-b396-74f35b111dbb';
const NOW = new Date('2026-08-05T13:48:50.000Z');

function grantExpiring(at: string): RunAccessGrant {
  return {
    spaceId: SPACE,
    accessLevel: 'write',
    grantedToUserId: USER,
    tenantRole: 'admin',
    spaceRole: 'editor',
    grantedAt: '2026-08-05T13:38:04.000Z',
    expiresAt: at,
    capabilities: {
      allowedCapabilities: [],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    resourceScopes: [],
  };
}

function runStateWithAuthority(overrides: Record<string, unknown> = {}): SessionHotState {
  return {
    executionAuthorityJson: JSON.stringify({
      version: 1,
      principalUserId: USER,
      principalKind: 'system',
      spaceId: SPACE,
      spaceRole: 'admin',
      tenantRole: 'admin',
      establishedAt: '2026-08-05T13:35:14.994Z',
      establishedReason: 'schedule',
      personalCredentialsGranted: false,
      ...overrides,
    }),
  } as unknown as SessionHotState;
}

describe('resolveGrantRenewalSource', () => {
  it('leaves a still-valid grant alone', () => {
    const grant = grantExpiring('2026-08-05T13:58:00.000Z');
    expect(resolveGrantRenewalSource(grant, runStateWithAuthority(), NOW)).toBeNull();
  });

  it('renews an aged-out grant from its own metadata', () => {
    const grant = grantExpiring('2026-08-05T13:48:04.000Z');
    expect(resolveGrantRenewalSource(grant, runStateWithAuthority(), NOW)).toEqual({
      spaceId: SPACE,
      spaceRole: 'editor',
      userId: USER,
      tenantRole: 'admin',
    });
  });

  // The outage: a grant that is absent rather than expired. The old guard was
  // `grant && expired`, so absence skipped renewal entirely and fell through to
  // a pause that carried no resume contract — unrecoverable by resume or retry.
  it('renews an absent grant from the run established authority', () => {
    expect(resolveGrantRenewalSource(null, runStateWithAuthority(), NOW)).toEqual({
      spaceId: SPACE,
      spaceRole: 'admin',
      userId: USER,
      tenantRole: 'admin',
    });
  });

  it('prefers the grant own principal over the authority when both exist', () => {
    // The grant was compiled for a narrower space role than the authority
    // records; renewing must not silently promote it.
    const grant = grantExpiring('2026-08-05T13:48:04.000Z');
    const source = resolveGrantRenewalSource(grant, runStateWithAuthority(), NOW);
    expect(source?.spaceRole).toBe('editor');
  });

  it('offers nothing when the grant is absent and no authority was established', () => {
    expect(resolveGrantRenewalSource(null, {} as SessionHotState, NOW)).toBeNull();
    expect(resolveGrantRenewalSource(null, null, NOW)).toBeNull();
  });

  it('offers nothing when the stored authority is unparseable', () => {
    const corrupt = { executionAuthorityJson: '{not json' } as unknown as SessionHotState;
    expect(resolveGrantRenewalSource(null, corrupt, NOW)).toBeNull();
  });
});

describe('grant enforcement never parks a run', () => {
  const anyGrant: RunAccessGrant = grantExpiring('2026-08-05T13:58:00.000Z');

  // A Runner has no human watching and no resume affordance. Every refusal must
  // stay on a path it can act on — a tool error it answers with signal_blocked,
  // or a failed turn that fails the run — never a pause with no resume contract.
  it.each([
    ['no grant at all', null],
    ['an expired grant', { ...anyGrant, expiresAt: '2026-08-05T13:00:00.000Z' }],
    ['a read-only grant on a mutating op', { ...anyGrant, accessLevel: 'read' as const }],
  ])('refuses %s without a pause instruction', (_label, grant) => {
    const result = enforceGrant(
      grant as RunAccessGrant | null,
      'memory.store.put',
      true,
      false,
      'memory.store',
      'write',
      [],
    );
    expect(result.allowed).toBe(false);
    // The shape carries no way to ask for a pause — the field is gone, so no
    // caller can reintroduce parking without changing this contract.
    expect(result).not.toHaveProperty('pauseRun');
    if (!result.allowed) expect(result.reason).toBeTruthy();
  });
});
