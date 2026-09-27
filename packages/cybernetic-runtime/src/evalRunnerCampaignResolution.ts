import type { CriterionResult, CyberneticEvalSuite, EvalCriterion } from '@aflow/schemas';
import { criterionHasCampaignRefs, resolveEvalCriterionParams } from '@aflow/schemas';

/** Does any criterion in the suite carry a `$campaign` reference? */
export function suiteHasCampaignRefs(suite: CyberneticEvalSuite): boolean {
  if (suite.goalCriteria.some(criterionHasCampaignRefs)) return true;
  if (suite.trajectoryCriteria.some(criterionHasCampaignRefs)) return true;
  return Object.values(suite.taskCriteria).some((arr) => arr.some(criterionHasCampaignRefs));
}

export interface SuiteCampaignResolution {
  /**
   * The suite with `$campaign` refs resolved. Criteria that failed resolution
   * are REMOVED here (they appear as pre-failed results instead — evaluating
   * them would double-count the failure).
   */
  suite: CyberneticEvalSuite;
  /** Pre-failed results for unresolvable goal-tier criteria. */
  prefailedGoal: CriterionResult[];
  /** Pre-failed results for unresolvable task-tier criteria, keyed by taskId. */
  prefailedTask: Record<string, CriterionResult[]>;
  /** Pre-failed results for unresolvable trajectory-tier criteria. */
  prefailedTrajectory: CriterionResult[];
}

function prefail(criterion: EvalCriterion, reason: string): CriterionResult {
  return {
    criterionName: criterion.name,
    criterionType: criterion.type,
    passed: false,
    evidence: `Unresolved $campaign reference: ${reason}`,
  };
}

function resolveTier(
  criteria: readonly EvalCriterion[],
  config: Record<string, unknown> | null,
  prefailed: CriterionResult[],
): EvalCriterion[] {
  const out: EvalCriterion[] = [];
  for (const criterion of criteria) {
    if (!criterionHasCampaignRefs(criterion)) {
      out.push(criterion);
      continue;
    }
    if (config === null) {
      prefailed.push(
        prefail(
          criterion,
          'no campaign in scope for this run — campaign-parameterized criteria require the ' +
            'run to be campaign-keyed (workflow_runs.campaign_id, set at run start)',
        ),
      );
      continue;
    }
    const resolved = resolveEvalCriterionParams(criterion, config);
    if (resolved.ok) {
      // Materialized criteria are structurally a subset of the parameterized
      // union, so the resolved suite keeps the CyberneticEvalSuite shape.
      out.push(resolved.criterion);
    } else {
      prefailed.push(prefail(criterion, resolved.reason));
    }
  }
  return out;
}

/**
 * Resolve every `$campaign` reference in the suite against the run's campaign
 * config. Pass `config: null` when the run has no campaign in scope — every
 * ref-carrying criterion then pre-fails with that reason.
 */
export function resolveSuiteCampaignRefs(
  suite: CyberneticEvalSuite,
  config: Record<string, unknown> | null,
): SuiteCampaignResolution {
  const prefailedGoal: CriterionResult[] = [];
  const prefailedTrajectory: CriterionResult[] = [];
  const prefailedTask: Record<string, CriterionResult[]> = {};

  const goalCriteria = resolveTier(suite.goalCriteria, config, prefailedGoal);
  const trajectoryCriteria = resolveTier(suite.trajectoryCriteria, config, prefailedTrajectory);
  const taskCriteria: CyberneticEvalSuite['taskCriteria'] = {};
  for (const [taskId, criteria] of Object.entries(suite.taskCriteria)) {
    const failures: CriterionResult[] = [];
    taskCriteria[taskId] = resolveTier(criteria, config, failures);
    if (failures.length > 0) prefailedTask[taskId] = failures;
  }

  return {
    suite: { ...suite, goalCriteria, trajectoryCriteria, taskCriteria },
    prefailedGoal,
    prefailedTask,
    prefailedTrajectory,
  };
}
