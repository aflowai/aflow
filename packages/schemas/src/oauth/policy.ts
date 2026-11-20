import { z } from 'zod';
import { OAuthConsentOwnerScopeSchema } from '../runtime/sessionBlockedOn.js';
import { OAuthClientScopeSchema, type OAuthClientScope } from '../models/apiDefinition.js';
import type { EditionId } from '../edition/descriptor.js';

// ---------------------------------------------------------------------------
// Per-tenant OAuth default policy (Plan 185 §4.5, D5)
// ---------------------------------------------------------------------------
//
// First-class columns on `public.tenants` (not JSONB). Sets the default
// `ownerScope` + `clientScope` for new OAuth bindings and whether end-users may
// self-connect their own accounts. Read/update is tenant-admin only.

export const TenantOAuthPolicySchema = z.object({
  /** Default identity ownership scope (whose tokens) for new OAuth bindings. */
  defaultOwnerScope: OAuthConsentOwnerScopeSchema,
  /** Default client (app) ownership scope (whose OAuth app) for new OAuth bindings. */
  defaultClientScope: OAuthClientScopeSchema,
  /** Whether end-users may self-connect their own OAuth accounts (`user` ownerScope). */
  allowUserSelfConnect: z.boolean(),
});
export type TenantOAuthPolicy = z.infer<typeof TenantOAuthPolicySchema>;

export const TenantOAuthPolicyResponseSchema = z.object({
  policy: TenantOAuthPolicySchema,
});
export type TenantOAuthPolicyResponse = z.infer<typeof TenantOAuthPolicyResponseSchema>;

/** All fields optional — a partial update patches only the supplied keys. */
export const TenantOAuthPolicyUpdateInputSchema = z
  .object({
    defaultOwnerScope: OAuthConsentOwnerScopeSchema,
    defaultClientScope: OAuthClientScopeSchema,
    allowUserSelfConnect: z.boolean(),
  })
  .partial();
export type TenantOAuthPolicyUpdateInput = z.infer<typeof TenantOAuthPolicyUpdateInputSchema>;

/**
 * The client scopes a tenant's default OAuth app may name in an edition.
 *
 * The local edition registers OAuth apps on one page only, instance Settings →
 * OAuth Apps, which writes tenant-scoped clients. A `space` default names a
 * registry that edition shows no page for, and `platform` is the CIMD client,
 * which no API issuer accepts. So `tenant` is the one default a connector
 * install can satisfy there.
 */
export function oauthDefaultClientScopeChoices(edition: EditionId): readonly OAuthClientScope[] {
  return edition === 'community-local' ? ['tenant'] : ['platform', 'tenant', 'space'];
}

/** The default OAuth app a tenant starts with in an edition. */
export function oauthDefaultClientScopeForEdition(edition: EditionId): OAuthClientScope {
  return edition === 'community-local' ? 'tenant' : 'space';
}

/**
 * The page where an operator registers an OAuth app at `clientScope`, named as
 * the edition labels it. `null` where the edition shows no such page, which is
 * the space scope in the local edition.
 */
export function oauthAppsPageForScope(
  edition: EditionId,
  clientScope: Exclude<OAuthClientScope, 'platform'>,
): string | null {
  if (edition === 'community-local') {
    return clientScope === 'tenant'
      ? 'Settings → OAuth Apps (open Tenant Admin in the sidebar)'
      : null;
  }
  return clientScope === 'tenant'
    ? 'Tenant Admin → OAuth Apps'
    : 'the space’s Settings → OAuth Apps';
}
