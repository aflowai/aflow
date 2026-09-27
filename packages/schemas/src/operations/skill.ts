/**
 * Skill operations.
 *
 * - 104f: `skill.compose.propose` — final inline task of the compose-skill
 *   workflow. Validates a `SkillComposeBundle` and emits a StagedChange
 *   proposal.
 * - 119: `skill.manage.{archive,unarchive,purge,preview}` — operator-facing
 *   lifecycle ops. The three mutating ops are `internal: true` (HTTP/UI-only,
 *   never on the agent tool surface). Only `preview` is agent-callable so the
 *   Helmsman can describe blast radius without invoking destructive ops.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AssembleWorkflowOutputSchema } from '../cybernetic/composeSkill.js';
import { CyberneticEvalSuiteSchema } from '../cybernetic/eval.js';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

// ============================================================================
// 104f — skill.compose.propose
// ============================================================================

export const SkillComposeProposeInputSchema = z.object({
  assembled: AssembleWorkflowOutputSchema,
  evals: z
    .object({
      evalSuite: CyberneticEvalSuiteSchema,
    })
    .optional(),
});
export type SkillComposeProposeInput = z.infer<typeof SkillComposeProposeInputSchema>;

export const SkillComposeProposeOutputSchema = z.object({
  proposalId: z.string().uuid(),
  skillId: z.string(),
  status: z.literal('proposed'),
  taskCount: z.number().int(),
  evalCriteriaCount: z.number().int(),
});
export type SkillComposeProposeOutput = z.infer<typeof SkillComposeProposeOutputSchema>;

// ============================================================================
// 119 — skill.manage.{archive, unarchive, purge, preview}
// ============================================================================

const SkillIdInput = z.object({ skillId: z.string().min(1).max(128) });

export const SkillManageArchiveInputSchema = z.object({
  skillId: z.string().min(1).max(128),
  force: z.boolean().optional(),
});
export type SkillManageArchiveInput = z.infer<typeof SkillManageArchiveInputSchema>;

export const SkillManageArchiveOutputSchema = z.object({
  skillId: z.string(),
  archivedAt: z.string().datetime(),
  /** Soft-deleted definition docs (manifest, projection, workflow, evals, activation, revisions). */
  softDeletedDocPaths: z.array(z.string()),
  /** /coach/staged/* docs that were soft-closed because they targeted this slug. */
  closedProposalCount: z.number().int().nonnegative(),
  /** Run IDs that were force-cancelled by archive (only populated when `force: true`). */
  forceCancelledRunIds: z.array(z.string()).optional(),
});
export type SkillManageArchiveOutput = z.infer<typeof SkillManageArchiveOutputSchema>;

export const SkillManageUnarchiveInputSchema = SkillIdInput;
export type SkillManageUnarchiveInput = z.infer<typeof SkillManageUnarchiveInputSchema>;

export const SkillManageUnarchiveOutputSchema = z.object({
  skillId: z.string(),
  restoredAt: z.string().datetime(),
  restoredDocPaths: z.array(z.string()),
});
export type SkillManageUnarchiveOutput = z.infer<typeof SkillManageUnarchiveOutputSchema>;

export const SkillManagePurgeInputSchema = z.object({
  skillId: z.string().min(1).max(128),
  /**
   * Explicit override required when historical workflow_runs reference the
   * skill's slug. Without this flag and with non-zero historical runs, purge
   * fails with SKILL_HAS_HISTORICAL_RUNS so the operator confirms the
   * dangling reference is acceptable.
   */
  confirmRunHistoryDangling: z.boolean().default(false),
});
export type SkillManagePurgeInput = z.infer<typeof SkillManagePurgeInputSchema>;

export const SkillManagePurgeOutputSchema = z.object({
  skillId: z.string(),
  purgedAt: z.string().datetime(),
  /** Path to the tombstone doc that survives the purge sweep. */
  tombstonePath: z.string(),
  /** Memory-doc paths physically removed (manifest, projection, workflow, evals, etc.). */
  deletedDocPaths: z.array(z.string()),
  /** user_feedback rows hard-deleted (telemetry cleanup; moved here from archive). */
  deletedFeedbackCount: z.number().int().nonnegative(),
  /** causal_measurements rows hard-deleted. */
  deletedCausalMeasurementCount: z.number().int().nonnegative(),
  /** workflow_runs rows that now dangle (require confirmRunHistoryDangling=true to be non-zero). */
  danglingRunCount: z.number().int().nonnegative(),
});
export type SkillManagePurgeOutput = z.infer<typeof SkillManagePurgeOutputSchema>;

export const SkillManagePreviewInputSchema = z.object({
  skillId: z.string().min(1).max(128),
  kind: z.enum(['archive', 'purge']),
});
export type SkillManagePreviewInput = z.infer<typeof SkillManagePreviewInputSchema>;

/**
 * Unified preview output covering both archive and purge counts.
 * The dialog filters by `kind` for which subset to render. Telemetry
 * counts (`feedbackRowsToDelete`, `causalMeasurementsToDelete`) are only
 * relevant for purge — archive does not touch them.
 */
export const SkillManagePreviewOutputSchema = z.object({
  skillId: z.string(),
  kind: z.enum(['archive', 'purge']),
  isPlatformSkill: z.boolean(),
  // Archive-relevant (counts of soft mutations):
  affectedDocPaths: z.array(z.string()),
  proposalsToClose: z.number().int().nonnegative(),
  // Purge-relevant (irreversible + telemetry deletions):
  feedbackRowsToDelete: z.number().int().nonnegative(),
  causalMeasurementsToDelete: z.number().int().nonnegative(),
  historicalRunCount: z.number().int().nonnegative(),
  // Blocking — must be cancelled before either op:
  activeRunCount: z.number().int().nonnegative(),
});
export type SkillManagePreviewOutput = z.infer<typeof SkillManagePreviewOutputSchema>;

// ============================================================================
// Registrations
// ============================================================================

export const SkillOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'skill',
    group: 'compose',
    verb: 'propose',
    name: 'Propose Skill Composition',
    actionLabel: 'Validating and proposing skill…',
    semanticDescription:
      'Validate the composed skill bundle (workflow + eval suite + activation) and emit a StagedChange proposal for operator review. Final task in the compose-skill workflow.',
    tags: ['skill', 'compose', 'cybernetic'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Validate and propose a new skill bundle for operator ratification.',
      whenToUse: ['As the final task in the compose-skill workflow after assemble-workflow'],
      whenNotToUse: ['Directly — this is called by the workflow engine, not by agents'],
      // Empty object — the contract test skips when example is empty; the
      // schema is non-trivial (assembled + evals) and producing a valid
      // example would require a full ComposedWorkflow fixture.
      minimalExampleInput: {},
    },
    accessMode: 'write',
    inputZod: SkillComposeProposeInputSchema,
    outputZod: SkillComposeProposeOutputSchema,
    internal: true,
  },
  {
    stepType: 'skill',
    group: 'manage',
    verb: 'archive',
    name: 'Archive Skill',
    actionLabel: 'Archiving skill…',
    semanticDescription:
      'Take a custom workspace skill out of circulation: soft-deletes manifest/projection/workflow/evals/activation, soft-closes staged proposals targeting the slug, and sets projection status to archived. Fully reversible via skill.manage.unarchive — telemetry rows (user_feedback, causal_measurements) are preserved untouched. Operator-only: not on the agent tool surface; agents must recommend in natural language and let the operator click.',
    tags: ['skill', 'manage', 'lifecycle'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Operator-facing skill archive (HTTP/UI-only, fully reversible).',
      whenToUse: [
        'Operator wants to retire a custom workspace skill from agent attention while preserving every row for audit',
      ],
      whenNotToUse: [
        'Agents — this op is internal: true. Use skill.manage.preview to describe the blast radius and recommend in prose',
        'Platform-origin skills — will reject with PLATFORM_ARTIFACT_READ_ONLY',
      ],
      minimalExampleInput: { skillId: 'skl_example' },
    },
    accessMode: 'write',
    inputZod: SkillManageArchiveInputSchema,
    outputZod: SkillManageArchiveOutputSchema,
    internal: true,
  },
  {
    stepType: 'skill',
    group: 'manage',
    verb: 'unarchive',
    name: 'Unarchive Skill',
    actionLabel: 'Restoring skill…',
    semanticDescription:
      'Complete inverse of skill.manage.archive — clears deletedAt on manifest/projection/workflow/evals/activation/revisions, restores soft-closed staged proposals, and resets projection status to dormant for the reconciler to re-evaluate. Operator-only: not on the agent tool surface.',
    tags: ['skill', 'manage', 'lifecycle'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Restore an archived custom skill (HTTP/UI-only).',
      whenToUse: ['Operator wants to bring an archived skill back into agent attention'],
      whenNotToUse: [
        'Agents — internal: true',
        'Skills that were purged (manifest physically gone) — returns SKILL_NOT_FOUND',
      ],
      minimalExampleInput: { skillId: 'skl_example' },
    },
    accessMode: 'write',
    inputZod: SkillManageUnarchiveInputSchema,
    outputZod: SkillManageUnarchiveOutputSchema,
    internal: true,
  },
  {
    stepType: 'skill',
    group: 'manage',
    verb: 'purge',
    name: 'Purge Skill',
    actionLabel: 'Permanently deleting skill…',
    semanticDescription:
      'Irreversible hard delete. Writes a tombstone first (so the run inspector can render "deleted on X by Y"), then physically removes manifest/projection/workflow/evals/activation/revisions via memoryDocs.hardDelete (correct chunk/version FK cascade), and hard-deletes user_feedback and causal_measurements rows for this skill. Gated: requires prior archive AND no historical workflow_runs (or explicit confirmRunHistoryDangling=true). Operator-only and never on the agent tool surface.',
    tags: ['skill', 'manage', 'lifecycle', 'destructive'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Permanently delete an archived skill, including telemetry (HTTP/UI-only).',
      whenToUse: [
        'Operator wants to free storage for a long-archived skill with no remaining historical runs',
      ],
      whenNotToUse: [
        'Agents — internal: true',
        'Skills not previously archived — returns SKILL_NOT_ARCHIVED',
        'Skills with historical workflow_runs unless confirmRunHistoryDangling=true is explicitly set',
      ],
      minimalExampleInput: { skillId: 'skl_example' },
    },
    accessMode: 'write',
    inputZod: SkillManagePurgeInputSchema,
    outputZod: SkillManagePurgeOutputSchema,
    internal: true,
  },
  {
    stepType: 'skill',
    group: 'manage',
    verb: 'preview',
    name: 'Preview Skill Lifecycle Action',
    actionLabel: 'Computing skill lifecycle preview…',
    semanticDescription:
      'Read-only dry-run for skill.manage.archive or skill.manage.purge. Returns counts the operator (or recommending agent) needs to understand the blast radius: affected docs, proposals to close, telemetry rows that would be deleted on purge, historical run count, and active run count (which blocks both archive and purge). Use kind="archive" before recommending archive; kind="purge" for purge.',
    tags: ['skill', 'manage', 'lifecycle', 'preview'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Compute counts for archive/purge before invoking; safe to call from agents.',
      whenToUse: [
        'Before recommending archive or purge — describe the blast radius accurately',
        'In the danger-zone confirmation dialog to populate the count display',
      ],
      whenNotToUse: ['As a substitute for archive/purge — preview never mutates'],
      minimalExampleInput: { skillId: 'skl_example', kind: 'archive' },
    },
    accessMode: 'read',
    inputZod: SkillManagePreviewInputSchema,
    outputZod: SkillManagePreviewOutputSchema,
    internal: false,
  },
];
