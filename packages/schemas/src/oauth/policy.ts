import { z } from 'zod';
import { OAuthConsentOwnerScopeSchema } from '../runtime/sessionBlockedOn.js';
import { OAuthClientScopeSchema } from '../models/apiDefinition.js';

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
