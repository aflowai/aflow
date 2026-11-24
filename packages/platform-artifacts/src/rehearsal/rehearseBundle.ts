import {
  BundleRehearsalResultSchema,
  deriveRehearsalOutcome,
  rehearsalParameterReference,
  RehearsalParameterSchema,
  rehearsalPlanStepsHash,
  StepOriginSchema,
  WorkflowTaskOriginSchema,
  type BundleRehearsalPlan,
  type BundleRehearsalResult,
  type BundleRehearsalStep,
  type RehearsalExchangeSource,
  type RehearsalExchangeWindow,
  type RehearsalParameters,
  type RehearsalStepResult,
  type SpaceWriteApprovalPolicy,
} from '@aflow/schemas';
import { exchangeWindowVerdict, type ExchangeReading } from './exchangeWindow.js';

/**
 * The go-live rehearsal (Plan 346): a bundle's operating flow, run against
 * the bundle a space installed, in that space, through the platform's own
 * API. Every step reports what it saw. A step that cannot run is skipped and
 * says why, so nothing it did not exercise reads as a pass. A step the
 * exchange clock and calendar put outside its window is `not_due`, names the
 * window and when it next opens, and no later step starts.
 *
 * The rehearsal places no broker order and makes no other external write.
 * Before the first step it sets the space's write policy so every write tier
 * waits for approval, and it refuses each write its own runs ask for. A write
 * another session or the operator raised in the space is left alone. The
 * release step restores the policy.
 */

/** One task of a rehearsed run, as the run detail reports it. */
export interface RehearsedTask {
  taskId: string;
  status: string;
  failureReason?: string | undefined;
  errorCode?: string | undefined;
  /** The session an agent task runs in. Its tool steps raise their writes there. */
  workerSessionId?: string | undefined;
}

export interface RehearsedRun {
  status: string;
  pausedReason?: string | undefined;
  tasks: RehearsedTask[];
}

/** A write the space holds for approval: an Action Center item the rehearsal refuses. */
export interface HeldWrite {
  id: string;
  origin: unknown;
  title: string;
}

export type ClientResult<T> = ({ ok: true } & T) | { ok: false; message: string };

/** A run the client cannot start at all, and why. */
export interface RunDeclined {
  ok: false;
  skipped: true;
  message: string;
}

/**
 * What a rehearsal asks of the platform. The HTTP client serves it against a
 * running stack. `MockRehearsalClient` serves the smoke run from memory.
 */
export interface RehearsalClient {
  /** The space's install of the listing. Not installed is `ok: false`. */
  readInstall(catalogId: string): Promise<
    ClientResult<{
      installedVersion: number;
      catalogVersion: number;
      /** The content hash the space stamped when it installed `installedVersion`. */
      installedContentHash: string;
      /** The content hash of the version the stack's catalog publishes. */
      catalogContentHash: string;
      customized: boolean;
    }>
  >;
  /** Apply the Store update to `expectedVersion`. */
  applyUpdate(catalogId: string, expectedVersion: number): Promise<ClientResult<object>>;
  readWritePolicy(): Promise<SpaceWriteApprovalPolicy | null>;
  writeWritePolicy(policy: SpaceWriteApprovalPolicy | null): Promise<void>;
  startCampaign(
    slug: string,
    config: Record<string, unknown>,
  ): Promise<ClientResult<{ campaignId: string; created: boolean }>>;
  endCampaign(slug: string, campaignId: string): Promise<void>;
  /**
   * A client that cannot run the skill at all declines it with `skipped`, and
   * the step records a skip with the client's reason, never a pass.
   */
  startRun(
    slug: string,
    skillCatalogId: string,
    inputs: Record<string, unknown>,
  ): Promise<ClientResult<{ runId: string }> | RunDeclined>;
  readRun(runId: string): Promise<RehearsedRun>;
  cancelRun(runId: string, reason: string): Promise<void>;
  /** Every open write approval in the space, whoever raised it. */
  listHeldWrites(): Promise<HeldWrite[]>;
  refuseWrite(write: HeldWrite, reason: string): Promise<void>;
  /** The exchange clock, and the calendar from the clock's date on, through the source's reads. */
  readExchange(
    source: RehearsalExchangeSource,
  ): Promise<ClientResult<{ reading: ExchangeReading }>>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface RehearsalTarget {
  catalogId: string;
  /** The version the catalog publishes, which the space must hold. */
  version: number;
  /** The revision's content hash, which the space's install must carry. */
  contentHash: string;
}

export interface RehearseBundleOptions {
  plan: BundleRehearsalPlan;
  target: RehearsalTarget;
  /** The space the bundle is installed in. Absent, nothing can run, and the install step says so. */
  spaceId: string | null;
  client: RehearsalClient;
  /**
   * The values `$rehearsal` inputs name. A plan with a window takes
   * `tradingDay` from the exchange clock where this names none.
   */
  parameters: RehearsalParameters;
  /** Apply the Store update first when the space holds an older version. */
  update?: boolean;
  /**
   * Why the rehearsal cannot reach the platform at all, found before it
   * started: no reachable API, no credential or no space. Each reason is
   * recorded, and no step runs.
   */
  unavailable?: readonly string[];
  pollMs?: number;
}

/** Every tier a write can carry waits for approval while the rehearsal runs. */
export const REHEARSAL_WRITE_HOLD: SpaceWriteApprovalPolicy = {
  requireApprovalByTier: { low: true, medium: true, high: true },
};

export const HELD_WRITE_REFUSAL =
  'A go-live rehearsal places no broker order and makes no external write. The rehearsal refused this write.';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ResolvedInputs =
  | { ok: true; inputs: Record<string, unknown> }
  | { ok: false; missing: string }
  | { ok: false; unknown: string };

/**
 * A run step's inputs with every `{ "$rehearsal": name }` replaced by the
 * parameter. A parsed plan names no unknown parameter, because
 * `BundleRehearsalPlanSchema` refuses one. An unparsed plan can, and gets
 * `unknown`, never `missing`.
 */
export function resolveRehearsalInputs(
  inputs: Record<string, unknown>,
  parameters: RehearsalParameters,
): ResolvedInputs {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    const named = rehearsalParameterReference(value);
    if (named === undefined) {
      resolved[key] = value;
      continue;
    }
    const parameter = RehearsalParameterSchema.safeParse(named);
    if (!parameter.success) {
      return { ok: false, unknown: typeof named === 'string' ? named : JSON.stringify(named) };
    }
    const given = parameters[parameter.data];
    if (given === undefined || given === '') return { ok: false, missing: parameter.data };
    resolved[key] = given;
  }
  return { ok: true, inputs: resolved };
}

interface InstallVerdict {
  step: RehearsalStepResult;
  /** The content hash the space's install carries, set only when it equals the revision's. */
  verifiedContentHash?: string;
}

const short = (hash: string) => hash.slice(0, 12);

async function rehearseInstall(options: RehearseBundleOptions): Promise<InstallVerdict> {
  const { client, target } = options;
  const step = (outcome: RehearsalStepResult['outcome'], detail: string): InstallVerdict => ({
    step: { stepId: 'install', kind: 'install', outcome, detail },
  });
  if (options.unavailable !== undefined && options.unavailable.length > 0) {
    return step(
      'skipped',
      `The rehearsal cannot reach the platform: ${options.unavailable.join('. ')}.`,
    );
  }
  if (options.spaceId === null) {
    return step(
      'skipped',
      'No rehearsal space was named. Name the space that installed the bundle with --space.',
    );
  }
  let install = await client.readInstall(target.catalogId);
  if (!install.ok) {
    return step('skipped', `The space has not installed ${target.catalogId}: ${install.message}`);
  }
  if (install.catalogVersion !== target.version) {
    return step(
      'skipped',
      `The stack publishes ${target.catalogId} at version ${String(install.catalogVersion)}, and this revision is version ${String(target.version)}. Rehearse on a stack that runs this revision.`,
    );
  }
  if (install.catalogContentHash !== target.contentHash) {
    return step(
      'skipped',
      `The stack publishes ${target.catalogId} version ${String(target.version)} with content ${short(install.catalogContentHash)}, and this revision's content is ${short(target.contentHash)}. Rehearse on a stack that runs this revision.`,
    );
  }
  if (install.installedVersion !== target.version && options.update === true) {
    const updated = await client.applyUpdate(target.catalogId, target.version);
    if (!updated.ok) {
      return step(
        'fail',
        `The Store update from version ${String(install.installedVersion)} to ${String(target.version)} failed: ${updated.message}`,
      );
    }
    install = await client.readInstall(target.catalogId);
    if (!install.ok) return step('fail', `After the Store update: ${install.message}`);
  }
  if (install.installedVersion !== target.version) {
    return step(
      'skipped',
      `The space holds version ${String(install.installedVersion)}, not ${String(target.version)}. Apply the Store update, or rehearse with --update.`,
    );
  }
  if (install.installedContentHash !== target.contentHash) {
    return step(
      'fail',
      `The space holds version ${String(target.version)} with content ${short(install.installedContentHash)}, and this revision's content is ${short(target.contentHash)}. The space installed other content under the same version, so a run would not exercise this revision. Reinstall the bundle in the rehearsal space, then rehearse again.`,
    );
  }
  if (install.customized) {
    return step(
      'skipped',
      'The space has customized the installed bundle, so a run would exercise its copy, not the published one. Rehearse in a space whose install is pristine.',
    );
  }
  return {
    ...step(
      'pass',
      `The space holds ${target.catalogId} version ${String(target.version)} with content ${short(install.installedContentHash)}, as published.`,
    ),
    verifiedContentHash: install.installedContentHash,
  };
}

/**
 * Whether a held write was raised by the rehearsed run: by one of its
 * operation tasks, or by a tool step in the session of one of its agent tasks.
 */
export function heldWriteBelongsToRun(write: HeldWrite, runId: string, run: RehearsedRun): boolean {
  const task = WorkflowTaskOriginSchema.safeParse(write.origin);
  if (task.success) return task.data.runId === runId;
  const step = StepOriginSchema.safeParse(write.origin);
  if (!step.success) return false;
  if (step.data.runId === runId) return true;
  return run.tasks.some((t) => t.workerSessionId === step.data.sessionId);
}

async function refuseRunWrites(
  client: RehearsalClient,
  runId: string,
  run: RehearsedRun,
): Promise<number> {
  const held = (await client.listHeldWrites()).filter((w) => heldWriteBelongsToRun(w, runId, run));
  for (const write of held) await client.refuseWrite(write, HELD_WRITE_REFUSAL);
  return held.length;
}

function firstUntoleratedFailure(
  run: RehearsedRun,
  step: Extract<BundleRehearsalStep, { kind: 'run' }>,
): RehearsedTask | undefined {
  const tolerated = new Set(step.toleratedFailures.map((t) => t.taskId));
  return run.tasks.find((t) => t.status === 'failed' && !tolerated.has(t.taskId));
}

function taskFailureText(task: RehearsedTask): string {
  const why = [task.errorCode, task.failureReason].filter((s) => s !== undefined && s !== '');
  return why.length > 0 ? why.join(': ') : 'no failure reason recorded';
}

type WindowCheck =
  { open: true; date: string; timestamp: string } | { open: false; step: RehearsalStepResult };

/**
 * Read the exchange clock and calendar and decide `window` from them. A read
 * that fails skips the step, because no window was decided. A closed window
 * makes the step `not_due`.
 */
async function checkExchangeWindow(
  client: RehearsalClient,
  source: RehearsalExchangeSource,
  window: RehearsalExchangeWindow,
  base: Pick<RehearsalStepResult, 'stepId' | 'kind'>,
  tradingDay: string | undefined,
  schedule: string,
): Promise<WindowCheck> {
  const read = await client.readExchange(source);
  if (!read.ok) {
    return {
      open: false,
      step: {
        ...base,
        outcome: 'skipped',
        detail: `The rehearsal could not read the exchange clock and calendar, so window ${window} was not decided: ${read.message}`,
      },
    };
  }
  const verdict = exchangeWindowVerdict(window, read.reading, tradingDay);
  if (verdict.open) return { open: true, date: verdict.date, timestamp: read.reading.timestamp };
  const detail = `${verdict.detail} ${schedule}`;
  return {
    open: false,
    step: {
      ...base,
      outcome: 'not_due',
      detail,
      notDue: { stepId: base.stepId, window, detail, nextOpensAt: verdict.nextOpensAt },
    },
  };
}

async function rehearseRun(
  options: RehearseBundleOptions,
  step: Extract<BundleRehearsalStep, { kind: 'run' }>,
  parameters: RehearsalParameters,
): Promise<RehearsalStepResult> {
  const { client } = options;
  const base = { stepId: step.stepId, kind: 'run' as const };
  const window = options.plan.window;
  if (step.exchangeWindow !== undefined && window === undefined) {
    return {
      ...base,
      outcome: 'fail',
      detail: `The step needs the exchange window ${step.exchangeWindow}, and the plan names no window to read it from. Fix the plan.`,
    };
  }
  if (step.exchangeWindow !== undefined && window !== undefined) {
    const checked = await checkExchangeWindow(
      client,
      window.source,
      step.exchangeWindow,
      base,
      parameters.tradingDay,
      window.schedule,
    );
    if (!checked.open) return checked.step;
  }
  const resolved = resolveRehearsalInputs(step.inputs, parameters);
  if (!resolved.ok) {
    return 'unknown' in resolved
      ? {
          ...base,
          outcome: 'fail',
          detail: `The step names the rehearsal parameter ${resolved.unknown}, which does not exist. Fix the plan.`,
        }
      : {
          ...base,
          outcome: 'skipped',
          detail: `The step needs the rehearsal parameter ${resolved.missing}, which the rehearsal was not given.`,
        };
  }
  const started = await client.startRun(step.slug, step.skillCatalogId, resolved.inputs);
  if (!started.ok) {
    return 'skipped' in started
      ? { ...base, outcome: 'skipped', detail: `The run was not started: ${started.message}` }
      : { ...base, outcome: 'fail', detail: `The run did not start: ${started.message}` };
  }
  const runId = started.runId;
  const deadline = client.now().getTime() + step.timeoutMinutes * 60_000;
  let heldWrites = 0;
  let quietPauses = 0;
  let run: RehearsedRun;
  for (;;) {
    run = await client.readRun(runId);
    // The run is read first, because its agent tasks' sessions say which held writes are its own.
    const refused = await refuseRunWrites(client, runId, run);
    heldWrites += refused;
    if (TERMINAL_RUN_STATUSES.has(run.status)) break;
    if (run.status === 'paused' && refused === 0) {
      quietPauses += 1;
      // A held write parks the run until it is refused. A pause that outlives
      // two polls with nothing held waits on a person, whom no rehearsal is.
      if (quietPauses >= 2) {
        await client.cancelRun(runId, 'The go-live rehearsal cannot answer this pause.');
        return {
          ...base,
          runId,
          heldWrites,
          outcome: 'fail',
          detail: `The run paused on ${run.pausedReason ?? 'an unnamed reason'}, which no rehearsal can answer. A bundle that goes live without a person must not pause.`,
        };
      }
    } else {
      quietPauses = 0;
    }
    if (client.now().getTime() > deadline) {
      await client.cancelRun(runId, 'The go-live rehearsal timed out.');
      return {
        ...base,
        runId,
        heldWrites,
        outcome: 'fail',
        detail: `The run did not finish in ${String(step.timeoutMinutes)} minutes. The rehearsal cancelled it.`,
      };
    }
    await client.sleep(options.pollMs ?? 5_000);
  }
  const withRun = { ...base, runId, heldWrites };
  if (run.status === 'cancelled') {
    return {
      ...withRun,
      outcome: 'skipped',
      detail: 'Something other than the rehearsal cancelled the run, so it did not run to its end.',
    };
  }
  const failed = firstUntoleratedFailure(run, step);
  if (failed) {
    return {
      ...withRun,
      outcome: 'fail',
      failedTask: failed.taskId,
      detail: `Task ${failed.taskId} failed: ${taskFailureText(failed)}`,
    };
  }
  if (run.status === 'failed') {
    return {
      ...withRun,
      outcome: 'fail',
      detail: 'The run failed, and no task records the failure.',
    };
  }
  const byId = new Map(run.tasks.map((t) => [t.taskId, t]));
  const unexercised = step.requiredTasks.filter((id) => byId.get(id)?.status !== 'succeeded');
  if (unexercised.length > 0) {
    const named = unexercised
      .map((id) => `${id} (${byId.get(id)?.status ?? 'never scheduled'})`)
      .join(', ');
    return {
      ...withRun,
      outcome: 'skipped',
      detail: `The run completed without exercising ${named}. Rehearse when the run reaches them, for example on a trading day the ledger has not recorded yet.`,
    };
  }
  const toleratedSeen = step.toleratedFailures.filter(
    (t) => byId.get(t.taskId)?.status === 'failed',
  );
  const notes = [
    `The run completed, and ${step.requiredTasks.join(', ')} succeeded.`,
    ...toleratedSeen.map((t) => `${t.taskId} failed as expected: ${t.reason}`),
    heldWrites > 0
      ? `The rehearsal held and refused ${String(heldWrites)} write(s), so none reached the broker.`
      : 'The run asked for no external write.',
  ];
  return { ...withRun, outcome: 'pass', detail: notes.join(' ') };
}

/**
 * The window step of a plan that names a window, or null for one that names
 * none. An open window sets the rehearsal's trading day to the clock's date
 * where the caller named none.
 */
async function rehearseWindow(
  options: RehearseBundleOptions,
  parameters: RehearsalParameters,
): Promise<RehearsalStepResult | null> {
  const window = options.plan.window;
  if (window === undefined) return null;
  const base = { stepId: 'window', kind: 'window' as const };
  try {
    const checked = await checkExchangeWindow(
      options.client,
      window.source,
      window.startsIn,
      base,
      parameters.tradingDay,
      window.schedule,
    );
    if (!checked.open) return checked.step;
    parameters.tradingDay ??= checked.date;
    return {
      ...base,
      outcome: 'pass',
      detail: `The exchange clock reads ${checked.timestamp}, inside window ${window.startsIn}. The rehearsal's trading day is ${parameters.tradingDay}.`,
    };
  } catch (err) {
    return {
      ...base,
      outcome: 'skipped',
      detail: `The rehearsal could not read the exchange clock and calendar: ${describe(err)}`,
    };
  }
}

/**
 * Rehearse `target` as `spaceId` installed it, step by step. The result is
 * validated against `BundleRehearsalResultSchema`, so its outcome is the one
 * `deriveRehearsalOutcome` gives its steps.
 */
export async function rehearseInstalledBundle(
  options: RehearseBundleOptions,
): Promise<BundleRehearsalResult> {
  const { plan, target, client } = options;
  const startedAt = client.now().toISOString();
  const steps: RehearsalStepResult[] = [];
  const markRest = (from: number, outcome: 'skipped' | 'not_due', why: string) => {
    for (const step of plan.steps.slice(from)) {
      steps.push({ stepId: step.stepId, kind: step.kind, outcome, detail: why });
    }
  };
  const skipRest = (from: number, why: string) => {
    markRest(from, 'skipped', why);
  };

  let verdict: InstallVerdict;
  try {
    verdict = await rehearseInstall(options);
  } catch (err) {
    verdict = {
      step: {
        stepId: 'install',
        kind: 'install',
        outcome: 'skipped',
        detail: `The rehearsal could not reach the platform API: ${describe(err)}`,
      },
    };
  }
  const install = verdict.step;
  steps.push(install);

  let priorPolicy: SpaceWriteApprovalPolicy | null | undefined;
  const started: Array<{ slug: string; campaignId: string }> = [];
  const parameters: RehearsalParameters = { ...options.parameters };
  const window = install.outcome === 'pass' ? await rehearseWindow(options, parameters) : null;
  if (window !== null) steps.push(window);
  if (install.outcome !== 'pass') {
    skipRest(0, 'The installed bundle could not be rehearsed: see the install step.');
  } else if (window !== null && window.outcome !== 'pass') {
    markRest(
      0,
      window.outcome === 'not_due' ? 'not_due' : 'skipped',
      'Not started: the rehearsal did not start inside its window. See the window step.',
    );
  } else {
    try {
      priorPolicy = await client.readWritePolicy();
      await client.writeWritePolicy(REHEARSAL_WRITE_HOLD);
      steps.push({
        stepId: 'hold-writes',
        kind: 'hold_writes',
        outcome: 'pass',
        detail: 'Every write tier in the space waits for approval, which the rehearsal refuses.',
      });
    } catch (err) {
      priorPolicy = undefined;
      steps.push({
        stepId: 'hold-writes',
        kind: 'hold_writes',
        outcome: 'skipped',
        detail: `The rehearsal could not hold the space's writes, so it ran no step that could reach the broker: ${describe(err)}`,
      });
    }
    if (priorPolicy === undefined) {
      skipRest(0, 'The space’s writes could not be held: see the hold-writes step.');
    } else {
      for (const [index, step] of plan.steps.entries()) {
        try {
          if (step.kind === 'campaign_start') {
            const result = await client.startCampaign(step.slug, step.config);
            if (!result.ok) {
              steps.push({
                stepId: step.stepId,
                kind: step.kind,
                outcome: 'fail',
                detail: `The campaign did not start: ${result.message}`,
              });
              skipRest(index + 1, `The campaign of ${step.slug} did not start.`);
              break;
            }
            if (result.created) started.push({ slug: step.slug, campaignId: result.campaignId });
            steps.push({
              stepId: step.stepId,
              kind: step.kind,
              outcome: result.created ? 'pass' : 'skipped',
              detail: result.created
                ? `Campaign ${result.campaignId} started.`
                : `The space already holds campaign ${result.campaignId} with this config, so its start was not exercised. End it, then rehearse again.`,
            });
          } else {
            const ran = await rehearseRun(options, step, parameters);
            steps.push(ran);
            if (ran.outcome === 'not_due') {
              markRest(
                index + 1,
                'not_due',
                `Not started: ${step.stepId} was outside its exchange window, and the plan's steps rehearse one session in order.`,
              );
              break;
            }
          }
        } catch (err) {
          steps.push({
            stepId: step.stepId,
            kind: step.kind,
            outcome: 'skipped',
            detail: `The rehearsal lost the platform API: ${describe(err)}`,
          });
          skipRest(index + 1, 'The rehearsal lost the platform API.');
          break;
        }
      }
    }
  }

  if (priorPolicy !== undefined || started.length > 0) {
    const faults: string[] = [];
    for (const campaign of started) {
      try {
        await client.endCampaign(campaign.slug, campaign.campaignId);
      } catch (err) {
        faults.push(`campaign ${campaign.campaignId} is still active: ${describe(err)}`);
      }
    }
    if (priorPolicy !== undefined) {
      try {
        await client.writeWritePolicy(priorPolicy);
      } catch (err) {
        faults.push(`the space still holds every write for approval: ${describe(err)}`);
      }
    }
    steps.push({
      stepId: 'release',
      kind: 'release',
      outcome: faults.length === 0 ? 'pass' : 'skipped',
      detail:
        faults.length === 0
          ? 'The space’s write policy is restored, and every campaign the rehearsal started has ended.'
          : `The release did not finish: ${faults.join('. ')}.`,
    });
  }

  const derived = deriveRehearsalOutcome(steps);
  return BundleRehearsalResultSchema.parse({
    catalogId: target.catalogId,
    version: target.version,
    // Only a verified install can pass, so a pass records the hash the space carries.
    contentHash: verdict.verifiedContentHash ?? target.contentHash,
    planStepsHash: rehearsalPlanStepsHash(plan),
    spaceId: options.spaceId,
    ...derived,
    window: plan.window ?? null,
    steps,
    uncovered: plan.uncovered,
    startedAt,
    finishedAt: client.now().toISOString(),
  });
}
