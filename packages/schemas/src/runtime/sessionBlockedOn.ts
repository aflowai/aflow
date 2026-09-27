import { z } from 'zod';

export const OAuthConsentIntegrationKindSchema = z.enum(['mcp', 'api']);
export type OAuthConsentIntegrationKind = z.infer<typeof OAuthConsentIntegrationKindSchema>;

// Who owns the connected account: each member their own, or one shared
// connection for the space. A tenant-wide shared account is deliberately not a
// scope — it was never a real use case and a space surface must not create
// tenant-wide state.
export const OAuthConsentOwnerScopeSchema = z.enum(['user', 'space']);
export type OAuthConsentOwnerScope = z.infer<typeof OAuthConsentOwnerScopeSchema>;

export const OAuthConsentReasonSchema = z.enum(['never_connected', 'expired']);
export type OAuthConsentReason = z.infer<typeof OAuthConsentReasonSchema>;

export const SessionBlockedOnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workflow_run'),
    /** The workflow run this session is parked waiting on. */
    runId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('child_session'),
    sessionIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('user_input'),
    /** The paused step awaiting operator input. */
    stepExecutionId: z.string(),
  }),
  z.object({
    kind: z.literal('needs_oauth_consent'),
    integrationKind: OAuthConsentIntegrationKindSchema,
    /** Logical provider key — serverId (MCP) | apiId (API), NOT the binding. */
    resourceKey: z.string(),
    bindingId: z.string(),
    ownerScope: OAuthConsentOwnerScopeSchema,
    /** Where consent can be initiated for this binding (server-relative path). */
    consentUrlHint: z.string().optional(),
    /** `never_connected` = no stored token; `expired` = token unusable, no refresh. */
    reason: OAuthConsentReasonSchema,
  }),
  z.object({
    kind: z.literal('needs_write_approval'),
    /** The paused step awaiting a human approval of a write call. */
    stepExecutionId: z.string(),
    apiId: z.string(),
    endpointId: z.string(),
    method: z.string(),
    /** Host only — the resolved URL's path/query may carry secrets. */
    urlHost: z.string(),
    writeRiskTier: z.enum(['read', 'low', 'medium', 'high']),
    /** Binds the pending decision to the exact resolved call. */
    requestHash: z.string(),
  }),
]);
export type SessionBlockedOn = z.infer<typeof SessionBlockedOnSchema>;
