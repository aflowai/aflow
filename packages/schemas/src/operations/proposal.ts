import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  RatificationApplyReasonSchema,
  StagedChangeResolutionRouteSchema,
} from '../cybernetic/stagedChange.js';

// ============================================================================
// Shared shapes
// ============================================================================

const ProposalSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  source: z.string().optional(),
  status: z.string(),
  summary: z.string(),
  rationale: z.string(),
  confidence: z.string(),
  targetWorkflowSlug: z.string().nullable(),
  opCount: z.number().int(),
  opKinds: z.array(z.string()),
  authorityLevel: z.enum(['auto_apply', 'stage_for_review', 'require_operator']),
  resolutionRoute: StagedChangeResolutionRouteSchema,
  issueCategory: z.string().optional(),
  proposedAt: z.string(),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  hasReflectionEvidence: z.boolean(),
  hasDigestEvidence: z.boolean(),
  lastRatificationError: z
    .object({
      reason: RatificationApplyReasonSchema,
      op: z.string(),
      detail: z.string(),
      at: z.string(),
    })
    .optional(),
});

// ============================================================================
// proposal.list
// ============================================================================

export const ProposalListInputSchema = z.object({
  /** When true, only return status='proposed' (default). False returns all. */
  pendingOnly: z.boolean().default(true),
  /** Filter to a single workflow slug. */
  workflowSlug: z.string().max(128).optional(),
  resolutionRoute: StagedChangeResolutionRouteSchema.optional(),
  /** Max proposals to return. */
  limit: z.number().int().min(1).max(200).default(50),
});
export type ProposalListInput = z.infer<typeof ProposalListInputSchema>;

export const ProposalListOutputSchema = z.object({
  proposals: z.array(ProposalSummarySchema),
});
export type ProposalListOutput = z.infer<typeof ProposalListOutputSchema>;

// ============================================================================
// proposal.get
// ============================================================================

export const ProposalGetInputSchema = z.object({
  proposalId: z.string().uuid(),
});
export type ProposalGetInput = z.infer<typeof ProposalGetInputSchema>;

export const ProposalGetOutputSchema = z.object({
  /** Full StagedChange document. Opaque record at this layer; consumers reparse if they need typing. */
  proposal: z.record(z.unknown()),
});
export type ProposalGetOutput = z.infer<typeof ProposalGetOutputSchema>;

// ============================================================================
// proposal.ratify
// ============================================================================

export const ProposalRatifyInputSchema = z.object({
  proposalId: z.string().uuid(),
});
export type ProposalRatifyInput = z.infer<typeof ProposalRatifyInputSchema>;

export const ProposalRatifyOutputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  status: z.literal('ratified'),
});
export type ProposalRatifyOutput = z.infer<typeof ProposalRatifyOutputSchema>;

// ============================================================================
// proposal.reject
// ============================================================================

export const ProposalRejectInputSchema = z.object({
  proposalId: z.string().uuid(),
  /** Optional operator-supplied reason. Surfaced to the Coach as feedback. */
  reason: z.string().max(500).optional(),
});
export type ProposalRejectInput = z.infer<typeof ProposalRejectInputSchema>;

export const ProposalRejectOutputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  status: z.literal('rejected'),
});
export type ProposalRejectOutput = z.infer<typeof ProposalRejectOutputSchema>;

// ============================================================================

export const ProposalDismissInputSchema = z.object({
  proposalId: z.string().uuid(),
  /**
   * Optional operator-supplied dismissal note (e.g. "tracked in JIRA-1234").
   * Stored on the StagedChange doc; surfaced to audit trails. NOT fed back
   * into Coach learning — dismissing a platform diagnostic is neutral.
   */
  dismissReason: z.string().max(500).optional(),
});
export type ProposalDismissInput = z.infer<typeof ProposalDismissInputSchema>;

export const ProposalDismissOutputSchema = z.object({
  stagedChangeId: z.string().uuid(),
  status: z.literal('dismissed'),
});
export type ProposalDismissOutput = z.infer<typeof ProposalDismissOutputSchema>;

// ============================================================================
// Operation Registrations
// ============================================================================

export const ProposalOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'proposal',
    group: null,
    verb: 'list',
    name: 'List Coach Proposals',
    actionLabel: 'Listing proposals\u2026',
    semanticDescription:
      'List Coach-authored proposals (StagedChange records) for the current space. ' +
      'By default returns only pending proposals; set pendingOnly=false to include resolved ' +
      'ones. Filter to a specific workflow with workflowSlug, or to one of the proposal ' +
      "surfaces with resolutionRoute='tenant_ratification' (the default mix includes " +
      'platform-issue reports too). Each summary carries authorityLevel + resolutionRoute ' +
      'so you can decide what action is offered before reading the full doc; ' +
      'platform_issue records are NOT ratifiable in this space — they are diagnostics for ' +
      'the platform team.',
    tags: ['proposal', 'cybernetic', 'coach', 'governance'],
    groupDisplayName: 'Coach Proposals',
    groupDescription: 'Operator-facing controls for Coach-authored proposals.',
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'List Coach proposals (pending by default).',
      whenToUse: [
        'Helmsman flagged that pending proposals exist and the user wants to review them',
        "Operator wants to see what's been proposed for a specific workflow",
        'Auditing recent ratification activity (set pendingOnly=false)',
      ],
      whenNotToUse: [
        'Need full op details — use proposal.get on a specific proposalId',
        'Want to act on a proposal — use proposal.ratify or proposal.reject',
      ],
      pitfalls: ['Returns up to 200 proposals; refine with workflowSlug if the space is busy'],
      minimalExampleInput: { pendingOnly: true, limit: 50 },
    },
    accessMode: 'read',
    inputZod: ProposalListInputSchema,
    outputZod: ProposalListOutputSchema,
  },
  {
    stepType: 'proposal',
    group: null,
    verb: 'get',
    name: 'Get Coach Proposal',
    actionLabel: 'Loading proposal\u2026',
    semanticDescription:
      'Load a single Coach proposal by ID. Returns the full StagedChange document including ' +
      'proposal.ops (the structured changes), evidence (digest citations, reflection refs, ' +
      'diagnosis with issueCategory), authorityLevel, and resolution metadata. Use this to ' +
      'inspect a proposal before ratifying or rejecting.',
    tags: ['proposal', 'cybernetic', 'coach'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Load full detail for a single proposal.',
      whenToUse: [
        'After listing proposals, the user picks one for closer review',
        'Need to read the actual ops that would be applied if ratified',
      ],
      whenNotToUse: ['Listing or scanning proposals — use proposal.list'],
      pitfalls: [
        'Returns the document as an opaque record; specific fields like proposal.ops, evidence.diagnosis, evidence.digestCitations live inside it',
      ],
      minimalExampleInput: { proposalId: '00000000-0000-0000-0000-000000000000' },
    },
    accessMode: 'read',
    inputZod: ProposalGetInputSchema,
    outputZod: ProposalGetOutputSchema,
  },
  {
    stepType: 'proposal',
    group: null,
    verb: 'ratify',
    name: 'Ratify Coach Proposal',
    actionLabel: 'Ratifying proposal\u2026',
    semanticDescription:
      'Accept a Coach proposal. Applies the structured ops to the target artifacts ' +
      '(workflow, eval suite, etc.), emits entity.coach.ratified, opens a causal ' +
      'measurement window, then persists status=ratified. All-or-nothing: if apply fails the ' +
      'proposal stays pending and the operator sees the error. The Helmsman MUST get explicit ' +
      'user confirmation before calling this — do not ratify proposals on the user\u2019s behalf without their say-so. ' +
      'Returns code PROPOSAL_NOT_RATIFIABLE when the target is a platform-origin workflow — surface the diagnosis as a platform-issue report, do not retry.',
    tags: ['proposal', 'cybernetic', 'coach', 'governance', 'mutating'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Operator-confirmed accept of a Coach proposal.',
      whenToUse: ['User explicitly approves a specific proposal for ratification'],
      whenNotToUse: [
        'User has not explicitly approved this exact proposalId',
        'Want to inspect first — use proposal.get',
      ],
      pitfalls: [
        'Mutates the target workflow/skill artifact; not reversible without a separate operator workflow',
        'Opens a causal measurement window — subsequent runs are measured against pre-ratification baseline',
        'Returns 422 if the apply step fails; the proposal stays pending in that case',
      ],
      minimalExampleInput: { proposalId: '00000000-0000-0000-0000-000000000000' },
    },
    accessMode: 'write',
    inputZod: ProposalRatifyInputSchema,
    outputZod: ProposalRatifyOutputSchema,
  },
  {
    stepType: 'proposal',
    group: null,
    verb: 'reject',
    name: 'Reject Coach Proposal',
    actionLabel: 'Rejecting proposal\u2026',
    semanticDescription:
      'Reject a Coach proposal. Records a fingerprint of the rejected ops so the Coach will ' +
      'auto-suppress duplicate proposals within the rejected-fingerprint window. Emits ' +
      'entity.coach.rejected with the optional reason. The reason flows back into the next ' +
      "Coach review's prompt so the Coach can learn from rejections. Like ratify, requires " +
      'explicit user confirmation — do not reject on the user\u2019s behalf.',
    tags: ['proposal', 'cybernetic', 'coach', 'governance'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Operator-confirmed reject of a Coach proposal.',
      whenToUse: ['User explicitly rejects a specific proposal'],
      whenNotToUse: [
        'User has not explicitly rejected this exact proposalId',
        'User is unsure — surface the proposal detail and wait for direction',
      ],
      pitfalls: [
        'Records a fingerprint that suppresses identical proposals for ~7 days',
        "If rejecting because the proposal is wrong (vs irrelevant), pass a reason — it's the Coach's only feedback signal",
      ],
      minimalExampleInput: {
        proposalId: '00000000-0000-0000-0000-000000000000',
        reason: 'Too aggressive — prefer a softer goal change first.',
      },
    },
    accessMode: 'write',
    inputZod: ProposalRejectInputSchema,
    outputZod: ProposalRejectOutputSchema,
  },
  {
    stepType: 'proposal',
    group: null,
    verb: 'dismiss',
    name: 'Dismiss Platform-Issue Proposal',
    actionLabel: 'Dismissing platform issue…',
    semanticDescription:
      'Acknowledge a platform-issue Coach diagnostic. Only valid for proposals with ' +
      "resolutionRoute='platform_issue' — returns PROPOSAL_NOT_DISMISSIBLE otherwise. " +
      'Distinct from proposal.reject: this op emits the neutral ' +
      'entity.coach.platform_issue_acknowledged event and does NOT record a rejected ' +
      'fingerprint. That matters: the platform team has not fixed the underlying defect, ' +
      'so Coach must remain free to re-flag similar diagnostics on later runs. Use this ' +
      'when the operator has read the diagnosis and wants to clear it from the action queue.',
    tags: ['proposal', 'cybernetic', 'coach', 'platform_issue'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Operator acknowledges a platform-issue diagnostic (no fingerprint).',
      whenToUse: [
        'User has read a platform_issue proposal and wants to clear it',
        'Audit / housekeeping of the platform-issues queue',
      ],
      whenNotToUse: [
        'Proposal resolutionRoute is tenant_ratification — use proposal.ratify or proposal.reject',
        'Want to teach Coach to suppress similar proposals — that is proposal.reject, not dismiss',
      ],
      pitfalls: [
        'Does NOT teach Coach via fingerprint suppression. That is intentional.',
        'Returns 400 PROPOSAL_NOT_DISMISSIBLE if the proposal is a tenant_ratification record',
      ],
      minimalExampleInput: { proposalId: '00000000-0000-0000-0000-000000000000' },
    },
    accessMode: 'write',
    inputZod: ProposalDismissInputSchema,
    outputZod: ProposalDismissOutputSchema,
  },
];
