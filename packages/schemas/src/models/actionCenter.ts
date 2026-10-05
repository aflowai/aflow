import { z } from 'zod';
import { GateContextSchema, RelatesToEntrySchema } from '../operations/user.js';
import { RatificationApplyReasonSchema } from '../cybernetic/stagedChange.js';
import { BrowserProfileIdSchema } from '../operations/browserProfile.js';
import { BROWSER_HANDOFF_REASONS } from '../operations/browserWindow.js';
import {
  BrowserApprovalAskedBySchema,
  BrowserApprovalValueSummarySchema,
  BrowserWriteApprovalRequestPayloadSchema,
} from '../runtime/requestedInput.js';

// ============================================================================
// Origin discriminator — where this item came from
// ============================================================================

export const StepOriginSchema = z.object({
  type: z.literal('step'),
  runId: z.string(),
  stepExecutionId: z.string(),
  sessionId: z.string(),
  pauseVersion: z.number().int().nonnegative(),
  /**
   * Which pause instance this item is answering (`derivePauseToken`).
   *
   * The step-execution id alone is not enough: a run can park twice on the
   * same step asking different things, and both would carry the same coarse
   * `pauseVersion`, so an answer to the first would pass compare-and-set
   * against the second.
   */
  pauseToken: z.string().max(64).optional(),
  /** The operationId that paused (e.g. 'user.interaction.approve'). */
  operationId: z.string(),
});
export type StepOrigin = z.infer<typeof StepOriginSchema>;

/**
 * Coach StagedChange under `/coach/staged/*.json`. CAS token: doc revision.
 */
export const ProposalOriginSchema = z.object({
  type: z.literal('proposal'),
  proposalId: z.string(),
  proposalRevision: z.number().int().nonnegative(),
  resolutionRoute: z.enum(['tenant_ratification', 'platform_issue']),
});
export type ProposalOrigin = z.infer<typeof ProposalOriginSchema>;

export const GateOriginSchema = z.object({
  type: z.literal('gate'),
  runId: z.string(),
  stepExecutionId: z.string(),
  sessionId: z.string(),
  pauseVersion: z.number().int().nonnegative(),
  gateRequestId: z.string(),
});
export type GateOrigin = z.infer<typeof GateOriginSchema>;

/**
 * Out-of-band record from a settings surface (compute egress, etc.).
 * Migration target during Phase 7 — sources may still own their own UI.
 */
export const SettingsOriginSchema = z.object({
  type: z.literal('settings'),
  recordKind: z.string(),
  recordId: z.string(),
  recordVersion: z.number().int().nonnegative(),
});
export type SettingsOrigin = z.infer<typeof SettingsOriginSchema>;

export const CoachActivityOriginSchema = z.object({
  type: z.literal('coach_activity'),
  activityId: z.string().uuid(),
  outcome: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
});
export type CoachActivityOrigin = z.infer<typeof CoachActivityOriginSchema>;

/**
 * A trigger an agent armed: something that will now start work without anybody
 * asking, set up in a conversation the operator may not have watched.
 *
 * View-only, like coach activity. The authority is ordinary — a triggered run
 * reaches exactly what an interactive one reaches — so there is nothing to
 * approve. What was missing was any way to learn it had happened.
 */
export const TriggerArmedOriginSchema = z.object({
  type: z.literal('trigger_armed'),
  scheduleId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type TriggerArmedOrigin = z.infer<typeof TriggerArmedOriginSchema>;

export const WorkflowTaskOriginSchema = z.object({
  type: z.literal('workflow_task'),
  runId: z.string().uuid(),
  taskId: z.string().min(1).max(64),
  pauseVersion: z.number().int().nonnegative(),
});
export type WorkflowTaskOrigin = z.infer<typeof WorkflowTaskOriginSchema>;

/**
 * A pending session invitation, derived at list time from the invitee's
 * `session_participants` row — no separate storage. `generation` is the CAS
 * token: a re-invitation after a decline is a NEW item, never a resurrected
 * one. Resolutions map onto the generic pair — `approve` joins, `reject`
 * declines — with the words carried by uiHints (approveLabel 'Join',
 * rejectLabel 'Decline'). Visible to the invitee only.
 */
export const SessionInvitationOriginSchema = z.object({
  type: z.literal('session_invitation'),
  sessionId: z.string().uuid(),
  inviteeUserId: z.string().uuid(),
  generation: z.number().int().positive(),
});
export type SessionInvitationOrigin = z.infer<typeof SessionInvitationOriginSchema>;

/**
 * The registrable host of the page a hand-off is for: a DNS name, so 253
 * characters at most. A page with no host has no site and is not handed over.
 */
export const BrowserHandoffSiteSchema = z.string().min(1).max(253);

/**
 * A run's page handed to the operator in a browser window on their machine
 * (`browser.page.handoff`), while the step that asked waits there.
 *
 * One item per profile and site, and the record behind it can list several
 * runs. Today it lists one: the host executor refuses a second hand-off on a
 * profile whose window is already shown (`window_shown`), so a second run never
 * waits on an open item. Read from the record the host executor keeps in Redis
 * for as long as some run waits on it, so the item is gone when the last wait
 * ends, however it ends. **Done** ends every wait the item lists with
 * `completed`.
 */
export const BrowserHandoffOriginSchema = z.object({
  type: z.literal('browser_handoff'),
  spaceId: z.string(),
  /** The machine whose window it is, by the name its inventory and machine page give it. */
  machineLabel: z.string().min(1).max(255),
  profileId: BrowserProfileIdSchema,
  /** The registrable host of the page when it was handed over. */
  site: BrowserHandoffSiteSchema,
  reason: z.enum(BROWSER_HANDOFF_REASONS),
  /** The first run's words for the operator. */
  message: z.string().min(1).max(8_000),
  startedAt: z.string().datetime(),
  /** Each run waiting on it in this space, and the step that is waiting. */
  waiting: z
    .array(
      z.object({
        runId: z.string(),
        stepExecutionId: z.string(),
        sessionId: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type BrowserHandoffOrigin = z.infer<typeof BrowserHandoffOriginSchema>;

export const ActionCenterItemOriginSchema = z.discriminatedUnion('type', [
  StepOriginSchema,
  ProposalOriginSchema,
  GateOriginSchema,
  SettingsOriginSchema,
  CoachActivityOriginSchema,
  TriggerArmedOriginSchema,
  WorkflowTaskOriginSchema,
  SessionInvitationOriginSchema,
  BrowserHandoffOriginSchema,
]);
export type ActionCenterItemOrigin = z.infer<typeof ActionCenterItemOriginSchema>;

// ============================================================================
// Resolution — what the operator does to close an item
// ============================================================================

export const ActionCenterResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('submit'), payload: z.unknown() }),
  z.object({ kind: z.literal('approve'), comment: z.string().max(2_000).optional() }),
  z.object({ kind: z.literal('reject'), reason: z.string().max(2_000).optional() }),
  z.object({ kind: z.literal('ratify') }),
  z.object({ kind: z.literal('dismiss'), reason: z.string().max(500).optional() }),
  // Routes attention rather than closing the item: the request is now being
  // asked of the named person, who gains no authority to answer it by being
  // named. The item stays open.
  z.object({
    kind: z.literal('reassign'),
    assigneeUserId: z.string().uuid(),
    reason: z.string().max(500).optional(),
  }),
]);
export type ActionCenterResolution = z.infer<typeof ActionCenterResolutionSchema>;

// ============================================================================
// Authorization & resolver policy
// ============================================================================

export const ResolverPolicySchema = z.object({
  minResolvers: z.number().int().positive().default(1),
  requireAll: z.boolean().default(false),
  /** User ids or role names that may resolve this item. Empty = any authorised member. */
  candidateResolvers: z.array(z.string().max(128)).max(50).optional(),
});
export type ResolverPolicy = z.infer<typeof ResolverPolicySchema>;

/**
 * Who a request is waiting on, from the asking person's point of view.
 *
 * Derived per reader from the resolver policy, never stored: the same item is
 * `you` to the person named on it and `someone_else` to everyone watching. An
 * untargeted request is `anyone` — the common case, and the one that keeps a
 * solo space exactly as it was.
 */
export const ActionCenterAudienceSchema = z.enum(['anyone', 'you', 'someone_else']);
export type ActionCenterAudience = z.infer<typeof ActionCenterAudienceSchema>;

/**
 * Who may answer a request, derived from the pause payload it was made with.
 *
 * `user.interaction.approve` accepts an `approvers` list (user ids or role
 * names) and the user executor writes it into the pause payload. Every path
 * that answers or routes a pause must read it through here — deriving it in
 * one place is what makes naming an approver mean the same thing on all of
 * them.
 *
 * Targeting only. Multi-party sign-off is expressed as separate approval
 * steps in the skill's workflow, so there is deliberately no vote count here.
 */
export function deriveResolverPolicy(
  payload: Record<string, unknown> | null | undefined,
): ResolverPolicy | undefined {
  const raw = payload?.['approvers'] ?? payload?.['candidateResolvers'];
  if (!Array.isArray(raw)) return undefined;

  const candidateResolvers = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 128)
    .slice(0, 50);
  if (candidateResolvers.length === 0) return undefined;

  return { minResolvers: 1, requireAll: false, candidateResolvers };
}

/**
 * An actor satisfies a policy by being named directly or by holding a named
 * role. An empty allowlist means the request was never targeted.
 */
export function isResolverAllowed(
  policy: ResolverPolicy | undefined,
  actor: { actorUserId: string; actorSpaceRole: string },
): boolean {
  const candidates = policy?.candidateResolvers;
  if (!candidates || candidates.length === 0) return true;
  return candidates.includes(actor.actorUserId) || candidates.includes(actor.actorSpaceRole);
}

export const ActionCenterAllowedActionSchema = z.enum([
  'submit',
  'approve',
  'reject',
  'ratify',
  'dismiss',
  'comment',
  'reassign',
  'connect',
]);
export type ActionCenterAllowedAction = z.infer<typeof ActionCenterAllowedActionSchema>;

// ============================================================================

export const ActionCenterResolutionErrorSchema = z.object({
  reason: z.string(),
  severity: z.enum(['transient', 'stale_target', 'permanent']),
  detail: z.string().max(2_000).optional(),
  attempts: z.number().int().nonnegative().default(0),
});
export type ActionCenterResolutionError = z.infer<typeof ActionCenterResolutionErrorSchema>;

// ============================================================================
// Item
// ============================================================================

export const ActionCenterItemKindSchema = z.enum([
  'human_input',
  'human_approval',
  'ratification',
  'platform_issue',
  'coach_activity',
  'trigger_armed',
  'needs_oauth_consent',
  'write_approval',
  'session_invitation',
  'browser_handoff',
]);
export type ActionCenterItemKind = z.infer<typeof ActionCenterItemKindSchema>;

export const ActionCenterRequesterSchema = z.object({
  kind: z.enum(['agent', 'gate', 'coach', 'workflow', 'system']),
  /** Display label, e.g. "Helmsman", "Coach", "MCP gate: stripe", "Workflow: kaggle-experiment". */
  label: z.string().min(1).max(200),
  /** Session id that authored the request, when applicable. */
  sessionId: z.string().optional(),
  /** User id that authored the request (for `kind === 'system'` admin actions). */
  userId: z.string().optional(),
});
export type ActionCenterRequester = z.infer<typeof ActionCenterRequesterSchema>;

export const ActionCenterUiHintsSchema = z.object({
  mode: z.enum(['text', 'textarea', 'form', 'chat', 'choices', 'diff']).optional(),
  submitLabel: z.string().max(100).optional(),
  approveLabel: z.string().max(100).optional(),
  rejectLabel: z.string().max(100).optional(),
});
export type ActionCenterUiHints = z.infer<typeof ActionCenterUiHintsSchema>;

export const ActionCenterItemStatusSchema = z.enum([
  'open',
  'resolving',
  'resolved',
  'expired',
  'cancelled',
]);
export type ActionCenterItemStatus = z.infer<typeof ActionCenterItemStatusSchema>;

// ============================================================================

export const CoachProposalExtensionSchema = z.object({
  kind: z.literal('coach_proposal'),
  /**
   * Underlying `StagedChange.kind` (e.g. `'workflow_refinement'`,
   * `'skill_compose'`, `'platform_issue'`). Distinct from the AC item's
   * top-level `kind` (which is the AC kind, `'ratification' |
   * 'platform_issue'`) — `<ProposalCard>` reads `proposal.kind` to
   * label the row and expects the StagedChange kind, not the AC kind.
   * Without this field every card label would collapse to two words.
   */
  proposalKind: z.string(),
  /**
   * Raw `StagedChange.proposal.summary` — the operator-facing line
   * the Coach authored. Carried separately from the AC item's top-
   * level `summary` field because the two have different audiences:
   * `item.summary` is the generic inbox description (e.g. the
   * platform-issue sentinel sentence or `"summary (confidence: X)"`
   * for non-Coach surfaces); `proposalSummary` is what the rich
   * `<ProposalCard>` wants to render as the card title. Without
   * this split, the Coach panel either gets the inbox copy
   * (loses voice) or the AC PeekPanel loses its inbox phrasing.
   */
  proposalSummary: z.string(),
  rationale: z.string(),
  confidence: z.string(),
  opCount: z.number().int().nonnegative(),
  opKinds: z.array(z.string()),
  authorityLevel: z.enum(['auto_apply', 'stage_for_review', 'require_operator']),
  targetWorkflowSlug: z.string().nullable(),
  hasReflectionEvidence: z.boolean(),
  lastRatificationError: z
    .object({
      reason: RatificationApplyReasonSchema,
      op: z.string(),
      detail: z.string(),
      at: z.string(),
    })
    .optional(),
  rebaseState: z.enum(['clean', 'stale']).optional(),
  staleSummary: z
    .object({
      conflictCount: z.number().int().nonnegative(),
      firstOpKind: z.string().nullable(),
    })
    .optional(),
  validationsSummary: z
    .object({
      overallSafe: z.boolean(),
      warningCount: z.number().int().nonnegative(),
      blockerCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  applyPreviewStatus: z
    .object({
      result: z.literal('ok'),
      previewedAt: z.string().datetime(),
      workflowRevisionAtPreview: z.number().int().nullable(),
    })
    .optional(),
});
export type CoachProposalExtension = z.infer<typeof CoachProposalExtensionSchema>;

export const OAuthConsentExtensionSchema = z.object({
  kind: z.literal('oauth_consent'),
  integrationKind: z.enum(['mcp', 'api']),
  /** Logical provider key — serverId (MCP) | apiId (API), NOT the binding. */
  resourceKey: z.string(),
  bindingId: z.string(),
  ownerScope: z.enum(['user', 'space']),
  reason: z.enum(['never_connected', 'expired']),
  /**
   * Where the operator UI launches consent. A server-relative POST path
   * (e.g. `/v1/integrations/mcp/bindings/:bindingId/consent`) the web card hits via
   * `useApiMutation` to obtain the provider authorization URL, or — when the
   * executor already resolved it — a ready-to-open authorization URL.
   */
  consentUrlHint: z.string().optional(),
  authorizationUrlHint: z.string().optional(),
});
export type OAuthConsentExtension = z.infer<typeof OAuthConsentExtensionSchema>;

/**
 * Write-approval card payload (Plan 253) — the redacted preview an operator
 * approves or denies before a gated write fires. Carries no secrets: host only
 * (never the full URL), and a truncated body preview.
 */
export const ApiWriteApprovalExtensionSchema = z.object({
  kind: z.literal('write_approval'),
  target: z.literal('api'),
  apiId: z.string(),
  endpointId: z.string(),
  endpointName: z.string().optional(),
  operationLabel: z.string().optional(),
  method: z.string(),
  urlHost: z.string(),
  writeRiskTier: z.enum(['read', 'low', 'medium', 'high']),
  bodyPreview: z.string().optional(),
  initiatedBy: z.string().optional(),
});
export type ApiWriteApprovalExtension = z.infer<typeof ApiWriteApprovalExtensionSchema>;

/**
 * The same card for an action in the agent's browser (Plan 320 D7): the site
 * and page, what will be done to which element, what would be entered — a
 * credential field by its length alone — the page as it stood, until when
 * the request stands, and when the same action was approved before.
 */
export const BrowserWriteApprovalExtensionSchema = z.object({
  kind: z.literal('write_approval'),
  target: z.literal('browser'),
  profileId: z.string(),
  pageOrigin: z.string(),
  pageTitle: z.string(),
  action: BrowserWriteApprovalRequestPayloadSchema.shape.action,
  element: BrowserWriteApprovalRequestPayloadSchema.shape.element,
  value: BrowserApprovalValueSummarySchema.optional(),
  askedBy: BrowserApprovalAskedBySchema,
  screenshotRef: z.string().optional(),
  standsUntil: BrowserWriteApprovalRequestPayloadSchema.shape.standsUntil,
  /** Present when an approval of this exact action, given then, has been used and it is asked for again. */
  decidedBefore: BrowserWriteApprovalRequestPayloadSchema.shape.decidedBefore,
});
export type BrowserWriteApprovalExtension = z.infer<typeof BrowserWriteApprovalExtensionSchema>;

export const WriteApprovalExtensionSchema = z.discriminatedUnion('target', [
  ApiWriteApprovalExtensionSchema,
  BrowserWriteApprovalExtensionSchema,
]);
export type WriteApprovalExtension = z.infer<typeof WriteApprovalExtensionSchema>;

// A union rather than one discriminated on `kind`: both write-approval
// variants share that kind and differ by `target`.
export const ActionCenterItemExtensionSchema = z.union([
  CoachProposalExtensionSchema,
  OAuthConsentExtensionSchema,
  WriteApprovalExtensionSchema,
  // Future: ScheduleExtension, RecordExtension, … keep generic.
]);
export type ActionCenterItemExtension = z.infer<typeof ActionCenterItemExtensionSchema>;

export const ActionCenterItemSchema = z.object({
  /** Deterministic id from the origin. e.g. `step:${stepExecutionId}` or `proposal:${proposalId}`. */
  id: z.string().min(1).max(256),
  spaceId: z.string().uuid(),
  kind: ActionCenterItemKindSchema,
  origin: ActionCenterItemOriginSchema,

  // Display
  title: z.string().min(1).max(256),
  /** 1–3 sentence operator-facing context. Heavy body data goes via bodyRef. */
  summary: z.string().min(1).max(2_000),
  /** PayloadRef to full review body (diff text, evidence, large reviewData). */
  bodyRef: z.string().optional(),
  uiHints: ActionCenterUiHintsSchema.optional(),
  /** JSON Schema the resolution payload must satisfy (echoed for client-side validation). */
  resolutionSchema: z.record(z.unknown()).optional(),
  extension: ActionCenterItemExtensionSchema.optional(),

  // Provenance
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  requestedBy: ActionCenterRequesterSchema,
  priority: z.enum(['normal', 'high']).default('normal'),
  /** Present iff this item came from a gate (`origin.type === 'gate'`). */
  gateContext: GateContextSchema.optional(),
  /** What this item is about — proposals, other steps, bindings, etc. */
  relatesTo: z.array(RelatesToEntrySchema).max(10).default([]),

  // Authorization (server-computed per requesting user)
  allowedActions: z.array(ActionCenterAllowedActionSchema).default([]),
  resolverPolicy: ResolverPolicySchema.optional(),
  audience: ActionCenterAudienceSchema.default('anyone'),
  /** Who this is currently being asked of, when someone routed it. Attention, never authority. */
  assignee: z.string().uuid().optional(),

  // Lifecycle
  status: ActionCenterItemStatusSchema,
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: z.string().optional(),
  resolution: ActionCenterResolutionSchema.optional(),
  resolutionError: ActionCenterResolutionErrorSchema.optional(),
});
export type ActionCenterItem = z.infer<typeof ActionCenterItemSchema>;

// ============================================================================
// Resolve request — what the client sends to POST .../resolve
// ============================================================================

export const ActionCenterResolveRequestSchema = z.object({
  /**
   * The origin the client observed when it loaded the item. The server
   * compares this against the live source's CAS token; mismatch returns
   * `409 STALE_ACTION_CENTER_ITEM` with the updated item embedded.
   */
  origin: ActionCenterItemOriginSchema,
  resolution: ActionCenterResolutionSchema,
});
export type ActionCenterResolveRequest = z.infer<typeof ActionCenterResolveRequestSchema>;
