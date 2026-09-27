/**
 * User, membership, invite, and API key schemas.
 *
 * These schemas model the identity and access control domain:
 * - **Users**: human users and service principals
 * - **Memberships**: tenant-level and space-level role assignments
 * - **Invites**: email-based tenant invitations
 * - **API Keys**: machine credential metadata (never the secret itself)
 *
 * NOTE: `UserId` / `UserIdSchema` are defined in `runtime/ids.ts` (the
 * canonical branded-ID module) and re-exported from the runtime barrel.
 * They are intentionally NOT duplicated here to avoid export collisions.
 */
import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

export const UserKindSchema = z.enum(['human', 'service_principal']);
export type UserKind = z.infer<typeof UserKindSchema>;

export const UserStatusSchema = z.enum(['invited', 'active', 'suspended', 'deactivated']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const TenantRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer', 'billing']);
export type TenantRole = z.infer<typeof TenantRoleSchema>;

export const SpaceRoleSchema = z.enum(['admin', 'editor', 'viewer']);
export type SpaceRole = z.infer<typeof SpaceRoleSchema>;

export const MembershipStatusSchema = z.enum(['pending', 'active', 'suspended', 'removed']);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

// ============================================================================
// User Profile (returned from API)
// ============================================================================

export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email().nullable(),
  avatarUrl: z.string().url().nullable(),
  kind: UserKindSchema,
  status: UserStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

// ============================================================================
// Tenant Membership (returned from API)
// ============================================================================

export const TenantMembershipSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  role: TenantRoleSchema,
  status: MembershipStatusSchema,
  joinedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type TenantMembership = z.infer<typeof TenantMembershipSchema>;

// ============================================================================
// Space Membership
// ============================================================================

export const SpaceMembershipSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  spaceId: z.string().uuid(),
  userId: z.string().uuid(),
  role: SpaceRoleSchema,
  createdAt: z.string().datetime(),
});
export type SpaceMembership = z.infer<typeof SpaceMembershipSchema>;

// ============================================================================
// Space (returned from API)
// ============================================================================

export const SpaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  /** Explicit membership rows — solo (≤1) renders as a personal space */
  memberCount: z.number().int().min(0),
  ownerId: z.string().uuid().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Space = z.infer<typeof SpaceSchema>;

// ============================================================================
// Invite
// ============================================================================

export const InviteSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  email: z.string().email(),
  role: TenantRoleSchema,
  invitedBy: z.string().uuid(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Invite = z.infer<typeof InviteSchema>;

// ============================================================================
// API Key Metadata (never includes the key itself)
// ============================================================================

export const ApiKeyMetadataSchema = z.object({
  id: z.string().uuid(),
  keyPrefix: z.string(),
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  scopes: z.array(
    z.object({
      resource: z.string(),
      action: z.string(),
      spaceId: z.string().uuid().optional(),
    }),
  ),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;
