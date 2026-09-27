/**
 * Identity schemas — users, memberships, actor context, and audit events.
 *
 * These schemas model the authentication, authorization, and accountability
 * domain for the Phoenix platform.
 *
 * NOTE: `UserId` / `UserIdSchema` live in `runtime/ids.ts` (the canonical
 * branded-ID module) to avoid export collisions in the top-level barrel.
 */
export {
  UserKindSchema,
  type UserKind,
  UserStatusSchema,
  type UserStatus,
  TenantRoleSchema,
  type TenantRole,
  SpaceRoleSchema,
  type SpaceRole,
  MembershipStatusSchema,
  type MembershipStatus,
  UserProfileSchema,
  type UserProfile,
  TenantMembershipSchema,
  type TenantMembership,
  SpaceMembershipSchema,
  type SpaceMembership,
  SpaceSchema,
  type Space,
  InviteSchema,
  type Invite,
  ApiKeyMetadataSchema,
  type ApiKeyMetadata,
} from './user.js';

export {
  ActorKindSchema,
  type ActorKind,
  AuthMethodSchema,
  type AuthMethod,
  ActorContextSchema,
  type ActorContext,
  AuditEventCategorySchema,
  type AuditEventCategory,
  AuditEventOutcomeSchema,
  type AuditEventOutcome,
  AuditEventSchema,
  type AuditEvent,
} from './actorContext.js';

export {
  USE_CASE_MAX_LENGTH,
  INVITE_REQUEST_REFERRALS,
  InviteRequestReferralSchema,
  type InviteRequestReferral,
  InviteRequestSubmissionSchema,
  type InviteRequestSubmission,
  canonicalizeEmail,
  isUndeliverableAddress,
  linkLooksPublic,
  normalizeLinkInput,
} from './inviteRequest.js';

export {
  CURRENT_TERMS_VERSION,
  TermsVersionSchema,
  TermsAcceptanceRequestSchema,
  type TermsAcceptanceRequest,
  TermsAcceptanceStatusSchema,
  type TermsAcceptanceStatus,
} from './termsAcceptance.js';
