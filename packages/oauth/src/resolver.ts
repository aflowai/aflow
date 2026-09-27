/**
 * OAuth identity (token-owner) resolution — PINNED, never a fallback.
 *
 * The binding's `ownerScope` selects exactly one owner; there is no
 * `user → space` precedence walk. This is the deliberate divergence from the
 * BYOK `credential-resolver` (whose fallback resolver stays untouched):
 * falling back from an absent user token to a shared space token would
 * silently impersonate.
 */

export type OAuthOwnerScope = 'user' | 'space';

export interface OAuthOwnerContext {
  /** The calling user's id, when the run carries a user identity. */
  userId?: string;
  spaceId: string;
  tenantId: string;
}

export type OAuthOwnerNeedsConsentReason = 'no_user_identity';

export type ResolveOAuthOwnerResult =
  { ownerId: string } | { needsConsent: OAuthOwnerNeedsConsentReason };

/**
 * Resolve the pinned owner id for an OAuth token lookup. `space` always
 * resolves from the context. `user` resolves to `userId` or returns
 * `needsConsent: 'no_user_identity'` when the run carries no user identity —
 * the caller turns this into the §9.3 "connect your account" pause rather than
 * falling back to a shared owner.
 */
export function resolveOAuthOwner(
  ownerScope: OAuthOwnerScope,
  ctx: OAuthOwnerContext,
): ResolveOAuthOwnerResult {
  switch (ownerScope) {
    case 'user':
      if (!ctx.userId) return { needsConsent: 'no_user_identity' };
      return { ownerId: ctx.userId };
    case 'space':
      return { ownerId: ctx.spaceId };
  }
}
