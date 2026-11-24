import {
  BundleRehearsalResultSchema,
  deriveRehearsalOutcome,
  RehearsalParameterSchema,
  type BundleRehearsalPlan,
  type BundleRehearsalResult,
  type BundleRehearsalStep,
  type RehearsalParameters,
  type RehearsalStepResult,
  type SpaceWriteApprovalPolicy,
} from '@aflow/schemas';

/**
 * The go-live rehearsal (Plan 346): a bundle's operating flow, run against
 * the bundle a space installed, in that space, through the platform's own
 * API. Every step reports what it saw. A step that cannot run is skipped and
 * says why, so nothing it did not exercise reads as a pass.
 *
 * The rehearsal places no broker order and makes no other external write.
 * Before the first step it sets the space's write policy so every write tier
 * waits for approval, and it refuses each write the bundle asks for while its
 * runs are under way. The release step restores the policy.
 */

/** One task of a rehearsed run, as the run detail reports it. */
export interface RehearsedTask {
  taskId: string;
  status: string;
  failureReason?: string | undefined;
  errorCode?: string | undefined;
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

/**
 * What a rehearsal asks of the platform. The HTTP client serves it against a
 * running stack. A test serves it from memory.
 */
export interface RehearsalClient {
  /** The space's install of the listing. Not installed is `ok: false`. */
  readInstall(
    catalogId: string,
  ): Promise<
    ClientResult<{ installedVersion: number; catalogVersion: number; customized: boolean }>
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
  startRun(
    slug: string,
    skillCatalogId: string,
    inputs: Record<string, unknown>,
  ): Promise<ClientResult<{ runId: string }>>;
  readRun(runId: string): Promise<RehearsedRun>;
  cancelRun(runId: string, reason: string): Promise<void>;
  listHeldWrites(): Promise<HeldWrite[]>;
  refuseWrite(write: HeldWrite, reason: string): Promise<void>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface RehearsalTarget {
  catalogId: string;
  /** The version the catalog publishes, which the space must hold. */
  version: number;
  contentHash: string;
}

export interface RehearseBundleOptions {
  plan: BundleRehearsalPlan;
  target: RehearsalTarget;
  /** The space the bundle is installed in. Absent, nothing can run, and the install step says so. */
  spaceId: string | null;
  client: RehearsalClient;
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
  { ok: true; inputs: Record<string, unknown> } | { ok: false; missing: string };

/** A run step's inputs with every `{ "$rehearsal": name }` replaced by the parameter. */
export function resolveRehearsalInputs(
  inputs: Record<string, unknown>,
  parameters: RehearsalParameters,
): ResolvedInputs {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    const named =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)['$rehearsal']
        : undefined;
    if (named === undefined) {
      resolved[key] = value;
      continue;
    }
    const parameter = RehearsalParameterSchema.safeParse(named);
    if (!parameter.success) {
      return { ok: false, missing: typeof named === 'string' ? named : JSON.stringify(named) };
    }
    const given = parameters[parameter.data];
    if (given === undefined || given === '') return { ok: false, missing: parameter.data };
    resolved[key] = given;
  }
  return { ok: true, inputs: resolved };
}

async function rehearseInstall(options: RehearseBundleOptions): Promise<RehearsalStepResult> {
  const { client, target } = options;
  const step = (outcome: RehearsalStepResult['outcome'], detail: string): RehearsalStepResult => ({
    stepId: 'install',
    kind: 'install',
    outcome,
    detail,
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
  if (install.customized) {
    return step(
      'skipped',
      'The space has customized the installed bundle, so a run would exercise its copy, not the published one. Rehearse in a space whose install is pristine.',
    );
  }
  return step(
    'pass',
    `The space holds ${target.catalogId} version ${String(target.version)}, as published.`,
  );
}

async function refuseHeldWrites(client: RehearsalClient): Promise<number> {
  const held = await client.listHeldWrites();
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

async function rehearseRun(
  options: RehearseBundleOptions,
  step: Extract<BundleRehearsalStep, { kind: 'run' }>,
): Promise<RehearsalStepResult> {
  const { client } = options;
  const base = { stepId: step.stepId, kind: 'run' as const };
  const resolved = resolveRehearsalInputs(step.inputs, options.parameters);
  if (!resolved.ok) {
    return {
      ...base,
      outcome: 'skipped',
      detail: `The step needs the rehearsal parameter ${resolved.missing}, which the rehearsal was not given.`,
    };
  }
  const started = await client.startRun(step.slug, step.skillCatalogId, resolved.inputs);
  if (!started.ok) {
    return { ...base, outcome: 'fail', detail: `The run did not start: ${started.message}` };
  }
  const runId = started.runId;
  const deadline = client.now().getTime() + step.timeoutMinutes * 60_000;
  let heldWrites = 0;
  let quietPauses = 0;
  let run: RehearsedRun;
  for (;;) {
    const refused = await refuseHeldWrites(client);
    heldWrites += refused;
    run = await client.readRun(runId);
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
  const skipRest = (from: number, why: string) => {
    for (const step of plan.steps.slice(from)) {
      steps.push({ stepId: step.stepId, kind: step.kind, outcome: 'skipped', detail: why });
    }
  };

  let install: RehearsalStepResult;
  try {
    install = await rehearseInstall(options);
  } catch (err) {
    install = {
      stepId: 'install',
      kind: 'install',
      outcome: 'skipped',
      detail: `The rehearsal could not reach the platform API: ${describe(err)}`,
    };
  }
  steps.push(install);

  let priorPolicy: SpaceWriteApprovalPolicy | null | undefined;
  const started: Array<{ slug: string; campaignId: string }> = [];
  if (install.outcome !== 'pass') {
    skipRest(0, 'The installed bundle could not be rehearsed: see the install step.');
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
            steps.push(await rehearseRun(options, step));
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
    contentHash: target.contentHash,
    spaceId: options.spaceId,
    ...derived,
    steps,
    uncovered: plan.uncovered,
    startedAt,
    finishedAt: client.now().toISOString(),
  });
}
