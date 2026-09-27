/**
 * RequestedInput schemas — formal schema for input requested by the orchestrator
 * when a step cannot proceed due to missing state variables.
 *
 * Stored as a payload (kind: 'requested_input') and referenced by
 * SessionHotState.requestedInputRef. The UI loads this to render input forms.
 */
import { z } from 'zod';
import {
  OAuthConsentIntegrationKindSchema,
  OAuthConsentOwnerScopeSchema,
  OAuthConsentReasonSchema,
} from './sessionBlockedOn.js';

/**
 * A single missing or invalid variable in a requested input payload.
 */
export const MissingVariableSchema = z.object({
  variableId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  typeSchema: z.record(z.unknown()).optional(),
  semanticType: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  /** Structured response options for the UI (single/multi-select). */
  responseOptions: z
    .object({
      type: z.enum(['single', 'multi']).default('single'),
      options: z
        .array(z.object({ value: z.string(), label: z.string().optional() }))
        .min(2)
        .max(50),
    })
    .optional(),
});
export type MissingVariable = z.infer<typeof MissingVariableSchema>;

/**
 * A variable that was provided but failed type validation.
 */
export const InvalidVariableSchema = z.object({
  variableId: z.string(),
  message: z.string(),
  expectedSchema: z.record(z.unknown()).optional(),
  receivedPreview: z.string().optional(),
});
export type InvalidVariable = z.infer<typeof InvalidVariableSchema>;

/**
 * Payload stored when the orchestrator pauses a run because required state
 * variables are missing or invalid. The UI reads this to render input forms.
 */
export const RequestedInputPayloadSchema = z.object({
  reason: z.enum(['input_required', 'validation_error']),
  stepId: z.string(),
  missingVariables: z.array(MissingVariableSchema).default([]),
  invalidVariables: z.array(InvalidVariableSchema).default([]),
  /** Human-readable prompt for the user */
  prompt: z.string().optional(),
});
export type RequestedInputPayload = z.infer<typeof RequestedInputPayloadSchema>;

/**
 * Request payload stored when an OAuth tool/API call pauses because the pinned
 * owner has no usable token. `kind: 'oauth_consent'` is the discriminator the
 * paused-step surfaces filter on; the resume contract is consent completion
 * (the OAuth callback), not a typed-variable submission.
 */
export const OAuthConsentRequestPayloadSchema = z.object({
  kind: z.literal('oauth_consent'),
  integrationKind: OAuthConsentIntegrationKindSchema,
  /** Logical provider key — serverId (MCP) | apiId (API), NOT the binding. */
  resourceKey: z.string(),
  bindingId: z.string(),
  ownerScope: OAuthConsentOwnerScopeSchema,
  /** Where consent can be initiated for this binding (server-relative path). */
  consentUrlHint: z.string().optional(),
  /** Fully-resolved authorization URL when the executor already resolved one. */
  authorizationUrlHint: z.string().optional(),
  /** `never_connected` = no stored token; `expired` = token unusable, no refresh. */
  reason: OAuthConsentReasonSchema,
});
export type OAuthConsentRequestPayload = z.infer<typeof OAuthConsentRequestPayloadSchema>;

/**
 * Request payload stored when a write call pauses for human approval because
 * its endpoint's risk tier is gated (Plan 253). `kind: 'write_approval'` is the
 * discriminator the paused-step surfaces filter on. Carries only what the
 * approver needs to decide — host (not the full URL), a redacted body preview,
 * and the tier — plus a `requestHash` that binds an approval to this exact call.
 */
export const WriteApprovalRequestPayloadSchema = z.object({
  kind: z.literal('write_approval'),
  apiId: z.string(),
  endpointId: z.string(),
  endpointName: z.string().optional(),
  /** One-line human summary of what the call does, for the approval card. */
  operationLabel: z.string().max(500).optional(),
  method: z.string(),
  /** Host only — the resolved URL's path/query may carry secrets. */
  urlHost: z.string(),
  writeRiskTier: z.enum(['read', 'low', 'medium', 'high']),
  /** Redacted, truncated preview of the request body for the approver. */
  bodyPreview: z.string().max(4000).optional(),
  /** Who initiated the call — createdBy / credential owner. */
  initiatedBy: z.string().optional(),
  /** Binds an approval to this exact resolved call (method + url + canonical body). */
  requestHash: z.string(),
});
export type WriteApprovalRequestPayload = z.infer<typeof WriteApprovalRequestPayloadSchema>;

/**
 * The approver's decision, threaded into the paused step's resume input. The
 * executor re-dispatches, recomputes the `requestHash` of the resolved call,
 * and proceeds only when an `approved` grant carries the SAME hash — a changed
 * call (different method/url/body) re-gates rather than riding a stale approval.
 */
export const WriteApprovalGrantSchema = z.object({
  requestHash: z.string(),
  decision: z.enum(['approved', 'denied']),
  approvedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  /** The operator's free-text reason, surfaced to the agent on denial. */
  reason: z.string().max(2000).optional(),
});
export type WriteApprovalGrant = z.infer<typeof WriteApprovalGrantSchema>;
