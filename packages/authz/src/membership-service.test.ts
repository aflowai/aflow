import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMembershipService, MembershipInvariantError } from './membership-service.js';
import type { DbOrTx } from './membership-service.js';

// A no-op DB handle — tests here only exercise guards that throw before any DB call.
const noopTx = {} as DbOrTx;

describe('MembershipService — invariant guards', () => {
  const publishInvalidation = vi.fn().mockResolvedValue(undefined);
  let svc: ReturnType<typeof createMembershipService>;

  beforeEach(() => {
    publishInvalidation.mockClear();
    svc = createMembershipService({ publishInvalidation });
  });

  // --------------------------------------------------------------------------
  // changeTenantRole
  // --------------------------------------------------------------------------

  describe('changeTenantRole', () => {
    it('rejects self role change', async () => {
      await expect(
        svc.changeTenantRole(noopTx, {
          tenantId: 't1',
          userId: 'u1',
          newRole: 'member',
          actorId: 'u1',
          actorRole: 'owner',
        }),
      ).rejects.toThrow(MembershipInvariantError);

      await expect(
        svc.changeTenantRole(noopTx, {
          tenantId: 't1',
          userId: 'u1',
          newRole: 'member',
          actorId: 'u1',
          actorRole: 'owner',
        }),
      ).rejects.toThrow('Cannot change your own role');
    });

    it('rejects promotion to owner (must use transfer)', async () => {
      await expect(
        svc.changeTenantRole(noopTx, {
          tenantId: 't1',
          userId: 'u2',
          newRole: 'owner',
          actorId: 'u1',
          actorRole: 'owner',
        }),
      ).rejects.toThrow('Cannot promote to owner');
    });

    it('error has correct code and httpStatus', async () => {
      try {
        await svc.changeTenantRole(noopTx, {
          tenantId: 't1',
          userId: 'u1',
          newRole: 'member',
          actorId: 'u1',
          actorRole: 'owner',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipInvariantError);
        const e = err as MembershipInvariantError;
        expect(e.code).toBe('SELF_ROLE_CHANGE');
        expect(e.httpStatus).toBe(403);
      }
    });
  });

  // --------------------------------------------------------------------------
  // transferOwnership
  // --------------------------------------------------------------------------

  describe('transferOwnership', () => {
    it('rejects self-transfer', async () => {
      await expect(
        svc.transferOwnership(noopTx, {
          tenantId: 't1',
          currentOwnerId: 'u1',
          targetUserId: 'u1',
        }),
      ).rejects.toThrow('Cannot transfer ownership to yourself');
    });

    it('error has correct code', async () => {
      try {
        await svc.transferOwnership(noopTx, {
          tenantId: 't1',
          currentOwnerId: 'u1',
          targetUserId: 'u1',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipInvariantError);
        expect((err as MembershipInvariantError).code).toBe('SELF_TRANSFER');
      }
    });
  });

  // --------------------------------------------------------------------------
  // removeTenantMember
  // --------------------------------------------------------------------------

  describe('removeTenantMember', () => {
    it('rejects self-removal', async () => {
      await expect(
        svc.removeTenantMember(noopTx, {
          tenantId: 't1',
          userId: 'u1',
          actorId: 'u1',
          actorRole: 'owner',
        }),
      ).rejects.toThrow('Cannot remove yourself');
    });

    it('error has correct code and httpStatus', async () => {
      try {
        await svc.removeTenantMember(noopTx, {
          tenantId: 't1',
          userId: 'u1',
          actorId: 'u1',
          actorRole: 'owner',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MembershipInvariantError);
        const e = err as MembershipInvariantError;
        expect(e.code).toBe('SELF_REMOVAL');
        expect(e.httpStatus).toBe(403);
      }
    });
  });

  // --------------------------------------------------------------------------
  // PostCommit pattern (uses addTenantMember with empty store via noopTx)
  // --------------------------------------------------------------------------

  describe('postCommit pattern', () => {
    it('addTenantMember returns a callable postCommit that publishes invalidation', async () => {
      // addTenantMember with a mock that returns empty for the duplicate check
      // and accepts the insert. Minimal mock for this specific path.
      const mockTx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbOrTx;

      const postCommit = await svc.addTenantMember(mockTx, {
        tenantId: 't1',
        userId: 'u1',
        role: 'member',
      });

      expect(typeof postCommit).toBe('function');
      expect(publishInvalidation).not.toHaveBeenCalled();

      await postCommit();
      expect(publishInvalidation).toHaveBeenCalledWith('u1', 't1');
    });
  });

  // --------------------------------------------------------------------------
  // Space owner invariant
  // --------------------------------------------------------------------------

  describe('space owner invariant', () => {
    it("rejects demoting the owner's membership below admin", async () => {
      await expect(
        svc.changeSpaceRole(noopTx, {
          tenantId: 't1',
          spaceId: 's1',
          userId: 'owner-1',
          newRole: 'editor',
          spaceOwnerId: 'owner-1',
        }),
      ).rejects.toThrow('cannot drop below admin');

      await expect(
        svc.changeSpaceRole(noopTx, {
          tenantId: 't1',
          spaceId: 's1',
          userId: 'owner-1',
          newRole: 'viewer',
          spaceOwnerId: 'owner-1',
        }),
      ).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_PROTECTED', httpStatus: 403 });
    });

    it("rejects removing the owner's membership", async () => {
      await expect(
        svc.removeSpaceMember(noopTx, {
          tenantId: 't1',
          spaceId: 's1',
          userId: 'owner-1',
          spaceOwnerId: 'owner-1',
        }),
      ).rejects.toMatchObject({ code: 'OWNER_MEMBERSHIP_PROTECTED', httpStatus: 403 });
    });
  });

  // --------------------------------------------------------------------------
  // MembershipInvariantError
  // --------------------------------------------------------------------------

  describe('MembershipInvariantError', () => {
    it('has correct defaults', () => {
      const err = new MembershipInvariantError('TEST', 'test message');
      expect(err.name).toBe('MembershipInvariantError');
      expect(err.code).toBe('TEST');
      expect(err.message).toBe('test message');
      expect(err.httpStatus).toBe(409);
    });

    it('accepts custom httpStatus', () => {
      const err = new MembershipInvariantError('TEST', 'forbidden', 403);
      expect(err.httpStatus).toBe(403);
    });
  });
});
