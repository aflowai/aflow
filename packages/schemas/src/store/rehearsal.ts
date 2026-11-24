import { z } from 'zod';
import { CatalogIdSchema } from './listingCore.js';
import { CampaignConfigRecordSchema } from '../operations/workflow/campaignOps.js';
import { ParentInputsRecordSchema } from '../runtime/parentInstructions.js';

/**
 * A go-live rehearsal of a Store bundle (Plan 346): the bundle's operating
 * flow, run in a space that installed it, at the version the catalog
 * publishes. The unit tests, the skill validity check and the schemas certify
 * the artifact. Only a rehearsal runs the installed bundle against real data.
 *
 * - `pass`: every step ran and passed.
 * - `fail`: a step ran and failed. `failingStep` names the first one.
 * - `skipped`: a step could not run. `skipReason` says why. A skip never
 *   counts as a pass.
 */
export const REHEARSAL_OUTCOMES = ['pass', 'fail', 'skipped'] as const;
export const RehearsalOutcomeSchema = z.enum(REHEARSAL_OUTCOMES);
export type RehearsalOutcome = z.infer<typeof RehearsalOutcomeSchema>;

const RehearsalStepIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Must be kebab-case, at most 64 characters');

/** A task of a rehearsed run that fails by design, with the reason it is no defect. */
export const RehearsalToleratedFailureSchema = z.object({
  taskId: z.string().min(1).max(64),
  reason: z.string().min(1).max(2000),
});
export type RehearsalToleratedFailure = z.infer<typeof RehearsalToleratedFailureSchema>;

export const RehearsalCampaignStartStepSchema = z.object({
  kind: z.literal('campaign_start'),
  stepId: RehearsalStepIdSchema,
  slug: z.string().min(1).max(64),
  config: CampaignConfigRecordSchema,
});

/**
 * What a rehearsal is given where it starts, and a run input names as
 * `{ "$rehearsal": "<parameter>" }`. `tradingDay` is the exchange-local date
 * the rehearsal starts on. `folderBindingId` is the connected folder of the
 * rehearsal space. A run step that names a parameter the rehearsal was not
 * given is skipped, and says which.
 */
export const REHEARSAL_PARAMETERS = ['tradingDay', 'folderBindingId'] as const;
export const RehearsalParameterSchema = z.enum(REHEARSAL_PARAMETERS);
export type RehearsalParameter = z.infer<typeof RehearsalParameterSchema>;
export type RehearsalParameters = Partial<Record<RehearsalParameter, string>>;

export const RehearsalRunStepSchema = z.object({
  kind: z.literal('run'),
  stepId: RehearsalStepIdSchema,
  slug: z.string().min(1).max(64),
  /** The platform skill the workflow at `slug` must be, exactly as the Store installed it. */
  skillCatalogId: CatalogIdSchema,
  inputs: ParentInputsRecordSchema,
  timeoutMinutes: z.number().int().min(1).max(180),
  /**
   * The tasks that must succeed for the step to count. A run that skips one
   * did not exercise it, so the step is skipped, never passed.
   */
  requiredTasks: z.array(z.string().min(1).max(64)).min(1).max(40),
  toleratedFailures: z.array(RehearsalToleratedFailureSchema).max(20),
});

/** A skill of the bundle no step runs, with the reason. A result lists it. */
export const RehearsalUncoveredSkillSchema = z.object({
  skillCatalogId: CatalogIdSchema,
  reason: z.string().min(1).max(2000),
});
export type RehearsalUncoveredSkill = z.infer<typeof RehearsalUncoveredSkillSchema>;

export const BundleRehearsalStepSchema = z.discriminatedUnion('kind', [
  RehearsalCampaignStartStepSchema,
  RehearsalRunStepSchema,
]);
export type BundleRehearsalStep = z.infer<typeof BundleRehearsalStepSchema>;

export const BundleRehearsalPlanSchema = z
  .object({
    catalogId: CatalogIdSchema,
    gateFromVersion: z
      .number()
      .int()
      .min(1)
      .describe(
        'The first published version of the bundle that counts as done only on a passing rehearsal at that version and content hash',
      ),
    steps: z.array(BundleRehearsalStepSchema).min(1).max(40),
    uncovered: z.array(RehearsalUncoveredSkillSchema).max(40),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.steps.forEach((step, index) => {
      if (seen.has(step.stepId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'stepId'],
          message: `Step id "${step.stepId}" is used twice.`,
        });
      }
      seen.add(step.stepId);
    });
  });
export type BundleRehearsalPlan = z.infer<typeof BundleRehearsalPlanSchema>;

/**
 * The steps every rehearsal runs around the plan's own. `install` reads what
 * the space installed. `hold_writes` makes every write the bundle asks for
 * wait for approval, and the rehearsal refuses each one. `release` restores
 * the space's write policy and ends the campaigns the rehearsal started.
 */
export const RehearsalStepKindSchema = z.enum([
  'install',
  'hold_writes',
  'campaign_start',
  'run',
  'release',
]);
export type RehearsalStepKind = z.infer<typeof RehearsalStepKindSchema>;

export const RehearsalStepResultSchema = z.object({
  stepId: z.string().min(1).max(64),
  kind: RehearsalStepKindSchema,
  outcome: RehearsalOutcomeSchema,
  detail: z.string().min(1).max(8000),
  runId: z.string().uuid().optional(),
  failedTask: z.string().min(1).max(64).optional(),
  heldWrites: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'The writes the run asked for. Each was held for approval and refused, so none reached the broker.',
    ),
});
export type RehearsalStepResult = z.infer<typeof RehearsalStepResultSchema>;

export type DerivedRehearsalOutcome =
  | { outcome: 'pass' }
  | { outcome: 'fail'; failingStep: { stepId: string; detail: string } }
  | { outcome: 'skipped'; skipReason: string };

/**
 * The one rule for a rehearsal's outcome. A failed step fails it, whatever
 * else ran. Otherwise a skipped step skips it, and so does a rehearsal with no
 * step at all. Only steps that all passed give a pass.
 */
export function deriveRehearsalOutcome(
  steps: ReadonlyArray<Pick<RehearsalStepResult, 'stepId' | 'outcome' | 'detail'>>,
): DerivedRehearsalOutcome {
  const failed = steps.find((s) => s.outcome === 'fail');
  if (failed) {
    return { outcome: 'fail', failingStep: { stepId: failed.stepId, detail: failed.detail } };
  }
  const skipped = steps.find((s) => s.outcome === 'skipped');
  if (skipped) return { outcome: 'skipped', skipReason: `${skipped.stepId}: ${skipped.detail}` };
  if (steps.length === 0) return { outcome: 'skipped', skipReason: 'No step ran.' };
  return { outcome: 'pass' };
}

export const BundleRehearsalResultSchema = z
  .object({
    catalogId: CatalogIdSchema,
    version: z.number().int().min(1).describe('The catalog version rehearsed'),
    contentHash: z.string().min(1).max(128).describe('The catalog content hash rehearsed'),
    spaceId: z.string().uuid().nullable(),
    outcome: RehearsalOutcomeSchema,
    failingStep: z
      .object({ stepId: z.string().min(1).max(64), detail: z.string().min(1).max(8000) })
      .optional(),
    skipReason: z.string().min(1).max(8000).optional(),
    steps: z.array(RehearsalStepResultSchema),
    uncovered: z
      .array(RehearsalUncoveredSkillSchema)
      .describe('The skills of the bundle the rehearsal did not run, as its plan declares them'),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
  })
  .superRefine((result, ctx) => {
    const derived = deriveRehearsalOutcome(result.steps);
    if (derived.outcome !== result.outcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: `The steps give ${derived.outcome}, not ${result.outcome}.`,
      });
    }
    if ((result.outcome === 'fail') !== (result.failingStep !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failingStep'],
        message: 'A failed rehearsal names its failing step, and no other names one.',
      });
    }
    if ((result.outcome === 'skipped') !== (result.skipReason !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skipReason'],
        message: 'A skipped rehearsal says why, and no other carries a skip reason.',
      });
    }
  });
export type BundleRehearsalResult = z.infer<typeof BundleRehearsalResultSchema>;

/** The last rehearsal of each rehearsed bundle, by catalog id: the record a publication reads. */
export const StoreRehearsalLedgerSchema = z.record(CatalogIdSchema, BundleRehearsalResultSchema);
export type StoreRehearsalLedger = z.infer<typeof StoreRehearsalLedgerSchema>;
