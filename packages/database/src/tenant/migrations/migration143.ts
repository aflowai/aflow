/**
 * Cybernetic-only conversion. Every space becomes cybernetic: residual
 * classic spaces get the SAME fully-defaulted blank directives the create
 * route stores (not a thin {version,responsibility} — the Helmsman prompt
 * reads directives.priorities etc. WITHOUT re-parsing, so a thin object
 * would throw and drop the space to the generic fallback prompt) plus a
 * Helmsman default target. Memory dirs and the self-model materialize
 * lazily (the Helmsman tolerates their absence).
 *
 * `mode` is NOT dropped here — that is a separate, later migration (per the
 * plan's two-step: the mode-free code must be live on the worker VM before
 * the column disappears, or the still-running old orchestrator's
 * `select({ mode })` crashes mid-deploy). This migration instead forces
 * every row to 'cybernetic' and flips the column default so any residual
 * read during the rollout window is correct.
 */
import type postgres from 'postgres';

/**
 * Fully-defaulted blank directives — the exact object the create route
 * persists (`EntityDirectivesSchema.parse({ version, responsibility })`).
 * Snapshot of the schema defaults as of this migration; new spaces created
 * afterward pick up current defaults through the create route.
 */
const BLANK_DIRECTIVES = JSON.stringify({
  version: 1,
  responsibility:
    'General-purpose workspace. Handle tasks, build procedures for repeating patterns, and improve over time based on feedback.',
  priorities: [],
  resourceBudget: { maxConcurrentWorkers: 3 },
  modelDefaults: { default: 'glm-pro' },
  reasoningDefaults: {},
  learningPolicy: {
    enabled: true,
    coachAutoReviewPerRun: false,
    learnerActivation: 'codified_only',
    alwaysRequireOperator: ['workflow_block', 'directive_amendment'],
    decayMode: 'flag',
    maxEvalCriteriaPerSkill: 10,
    maxCoachActivationsPerSkillPerWindow: 10,
    coachMaturityCadence: {},
    coachSamplingPolicy: 'codified_only',
    coachScoreFloor: 0.7,
    coachBootstrapRuns: 5,
    coachTrajectoryRegressionK: 2,
    coachTrajectoryMinRuns: 6,
    coachTrajectoryRecentWindow: 3,
    agentCondition: { involvedStepFloor: 8, sprawlingStepFloor: 25, stalledFailureRatio: 0.5 },
    reflectionCapture: { barrierTimeoutMs: 5000, barrierPollMs: 200 },
    rejectedFingerprintWindow: 604800000,
    coachFeedbackHistorySize: 10,
    userFeedbackPromptWindow: 20,
    causalWindow: 604800000,
    appliedChangeEvidenceLimit: 5,
    activeSetBudget: 20,
    breadthEvidence: { caseWindow: 20, learningsLimit: 10 },
    evalQualityReport: { alwaysPassesMinSamples: 10 },
    skillMaturityRunsThreshold: 5,
    skillMaturityDerivation: { masteredRunsFloor: 10, masteredConsecutiveSuccesses: 5 },
    coachFactsEnrichment: { enabled: false, model: 'haiku', maxCostCents: 5, deadlineMs: 8000 },
    coachEvidenceExploration: {
      allowedTargetKinds: ['run'],
      maxListCallsPerReview: 3,
      maxReadCallsPerReview: 8,
      maxBytesPerRead: 8000,
    },
    coachHealth: {
      window: 604800000,
      driftRateFloor: 0.3,
      driftSampleFloor: 5,
      alertMutePeriod: 86400000,
    },
    coachSampleRate: 0.2,
  },
  capabilityDiscovery: {},
});

export async function applyMigration143(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      -- Structural conversion: active classic spaces get fully-defaulted
      -- directives + a Helmsman default target. Archived rows are left
      -- untouched (they never assemble a session).
      UPDATE "${schemaName}".spaces
        SET directives = '${BLANK_DIRECTIVES}'::jsonb,
            default_target_kind = 'platform-role',
            default_target_system_role = 'cybernetic-helmsman',
            default_target_agent_id = NULL
        WHERE directives IS NULL AND archived_at IS NULL;

      -- Every row is cybernetic; flip the column default so spaces created
      -- during the rollout window (old worker still reading mode) are also
      -- correct. The column itself drops in a later migration.
      UPDATE "${schemaName}".spaces SET mode = 'cybernetic' WHERE mode <> 'cybernetic';
      ALTER TABLE "${schemaName}".spaces ALTER COLUMN mode SET DEFAULT 'cybernetic';

      -- Rules stored cap now equals the injection cap — truncate overflow.
      UPDATE "${schemaName}".spaces
        SET rules = (
          SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
          FROM (
            SELECT elem FROM jsonb_array_elements(rules) WITH ORDINALITY AS t(elem, ord)
            ORDER BY ord LIMIT 10
          ) trimmed
        )
        WHERE jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) > 10;

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (143, 'Cybernetic-only conversion — backfill fully-defaulted directives + default target, force mode, truncate rules cap')
      ON CONFLICT (version) DO NOTHING;
    `);
}
