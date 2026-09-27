import { z } from 'zod';
import { OAuthConsentIntegrationKindSchema } from '../runtime/sessionBlockedOn.js';

// ---------------------------------------------------------------------------
// Per-user "Connected accounts" response (Plan 185 §11)
// ---------------------------------------------------------------------------
//
// One connection = a logical resource the user has an `oauth_tokens` row for
// (owner_scope='user', owner_id=userId). Connect-once (§3.3) means a single row
// per (integration_kind, resource_key) regardless of how many bindings/spaces
// replay it. Surfaced under the `/account` "Connected accounts" tab.

export const OAuthConnectionStatusSchema = z.enum(['connected', 'expired']);
export type OAuthConnectionStatus = z.infer<typeof OAuthConnectionStatusSchema>;

export const OAuthConnectionSchema = z.object({
  integrationKind: OAuthConsentIntegrationKindSchema,
  /** Logical provider key — serverId (MCP) | apiId (API). The connect-once identity. */
  resourceKey: z.string(),
  /** Human-readable provider label (from the curated issuer registry or the definition). */
  displayName: z.string(),
  /** Granted scopes on the stored token. */
  scopes: z.array(z.string()),
  /** Token expiry (ISO 8601). */
  expiresAt: z.string(),
  status: OAuthConnectionStatusSchema,
});
export type OAuthConnection = z.infer<typeof OAuthConnectionSchema>;

export const OAuthConnectionListResponseSchema = z.object({
  connections: z.array(OAuthConnectionSchema),
});
export type OAuthConnectionListResponse = z.infer<typeof OAuthConnectionListResponseSchema>;
