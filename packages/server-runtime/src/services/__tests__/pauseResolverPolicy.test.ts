/**
 * One targeting rule, enforced on every path that can answer a pause.
 *
 * A pause naming its approvers can be answered from the Action Center item or
 * from the plain session-resume endpoint the chat UI uses. Reading the
 * allowlist in only one of those places is enforcement the other path silently
 * skips, so the derivation and the check live here and both callers use them.
 */
import { describe, expect, it } from 'vitest';
import { deriveResolverPolicy, isResolverAllowed } from '@aflow/schemas';

describe('deriveResolverPolicy', () => {
  it('reads an approvers list into an allowlist', () => {
    expect(deriveResolverPolicy({ approvers: ['sara', 'admin'] })).toEqual({
      minResolvers: 1,
      requireAll: false,
      candidateResolvers: ['sara', 'admin'],
    });
  });

  it('accepts candidateResolvers as the equivalent key', () => {
    expect(deriveResolverPolicy({ candidateResolvers: ['sara'] })?.candidateResolvers).toEqual([
      'sara',
    ]);
  });

  it('leaves an untargeted pause unrestricted', () => {
    expect(deriveResolverPolicy({ kind: 'approval' })).toBeUndefined();
    expect(deriveResolverPolicy(null)).toBeUndefined();
    expect(deriveResolverPolicy(undefined)).toBeUndefined();
  });

  it('treats an unusable list as untargeted rather than locking everyone out', () => {
    expect(deriveResolverPolicy({ approvers: [] })).toBeUndefined();
    expect(deriveResolverPolicy({ approvers: ['   '] })).toBeUndefined();
    expect(deriveResolverPolicy({ approvers: 'sara' })).toBeUndefined();
    expect(deriveResolverPolicy({ approvers: [42] })).toBeUndefined();
  });

  it('trims and bounds what it accepts', () => {
    expect(deriveResolverPolicy({ approvers: ['  sara  '] })?.candidateResolvers).toEqual(['sara']);
    expect(deriveResolverPolicy({ approvers: ['x'.repeat(129)] })).toBeUndefined();
    expect(
      deriveResolverPolicy({ approvers: Array.from({ length: 80 }, (_, i) => `u${String(i)}`) })
        ?.candidateResolvers,
    ).toHaveLength(50);
  });
});

describe('isResolverAllowed', () => {
  const policy = { minResolvers: 1, requireAll: false, candidateResolvers: ['sara', 'admin'] };

  it('admits the named user', () => {
    expect(isResolverAllowed(policy, { actorUserId: 'sara', actorSpaceRole: 'editor' })).toBe(true);
  });

  it('admits a named role', () => {
    expect(isResolverAllowed(policy, { actorUserId: 'karim', actorSpaceRole: 'admin' })).toBe(true);
  });

  it('turns away an editor who was not named', () => {
    expect(isResolverAllowed(policy, { actorUserId: 'karim', actorSpaceRole: 'editor' })).toBe(
      false,
    );
  });

  it('lets anyone through when the pause named no one', () => {
    expect(isResolverAllowed(undefined, { actorUserId: 'karim', actorSpaceRole: 'editor' })).toBe(
      true,
    );
    expect(
      isResolverAllowed(
        { minResolvers: 1, requireAll: false, candidateResolvers: [] },
        { actorUserId: 'karim', actorSpaceRole: 'editor' },
      ),
    ).toBe(true);
  });
});

describe('workflow-authored multi-approval', () => {
  // Several people's sign-off is expressed as sequential approval steps, each
  // naming its own approver — there is no vote-counting machinery to test,
  // and that absence is the design. What must hold is that each step enforces
  // its own name: the person who may answer step one is not thereby allowed
  // to answer step two.
  const SARA = '00000000-0000-4000-8000-00000000e5a1';
  const KARIM = '00000000-0000-4000-8000-00000000c0a2';

  it('each approval step enforces its own approver', () => {
    const stepOne = deriveResolverPolicy({ approvers: [SARA] });
    const stepTwo = deriveResolverPolicy({ approvers: [KARIM] });

    expect(isResolverAllowed(stepOne, { actorUserId: SARA, actorSpaceRole: 'editor' })).toBe(true);
    expect(isResolverAllowed(stepOne, { actorUserId: KARIM, actorSpaceRole: 'editor' })).toBe(
      false,
    );
    expect(isResolverAllowed(stepTwo, { actorUserId: KARIM, actorSpaceRole: 'editor' })).toBe(true);
    expect(isResolverAllowed(stepTwo, { actorUserId: SARA, actorSpaceRole: 'editor' })).toBe(false);
  });

  it('a role-named step admits every holder of the role, at that step only', () => {
    const stepOne = deriveResolverPolicy({ approvers: ['admin'] });
    const stepTwo = deriveResolverPolicy({ approvers: [SARA] });

    expect(isResolverAllowed(stepOne, { actorUserId: KARIM, actorSpaceRole: 'admin' })).toBe(true);
    expect(isResolverAllowed(stepTwo, { actorUserId: KARIM, actorSpaceRole: 'admin' })).toBe(false);
  });
});
