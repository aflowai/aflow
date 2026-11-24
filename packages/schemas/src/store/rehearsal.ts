import { z } from 'zod';
import { CatalogIdSchema } from './listingCore.js';
import { CampaignConfigRecordSchema } from '../operations/workflow/campaignOps.js';
import { ParentInputsRecordSchema } from '../runtime/parentInstructions.js';
import { stableHash } from '../utils/stableHash.js';

/**
 * A go-live rehearsal of a Store bundle (Plan 346): the bundle's operating
 * flow, run in a space that installed it, at the version the catalog
 * publishes. The unit tests, the skill validity check and the schemas certify
 * the artifact. Only a rehearsal runs the installed bundle against real data.
 *
 * - `pass`: every step ran and passed.
 * - `fail`: a step ran and failed. `failingStep` names the first one.
 * - `skipped`: a step could not run for a reason other than the exchange
 *   clock. `skipReason` says why.
 * - `not_due`: the exchange clock and calendar put a step outside its
 *   exchange window when it was due to start. `notDue` names the step, the
 *   window and when the window next opens. The rehearsal starts no later step.
 *
 * Only `pass` counts. A `not_due` record says when to rehearse again.
 */
export const REHEARSAL_OUTCOMES = ['pass', 'fail', 'skipped', 'not_due'] as const;
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
 * given is skipped, and says which. A plan that names a parameter missing
 * from this list does not parse, and the issue names it.
 */
export const REHEARSAL_PARAMETERS = ['tradingDay', 'folderBindingId'] as const;
export const RehearsalParameterSchema = z.enum(REHEARSAL_PARAMETERS);
export type RehearsalParameter = z.infer<typeof RehearsalParameterSchema>;
export type RehearsalParameters = Partial<Record<RehearsalParameter, string>>;

/** The parameter a run input names as `{ "$rehearsal": name }`, or undefined for a plain value. */
export function rehearsalParameterReference(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)['$rehearsal']
    : undefined;
}

/**
 * When a step can run, by the exchange clock and calendar the bundle reads.
 * Both read the clock's exchange-local date, which must also be the
 * rehearsal's `tradingDay`, because a plan's steps rehearse one session.
 */
export const REHEARSAL_EXCHANGE_WINDOWS = ['session_day', 'session_closed'] as const;
export const RehearsalExchangeWindowSchema = z.enum(REHEARSAL_EXCHANGE_WINDOWS);
export type RehearsalExchangeWindow = z.infer<typeof RehearsalExchangeWindowSchema>;

/** What each exchange window requires, as a not_due step reports it. */
export const REHEARSAL_EXCHANGE_WINDOW_RULES: Record<RehearsalExchangeWindow, string> = {
  session_day:
    'the exchange calendar holds a session on the exchange clock’s date, and that date is the rehearsal’s trading day',
  session_closed:
    'the exchange calendar holds a session on the exchange clock’s date, that date is the rehearsal’s trading day, the market is closed, and the clock reads the session’s close or later',
};

/** The clock and calendar reads a plan's windows are decided from: the reads its bundle runs. */
export const RehearsalExchangeSourceSchema = z.object({
  apiId: z.string().min(1).max(64),
  clockEndpointId: z.string().min(1).max(64),
  calendarEndpointId: z.string().min(1).max(64),
});
export type RehearsalExchangeSource = z.infer<typeof RehearsalExchangeSourceSchema>;

/**
 * The window a rehearsal of the plan must start inside, so that every step's
 * own window holds when the step starts. `schedule` tells the operator when
 * to start one, in exchange hours.
 */
export const RehearsalWindowSchema = z.object({
  source: RehearsalExchangeSourceSchema,
  startsIn: RehearsalExchangeWindowSchema,
  schedule: z.string().min(1).max(2000),
});
export type RehearsalWindow = z.infer<typeof RehearsalWindowSchema>;

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
  /**
   * The exchange window the step needs. Outside it when the step is due, the
   * step is `not_due`, and the rehearsal starts no later step.
   */
  exchangeWindow: RehearsalExchangeWindowSchema.optional(),
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
    window: RehearsalWindowSchema.optional().describe(
      'The exchange window a rehearsal must start inside. A plan whose steps name an exchange window names one.',
    ),
  })
  .superRefine((plan, ctx) => {
    if (plan.window === undefined) {
      plan.steps.forEach((step, index) => {
        if (step.kind !== 'run' || step.exchangeWindow === undefined) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'exchangeWindow'],
          message: `Step "${step.stepId}" needs the exchange window ${step.exchangeWindow}, and the plan names no window. Add the plan's window with its exchange source and the schedule a rehearsal starts in.`,
        });
      });
    }
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
      if (step.kind !== 'run') return;
      for (const [key, value] of Object.entries(step.inputs)) {
        const named = rehearsalParameterReference(value);
        if (named === undefined || RehearsalParameterSchema.safeParse(named).success) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'inputs', key, '$rehearsal'],
          message: `Step "${step.stepId}" input "${key}" names the rehearsal parameter ${JSON.stringify(named)}, which does not exist. The parameters are ${REHEARSAL_PARAMETERS.join(', ')}.`,
        });
      }
    });
  });
export type BundleRehearsalPlan = z.infer<typeof BundleRehearsalPlanSchema>;

/**
 * The hash of a plan's steps and its window. A pass counts only for the steps
 * it ran in the window it ran in, so a step added to or changed in the plan
 * needs a new rehearsal.
 */
export function rehearsalPlanStepsHash(
  plan: Pick<BundleRehearsalPlan, 'steps'> & { window?: RehearsalWindow | undefined },
): string {
  return stableHash(
    plan.window === undefined ? plan.steps : { steps: plan.steps, window: plan.window },
  );
}

/**
 * The steps every rehearsal runs around the plan's own. `install` reads what
 * the space installed. `window`, in a plan that names one, reads the exchange
 * clock and calendar and holds the start to the plan's window. `hold_writes`
 * makes every write the bundle asks for wait for approval, and the rehearsal
 * refuses each one. `release` restores the space's write policy and ends the
 * campaigns the rehearsal started.
 */
export const RehearsalStepKindSchema = z.enum([
  'install',
  'window',
  'hold_writes',
  'campaign_start',
  'run',
  'release',
]);
export type RehearsalStepKind = z.infer<typeof RehearsalStepKindSchema>;

export const RehearsalNotDueSchema = z.object({
  stepId: z.string().min(1).max(64),
  window: RehearsalExchangeWindowSchema,
  detail: z.string().min(1).max(8000),
  nextOpensAt: z
    .string()
    .min(1)
    .max(64)
    .nullable()
    .describe(
      'When the window next opens, as the exchange-local date and time the calendar gives, or null where the calendar read holds no such session',
    ),
});
export type RehearsalNotDue = z.infer<typeof RehearsalNotDueSchema>;

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
  notDue: RehearsalNotDueSchema.optional().describe(
    'On the step whose exchange window was closed: the window, and when it next opens',
  ),
});
export type RehearsalStepResult = z.infer<typeof RehearsalStepResultSchema>;

export type DerivedRehearsalOutcome =
  | { outcome: 'pass' }
  | { outcome: 'fail'; failingStep: { stepId: string; detail: string } }
  | { outcome: 'skipped'; skipReason: string }
  | { outcome: 'not_due'; notDue: RehearsalNotDue };

/**
 * The one rule for a rehearsal's outcome. A failed step fails it, whatever
 * else ran. Otherwise a skipped step skips it, and so does a rehearsal with no
 * step at all. Otherwise a step outside its exchange window makes it
 * `not_due`, naming the first such step and its window. Only steps that all
 * passed give a pass.
 */
export function deriveRehearsalOutcome(
  steps: ReadonlyArray<Pick<RehearsalStepResult, 'stepId' | 'outcome' | 'detail' | 'notDue'>>,
): DerivedRehearsalOutcome {
  const failed = steps.find((s) => s.outcome === 'fail');
  if (failed) {
    return { outcome: 'fail', failingStep: { stepId: failed.stepId, detail: failed.detail } };
  }
  const skipped = steps.find((s) => s.outcome === 'skipped');
  if (skipped) return { outcome: 'skipped', skipReason: `${skipped.stepId}: ${skipped.detail}` };
  if (steps.length === 0) return { outcome: 'skipped', skipReason: 'No step ran.' };
  const notDue = steps.find((s) => s.outcome === 'not_due');
  if (notDue) {
    return notDue.notDue === undefined
      ? {
          outcome: 'skipped',
          skipReason: `${notDue.stepId}: the step is not_due and names no window.`,
        }
      : { outcome: 'not_due', notDue: notDue.notDue };
  }
  return { outcome: 'pass' };
}

export const BundleRehearsalResultSchema = z
  .object({
    catalogId: CatalogIdSchema,
    version: z.number().int().min(1).describe('The catalog version rehearsed'),
    contentHash: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'The content hash rehearsed. On a pass it is the hash the space stamped on its install, which the install step compared with the revision',
      ),
    planStepsHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe('The hash of the plan steps the rehearsal ran (`rehearsalPlanStepsHash`)'),
    spaceId: z.string().uuid().nullable(),
    outcome: RehearsalOutcomeSchema,
    failingStep: z
      .object({ stepId: z.string().min(1).max(64), detail: z.string().min(1).max(8000) })
      .optional(),
    skipReason: z.string().min(1).max(8000).optional(),
    notDue: RehearsalNotDueSchema.optional(),
    window: RehearsalWindowSchema.nullable().describe(
      'The exchange window the plan starts a rehearsal in, or null for a plan that names none',
    ),
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
    if ((result.outcome === 'not_due') !== (result.notDue !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notDue'],
        message:
          'A not_due rehearsal names the step and the window that was closed, and no other names one.',
      });
    }
  });
export type BundleRehearsalResult = z.infer<typeof BundleRehearsalResultSchema>;

/**
 * The rehearsals of each rehearsed bundle, by catalog id, oldest first: the
 * records a publication reads. A pass stays on record when a later rehearsal
 * of the same version and content skips or fails, so the gate reads the best
 * record, not the newest.
 */
export const StoreRehearsalLedgerSchema = z.record(
  CatalogIdSchema,
  z.array(BundleRehearsalResultSchema).min(1),
);
export type StoreRehearsalLedger = z.infer<typeof StoreRehearsalLedgerSchema>;
