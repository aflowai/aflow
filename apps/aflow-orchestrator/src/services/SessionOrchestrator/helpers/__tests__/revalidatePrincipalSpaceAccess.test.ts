import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveSpaceRole = vi.fn();
vi.mock('@aflow/authz', () => ({
  resolveSpaceRole: (...args: unknown[]) => mockResolveSpaceRole(...args),
}));

import { revalidatePrincipalSpaceAccess } from '../executionAuthority.js';

const ARGS = {
  tenantId: 'a0000000-0000-0000-0000-000000000001',
  userId: '1eab6e64-861a-4b99-b396-74f35b111dbb',
  spaceId: 'e5cbe212-8c05-4b74-b4c6-4433b96902ea',
  establishedSpaceRole: 'editor',
};

beforeEach(() => vi.clearAllMocks());

describe('revalidatePrincipalSpaceAccess', () => {
  it('holds while the principal keeps at least the established role', async () => {
    mockResolveSpaceRole.mockResolvedValueOnce('admin');
    expect(await revalidatePrincipalSpaceAccess({} as never, {} as never, ARGS)).toEqual({
      ok: true,
    });
  });

  it('refuses when the principal left the space — a renewal must not resurrect their access', async () => {
    mockResolveSpaceRole.mockResolvedValueOnce(null);
    const check = await revalidatePrincipalSpaceAccess({} as never, {} as never, ARGS);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('principal_left_space');
  });

  it('refuses when the current role is narrower than the one the run was established with', async () => {
    mockResolveSpaceRole.mockResolvedValueOnce('viewer');
    const check = await revalidatePrincipalSpaceAccess({} as never, {} as never, ARGS);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('principal_role_reduced');
  });
});
