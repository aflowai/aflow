/**
 * RequestedInput schemas — formal schema for input requested by the orchestrator
 * when a step cannot proceed due to missing state variables.
 *
 * Stored as a payload (kind: 'requested_input') and referenced by
 * SessionHotState.requestedInputRef. The UI loads this to render input forms.
 */
import { z } from 'zod';
import { BROWSER_ACTIONS } from '../operations/browser.js';
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
 * Request payload stored when a step pauses for an operator's approval before
 * it acts (Plan 253, Plan 320 D7). `kind: 'write_approval'` is the
 * discriminator the paused-step surfaces filter on, and `target` says what is
 * waiting: an API write whose endpoint's risk tier is gated, or an action in
 * the agent's browser on a profile that asks. Each carries only what the
 * approver needs to decide, plus a `requestHash` that binds an approval to
 * this exact request. Both share one grant path: the grant is minted only at
 * the authenticated resolve boundary, keyed by `(tenant, run, requestHash)`.
 */
export const ApiWriteApprovalRequestPayloadSchema = z.object({
  kind: z.literal('write_approval'),
  target: z.literal('api'),
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
export type ApiWriteApprovalRequestPayload = z.infer<typeof ApiWriteApprovalRequestPayloadSchema>;

/** Room for an excerpt in UTF-16 units, the length a string's `length` counts. */
export const BROWSER_APPROVAL_EXCERPT_MAX_UNITS = 8000;

/** Room for the path the approver is shown (`browserApprovalShownPath`), in UTF-16 units. */
export const BROWSER_APPROVAL_PATH_MAX_UNITS = 2000;

/**
 * What a browser action would enter, as the approver sees it. The value itself
 * appears only as a bounded excerpt, and never for a field that takes a
 * credential: such a field is described by its length alone.
 */
export const BrowserApprovalValueSummarySchema = z.object({
  kind: z.enum(['text', 'credential', 'options', 'key']),
  /** Characters entered, options chosen, or 1 for a key. */
  length: z.number().int().nonnegative(),
  /** What is entered, or the start of it. Absent for a credential field. */
  excerpt: z.string().max(BROWSER_APPROVAL_EXCERPT_MAX_UNITS).optional(),
  /** The excerpt is the start of the value only. */
  truncated: z.boolean(),
  /** For `type`: Enter is pressed after the text. */
  submit: z.boolean().optional(),
});
export type BrowserApprovalValueSummary = z.infer<typeof BrowserApprovalValueSummarySchema>;

/** What asked: the profile's posture, or the origin rule that names the page. */
export const BrowserApprovalAskedBySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('posture') }),
  z.object({ kind: z.literal('rule'), rule: z.string() }),
]);
export type BrowserApprovalAskedBy = z.infer<typeof BrowserApprovalAskedBySchema>;

export const BrowserWriteApprovalRequestPayloadSchema = z.object({
  kind: z.literal('write_approval'),
  target: z.literal('browser'),
  profileId: z.string(),
  /** The origin of the frame the element belongs to, read from the page as the action gate reads it. */
  pageOrigin: z.string(),
  /**
   * That frame's address as the approver is shown it beside its origin
   * (`browserApprovalShownPath`). The address itself is in the hash, never here.
   */
  shownPath: z.string().max(BROWSER_APPROVAL_PATH_MAX_UNITS),
  pageTitle: z.string().max(500),
  action: z.enum(BROWSER_ACTIONS),
  element: z.object({
    ref: z.string(),
    role: z.string(),
    name: z.string().max(500).optional(),
  }),
  value: BrowserApprovalValueSummarySchema.optional(),
  askedBy: BrowserApprovalAskedBySchema,
  /** The page as it stood when the action was asked for, password fields masked. */
  screenshotRef: z.string().optional(),
  /**
   * Until when the request stands: the agent's page is held open for the
   * answer until then, and an answer after it may find the page gone.
   */
  standsUntil: z.string().datetime(),
  /**
   * When the decision on record for this request was made, as the operator
   * was asked — an approval already spent, asked about again. Only a decision
   * made after it answers this request (`grantAnswersAsk`).
   */
  decidedBefore: z.string().optional(),
  /**
   * Binds an approval to profile, page, the addresses of the page and of the
   * element's frame, element, action and the value's digest.
   */
  requestHash: z.string(),
});
export type BrowserWriteApprovalRequestPayload = z.infer<
  typeof BrowserWriteApprovalRequestPayloadSchema
>;

function plural(count: number, one: string): string {
  return `${String(count)} ${one}${count === 1 ? '' : 's'}`;
}

/**
 * What a browser approval asks to do, in the words the Action Center item and
 * card both use: "click button “Pay now”", "type 12 characters into textbox
 * “Email” and press Enter". Never the value itself.
 */
export function browserApprovalActionPhrase(
  request: Pick<BrowserWriteApprovalRequestPayload, 'action' | 'element' | 'value'>,
): string {
  const { role, name } = request.element;
  const target = name !== undefined && name !== '' ? `${role} “${name}”` : `a ${role}`;
  const length = request.value?.length ?? 0;
  switch (request.action) {
    case 'click':
      return `click ${target}`;
    case 'hover':
      return `hover over ${target}`;
    case 'type':
      return (
        `type ${plural(length, 'character')} into ${target}` +
        (request.value?.submit === true ? ' and press Enter' : '')
      );
    case 'select':
      return `choose ${plural(length, 'option')} in ${target}`;
    case 'press':
      return request.value?.kind === 'key' && request.value.excerpt !== undefined
        ? `press ${request.value.excerpt} on ${target}`
        : `press a key on ${target}`;
  }
}

export const WriteApprovalRequestPayloadSchema = z.discriminatedUnion('target', [
  ApiWriteApprovalRequestPayloadSchema,
  BrowserWriteApprovalRequestPayloadSchema,
]);
export type WriteApprovalRequestPayload = z.infer<typeof WriteApprovalRequestPayloadSchema>;

/**
 * The approver's decision, keyed by `(tenant, run, requestHash)`. The executor
 * re-dispatches, recomputes the `requestHash` of the resolved request, and
 * proceeds only when an `approved` grant carries the SAME hash — a changed
 * request re-gates rather than riding a stale approval. A browser grant is
 * spent by the one action it lets through; an API grant lasts until it expires.
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

/**
 * Whether the decision on record answers a request asked while
 * `decidedBefore` was the decision on record for it: only one made after the
 * ask does. Both decision times come from the resolve boundary's clock. The
 * host reads it to know a parked page's ask was answered, and the
 * orchestrator to know a resume carries an answer, so an approval already
 * spent reads as undecided on both sides instead of re-dispatching the step
 * to ask again.
 */
export function grantAnswersAsk(
  grant: Pick<WriteApprovalGrant, 'decidedAt'> | null,
  decidedBefore: string | undefined,
): boolean {
  if (grant === null) return false;
  if (decidedBefore === undefined) return true;
  return grant.decidedAt !== undefined && Date.parse(grant.decidedAt) > Date.parse(decidedBefore);
}
