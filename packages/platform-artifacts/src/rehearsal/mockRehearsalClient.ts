import type { SpaceWriteApprovalPolicy, WorkflowStateVariable, WorkflowTask } from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import type { ExchangeReading } from './exchangeWindow.js';
import type { PublishedListing } from './publicationGate.js';
import type {
  ClientResult,
  HeldWrite,
  RehearsalClient,
  RehearsedRun,
  RehearsedTask,
  RunDeclined,
} from './rehearseBundle.js';

/**
 * The smoke run's client (`yarn store:smoke`). It serves the rehearsal engine
 * from memory: no space, no credential, no network and no broker. Each run
 * executes the skill's own task graph through a task runner, and fixtures
 * answer every integration and agent task. The platform's own decide and
 * derive tasks run as the orchestrator runs them.
 */

export interface SmokeCampaign {
  campaignId: string;
  config: Readonly<Record<string, unknown>>;
}

/** What a fixture answering one task can read besides the task's input. */
export interface SmokeTaskContext {
  skillCatalogId: string;
  runInputs: Readonly<Record<string, unknown>>;
  /** Each campaign the smoke run holds, by workflow slug. */
  campaigns: Readonly<Record<string, SmokeCampaign>>;
}

/** A fixture's answer to one task: its raw output, or the failure its row records. */
export type SmokeTaskAnswer = { output: Record<string, unknown> } | { failure: string };

/** Answers a skill's tasks. Undefined means no fixture answers the task, so it fails saying so. */
export type SmokeSkillFixture = (
  task: WorkflowTask,
  input: Record<string, unknown>,
  context: SmokeTaskContext,
) => SmokeTaskAnswer | undefined;

export interface BundleSmokeFixtures {
  catalogId: string;
  /** The exchange clock and calendar read, which decides every window the plan names. */
  exchange: ExchangeReading;
  /** The values the plan's `$rehearsal` inputs name, apart from the trading day. */
  parameters: Readonly<Record<string, string>>;
  /** The answers to each skill's tasks, by skill catalog id. */
  skills: Readonly<Record<string, SmokeSkillFixture>>;
  /** Skills no mock can run, each with its reason. A step that runs one is skipped. */
  unmockable?: Readonly<Record<string, string>>;
}

/** What a run of a skill's tasks reports, as `runSkillTasks` in `@aflow/cybernetic-runtime` gives it. */
export interface SkillTaskRun {
  readonly statuses: ReadonlyMap<string, string>;
  readonly failures: ReadonlyMap<string, string>;
}

/**
 * Runs a skill's task graph in memory. `@aflow/cybernetic-runtime` holds the
 * scheduler, and it reads this package, so the caller hands the runner in.
 */
export interface SkillTaskRunner<Failure> {
  runSkillTasks(
    tasks: readonly WorkflowTask[],
    runInputs: Readonly<Record<string, unknown>>,
    answer: (taskId: string, input: Record<string, unknown>) => Record<string, unknown> | Failure,
    stateVariables?: readonly WorkflowStateVariable[],
    context?: { runId?: string; campaign?: Readonly<Record<string, unknown>> },
  ): SkillTaskRun;
  failWith(reason: string): Failure;
}

export interface MockRehearsalClientOptions<Failure> {
  fixtures: BundleSmokeFixtures;
  /** The version and content hash the catalog publishes, which the mock space holds. */
  published: PublishedListing;
  runner: SkillTaskRunner<Failure>;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A uuid-shaped id, because a rehearsal result holds run and campaign ids as uuids. */
const smokeId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export class MockRehearsalClient<Failure> implements RehearsalClient {
  private readonly fixtures: BundleSmokeFixtures;
  private readonly published: PublishedListing;
  private readonly runner: SkillTaskRunner<Failure>;
  private readonly runs = new Map<string, RehearsedRun>();
  private readonly campaigns = new Map<string, SmokeCampaign>();
  private campaignCount = 0;
  private policy: SpaceWriteApprovalPolicy | null = null;
  private clock: number;

  constructor(options: MockRehearsalClientOptions<Failure>) {
    this.fixtures = options.fixtures;
    this.published = options.published;
    this.runner = options.runner;
    this.clock = Date.parse(options.fixtures.exchange.timestamp);
  }

  /** The run the mock executed, by id. */
  run(runId: string): RehearsedRun | undefined {
    return this.runs.get(runId);
  }

  readInstall() {
    return Promise.resolve({
      ok: true as const,
      installedVersion: this.published.version,
      catalogVersion: this.published.version,
      installedContentHash: this.published.contentHash,
      catalogContentHash: this.published.contentHash,
      customized: false,
    });
  }

  applyUpdate(): Promise<ClientResult<object>> {
    return Promise.resolve({ ok: true });
  }

  readWritePolicy() {
    return Promise.resolve(this.policy);
  }

  writeWritePolicy(policy: SpaceWriteApprovalPolicy | null) {
    this.policy = policy;
    return Promise.resolve();
  }

  startCampaign(
    slug: string,
    config: Record<string, unknown>,
  ): Promise<ClientResult<{ campaignId: string; created: boolean }>> {
    const skill = this.bundleSkills().find((s) => s.bundle.workflow.slug === slug);
    if (skill === undefined) {
      return Promise.resolve({ ok: false, message: `The bundle has no skill with slug ${slug}.` });
    }
    if (skill.bundle.manifest.campaign === undefined) {
      return Promise.resolve({ ok: false, message: `${slug} declares no campaign contract.` });
    }
    const campaign = { campaignId: smokeId(1_000 + this.campaignCount), config };
    this.campaignCount += 1;
    this.campaigns.set(slug, campaign);
    return Promise.resolve({ ok: true, campaignId: campaign.campaignId, created: true });
  }

  endCampaign(slug: string) {
    this.campaigns.delete(slug);
    return Promise.resolve();
  }

  startRun(
    slug: string,
    skillCatalogId: string,
    inputs: Record<string, unknown>,
  ): Promise<ClientResult<{ runId: string }> | RunDeclined> {
    return Promise.resolve(this.execute(slug, skillCatalogId, inputs));
  }

  private bundleSkills() {
    const bundle = getSkillBundleEntry(this.fixtures.catalogId);
    return (bundle?.skillCatalogIds ?? []).flatMap((id) => {
      const entry = getSkillCatalogEntry(id);
      return entry ? [entry] : [];
    });
  }

  private execute(
    slug: string,
    skillCatalogId: string,
    inputs: Record<string, unknown>,
  ): ClientResult<{ runId: string }> | RunDeclined {
    const unmockable = this.fixtures.unmockable?.[skillCatalogId];
    if (unmockable !== undefined) return { ok: false, skipped: true, message: unmockable };
    const skill = this.bundleSkills().find((s) => s.catalogId === skillCatalogId);
    if (skill === undefined) {
      return {
        ok: false,
        message: `${this.fixtures.catalogId} carries no skill ${skillCatalogId}.`,
      };
    }
    const wf = skill.bundle.workflow;
    if (wf.slug !== slug) {
      return { ok: false, message: `${skillCatalogId} has slug ${wf.slug}, not ${slug}.` };
    }
    const declared = new Map((wf.runInputs ?? []).map((r) => [r.id, r]));
    const undeclared = Object.keys(inputs).filter((k) => !declared.has(k));
    if (undeclared.length > 0) {
      return { ok: false, message: `${slug} declares no run input ${undeclared.join(', ')}.` };
    }
    const missing = [...declared.values()].filter((r) => r.required && !(r.id in inputs));
    if (missing.length > 0) {
      return {
        ok: false,
        message: `${slug} requires the run input ${missing.map((r) => r.id).join(', ')}.`,
      };
    }
    const fixture = this.fixtures.skills[skillCatalogId];
    if (fixture === undefined) {
      return {
        ok: false,
        skipped: true,
        message: `No smoke fixture answers the tasks of ${skillCatalogId}.`,
      };
    }
    const tasks = wf.tasks;
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    const context: SmokeTaskContext = {
      skillCatalogId,
      runInputs: inputs,
      campaigns: Object.fromEntries(this.campaigns),
    };
    const runId = smokeId(this.runs.size + 1);
    const campaign = this.campaigns.get(slug);
    let ran: SkillTaskRun;
    try {
      ran = this.runner.runSkillTasks(
        tasks,
        inputs,
        (taskId, input) => {
          const task = byId.get(taskId)!;
          const answer = fixture(task, input, context);
          if (answer === undefined) {
            return this.runner.failWith(
              `No smoke fixture answers task ${taskId} (${task.operation ?? 'agent'}).`,
            );
          }
          return 'output' in answer ? answer.output : this.runner.failWith(answer.failure);
        },
        wf.stateVariables,
        campaign === undefined ? { runId } : { runId, campaign: campaign.config },
      );
    } catch (err) {
      return { ok: false, message: `The task graph of ${slug} did not run: ${describe(err)}` };
    }
    const reported: RehearsedTask[] = tasks.map((t) => ({
      taskId: t.taskId,
      status: ran.statuses.get(t.taskId) ?? 'pending',
      failureReason: ran.failures.get(t.taskId),
    }));
    // A failed required task fails the run, as the orchestrator fails it. An optional one does not.
    const failed = reported.some(
      (t) => t.status === 'failed' && byId.get(t.taskId)?.optional !== true,
    );
    this.runs.set(runId, { status: failed ? 'failed' : 'completed', tasks: reported });
    return { ok: true, runId };
  }

  readRun(runId: string): Promise<RehearsedRun> {
    const run = this.runs.get(runId);
    return run ? Promise.resolve(run) : Promise.reject(new Error(`No smoke run ${runId}.`));
  }

  cancelRun(runId: string) {
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, status: 'cancelled' });
    return Promise.resolve();
  }

  /** No mock integration places a write, so the space holds none. */
  listHeldWrites(): Promise<HeldWrite[]> {
    return Promise.resolve([]);
  }

  refuseWrite() {
    return Promise.resolve();
  }

  readExchange(): Promise<ClientResult<{ reading: ExchangeReading }>> {
    return Promise.resolve({ ok: true, reading: this.fixtures.exchange });
  }

  now(): Date {
    return new Date(this.clock);
  }

  sleep(ms: number): Promise<void> {
    this.clock += ms;
    return Promise.resolve();
  }
}
