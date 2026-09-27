import type {
  CyberneticEvalSuite,
  SkillDiagnostic,
  SkillManifest,
  StagedChangeOp,
  Workflow,
} from '@aflow/schemas';
import type { SkillCampaignManifestParams } from '../skillValidity/skillValidity.js';
import { applyOpsToSnapshot } from './applyOpsToSnapshot.js';

// ============================================================================
// Types
// ============================================================================

export interface PreviewProposalApplyInput {
  /**
   * Workflow snapshot loaded at the proposal's `pinnedRevision`. `null`
   * for proposals that only touch eval suites (eval-only proposals).
   */
  workflow: Workflow | null;
  /** Eval suites keyed by skill slug. Empty if no eval ops are present. */
  evalSuites: Map<string, CyberneticEvalSuite>;
  /** The ops the Coach intends to stage. */
  ops: readonly StagedChangeOp[];
  /** Target workflow slug — populates the eval-op slug fallback. */
  targetSlug?: string;
  campaign?: SkillCampaignManifestParams;
  /**
   * Manifest snapshot — required when the proposal carries goal/campaign ops.
   * The post-edit contract is what workflow/eval ops are validated against.
   */
  manifest?: SkillManifest | null;
  /** Who is staging these ops — stamps/enforces eval-criterion ownership. Default coach. */
  source?: 'coach' | 'operator';
}

export type PreviewProposalApplyResult =
  | {
      ok: true;
      candidateWorkflow: Workflow | null;
      candidateEvalSuites: Map<string, CyberneticEvalSuite>;
      /**
       * The post-apply workflow revision (i.e. `input.workflow.revision + 1`),
       * captured so callers can pin it on `evidence.applyPreview`.
       */
      workflowRevisionAtPreview: number | null;
    }
  | {
      ok: false;
      failureCode: string;
      failureDetail: string;
      failedOpIndex?: number;
      diagnostics?: SkillDiagnostic[];
    };

// ============================================================================
// Entry
// ============================================================================

/**
 * Compute the post-apply candidate state from snapshot + ops. Pure.
 *
 * Returns:
 *  - `{ ok: true, candidateWorkflow, candidateEvalSuites }` when every op
 *    applies cleanly and the candidate workflow passes schema + graph
 *    validation.
 *  - `{ ok: false, failureCode, failureDetail }` otherwise. The caller is
 *    expected to surface `PREVIEW_FAILED` to the Coach agent synchronously
 *    and to NOT persist the proposal.
 */
export function previewProposalApply(input: PreviewProposalApplyInput): PreviewProposalApplyResult {
  // Compute the valid task-id set up front for eval-task-scope validation.
  // This is the same source-of-truth that `applyEvalOpsForSlugLocked` reads
  // when ratification actually runs.
  const workflowTaskIds = input.workflow
    ? new Set(input.workflow.tasks.map((t) => t.taskId))
    : undefined;

  let result;
  try {
    result = applyOpsToSnapshot({
      workflow: input.workflow,
      evalSuites: input.evalSuites,
      ...(workflowTaskIds ? { workflowTaskIds } : {}),
      ops: input.ops,
      ...(input.targetSlug ? { targetSlug: input.targetSlug } : {}),
      ...(input.manifest ? { manifest: input.manifest } : {}),
      ...(input.campaign ? { campaign: input.campaign } : {}),
      ...(input.source ? { source: input.source } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      failureCode: 'preview_impure',
      failureDetail: `applyOpsToSnapshot threw or performed I/O: ${detail}`,
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      failureCode: result.failureCode,
      failureDetail: result.failureDetail,
      ...(result.failedOpIndex !== undefined ? { failedOpIndex: result.failedOpIndex } : {}),
      ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
    };
  }

  return {
    ok: true,
    candidateWorkflow: result.candidateWorkflow,
    candidateEvalSuites: result.candidateEvalSuites,
    workflowRevisionAtPreview: result.candidateWorkflow ? result.candidateWorkflow.revision : null,
  };
}
