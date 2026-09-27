/**
 * Control moves between people. Authority does not.
 *
 * A shared run can be advanced by anyone in the space, so if the run picked up
 * the authority of whoever last acted, work begun under one person's access
 * would silently continue under another's — in both directions: personal
 * credentials borrowed, or capabilities widened by an admin dropping in.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';

const mockResolveSpaceRole = vi.fn();
vi.mock('@aflow/authz', () => ({
  resolveSpaceRole: (...args: unknown[]) => mockResolveSpaceRole(...args),
}));

const { buildAuthorityFromActor, readEstablishedAuthority, revalidateAuthority } =
  await import('../executionAuthority.js');

const SPACE = '00000000-0000-4000-8000-000000000010';
const KARIM = '00000000-0000-4000-8000-00000000c0a2';
const SARA = '00000000-0000-4000-8000-00000000e5a1';
const TENANT = '00000000-0000-4000-8000-000000000001';

function actor(userId: string, spaceRole: string): ActorContext {
  return {
    userId,
    kind: 'human',
    authMethod: 'session',
    tenantId: TENANT,
    tenantRole: 'member',
    spaceId: SPACE,
    spaceRole,
    capturedAt: new Date().toISOString(),
  };
}

function stateWith(authority?: unknown): SessionHotState {
  return {
    ...(authority ? { executionAuthorityJson: JSON.stringify(authority) } : {}),
  } as SessionHotState;
}

describe('establishing authority', () => {
  it('records the principal, roles, and why it was established', () => {
    const authority = buildAuthorityFromActor(actor(KARIM, 'editor'), {
      spaceId: SPACE,
      establishedReason: 'start',
    });

    expect(authority).toMatchObject({
      version: 1,
      principalUserId: KARIM,
      principalKind: 'human',
      spaceId: SPACE,
      spaceRole: 'editor',
      establishedReason: 'start',
    });
  });

  it('never assumes personal credentials — those need their owner’s explicit act', () => {
    const authority = buildAuthorityFromActor(actor(KARIM, 'admin'), {
      spaceId: SPACE,
      establishedReason: 'start',
    });

    expect(authority.personalCredentialsGranted).toBe(false);
  });
});

describe('reading it back', () => {
  it('survives the round trip through hot state', () => {
    const authority = buildAuthorityFromActor(actor(KARIM, 'editor'), {
      spaceId: SPACE,
      establishedReason: 'schedule',
    });

    expect(readEstablishedAuthority(stateWith(authority))).toEqual(authority);
  });

  it('reports nothing rather than guessing when the record is absent or unreadable', () => {
    expect(readEstablishedAuthority(stateWith())).toBeUndefined();
    expect(
      readEstablishedAuthority({ executionAuthorityJson: 'not json' } as SessionHotState),
    ).toBeUndefined();
    expect(
      readEstablishedAuthority({
        executionAuthorityJson: JSON.stringify({ version: 99 }),
      } as SessionHotState),
    ).toBeUndefined();
  });
});

describe('revalidating it', () => {
  const authority = buildAuthorityFromActor(actor(KARIM, 'editor'), {
    spaceId: SPACE,
    establishedReason: 'start',
  });

  it('holds while the principal still has the access it was established with', async () => {
    mockResolveSpaceRole.mockResolvedValue('editor');
    expect(await revalidateAuthority({} as never, {} as never, TENANT, authority)).toEqual({
      ok: true,
    });
  });

  it('holds when the principal has since been given more', async () => {
    mockResolveSpaceRole.mockResolvedValue('admin');
    expect(await revalidateAuthority({} as never, {} as never, TENANT, authority)).toEqual({
      ok: true,
    });
  });

  it('fails once the principal has left the space', async () => {
    mockResolveSpaceRole.mockResolvedValue(null);
    const check = await revalidateAuthority({} as never, {} as never, TENANT, authority);
    expect(check).toMatchObject({ ok: false, reason: 'principal_left_space' });
  });

  it('fails once the principal’s role has been narrowed', async () => {
    mockResolveSpaceRole.mockResolvedValue('viewer');
    const check = await revalidateAuthority({} as never, {} as never, TENANT, authority);
    expect(check).toMatchObject({ ok: false, reason: 'principal_role_reduced' });
  });

  it('checks the principal the run was established for, not whoever is acting now', async () => {
    mockResolveSpaceRole.mockClear();
    mockResolveSpaceRole.mockResolvedValue('editor');

    await revalidateAuthority({} as never, {} as never, TENANT, authority);

    const [, , params] = mockResolveSpaceRole.mock.calls[0] as [
      unknown,
      unknown,
      { userId: string },
    ];
    expect(params.userId).toBe(KARIM);
    expect(params.userId).not.toBe(SARA);
  });
});
