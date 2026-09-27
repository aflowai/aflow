import { z } from 'zod';

// ---------------------------------------------------------------------------
// oauth_clients CRUD contracts (Plan 185 §10, Dimension B)
// ---------------------------------------------------------------------------
//
// A registered OAuth application — the tenant- or space-provided app whose
// client_id / client_secret drive the authorization + token-exchange requests.
// The platform-default CIMD client is NOT modeled here (it is the
// `/.well-known/cimd` doc); rows exist only for `clientScope ∈ {tenant, space}`.
//
// The `client_secret` is WRITE-ONLY — accepted on create / rotate-secret, never
// returned in any response. Responses carry metadata only, with `hasSecret`
// standing in for the secret's presence.

/** Client (app) ownership scope a row can carry. `platform` is the implicit CIMD client, never a row. */
export const OAuthClientRowScopeSchema = z.enum(['tenant', 'space']);
export type OAuthClientRowScope = z.infer<typeof OAuthClientRowScopeSchema>;

// ── Metadata (response shape — secret NEVER included) ──────────────────────

export const OAuthClientMetaSchema = z.object({
  id: z.string().uuid(),
  scope: OAuthClientRowScopeSchema,
  scopeId: z.string().uuid(),
  issuerKey: z.string().min(1).max(64),
  clientId: z.string().min(1),
  label: z.string().min(1).max(128),
  /** True when an encrypted client secret is stored. The secret itself is never returned. */
  hasSecret: z.boolean(),
  authorizationServer: z.string().url().nullable(),
  defaultScopes: z.array(z.string()),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OAuthClientMeta = z.infer<typeof OAuthClientMetaSchema>;

// ── Create ─────────────────────────────────────────────────────────────────

export const OAuthClientCreateInputSchema = z.object({
  scope: OAuthClientRowScopeSchema,
  /** Tenant id or space id matching `scope`. */
  scopeId: z.string().uuid(),
  issuerKey: z.string().min(1).max(64),
  clientId: z.string().min(1).max(512),
  /** WRITE-ONLY. Omit for a public client. Never echoed back. */
  clientSecret: z.string().min(1).max(2048).optional(),
  authorizationServer: z.string().url().optional(),
  defaultScopes: z.array(z.string().max(256)).max(64).optional(),
  label: z.string().min(1).max(128),
});
export type OAuthClientCreateInput = z.infer<typeof OAuthClientCreateInputSchema>;

export const OAuthClientCreateResponseSchema = z.object({
  client: OAuthClientMetaSchema,
});
export type OAuthClientCreateResponse = z.infer<typeof OAuthClientCreateResponseSchema>;

// ── List ─────────────────────────────────────────────────────────────────

export const OAuthClientListResponseSchema = z.object({
  clients: z.array(OAuthClientMetaSchema),
});
export type OAuthClientListResponse = z.infer<typeof OAuthClientListResponseSchema>;

// ── Get ─────────────────────────────────────────────────────────────────

export const OAuthClientGetResponseSchema = z.object({
  client: OAuthClientMetaSchema,
});
export type OAuthClientGetResponse = z.infer<typeof OAuthClientGetResponseSchema>;

// ── Rotate secret ──────────────────────────────────────────────────────────

export const OAuthClientRotateSecretInputSchema = z.object({
  /** WRITE-ONLY new secret. Replaces the stored encrypted secret. Never echoed back. */
  clientSecret: z.string().min(1).max(2048),
});
export type OAuthClientRotateSecretInput = z.infer<typeof OAuthClientRotateSecretInputSchema>;

export const OAuthClientRotateSecretResponseSchema = z.object({
  client: OAuthClientMetaSchema,
});
export type OAuthClientRotateSecretResponse = z.infer<typeof OAuthClientRotateSecretResponseSchema>;

// ── Delete ─────────────────────────────────────────────────────────────────

export const OAuthClientDeleteResponseSchema = z.object({
  id: z.string().uuid(),
  deleted: z.literal(true),
});
export type OAuthClientDeleteResponse = z.infer<typeof OAuthClientDeleteResponseSchema>;
