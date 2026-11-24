import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillTaskRunner as runner } from '@aflow/cybernetic-runtime';
import { computeStoreCatalogHashes } from '../storeCatalog/index.js';
import { MockRehearsalClient, type BundleSmokeFixtures } from './mockRehearsalClient.js';
import { ALPACA_REHEARSAL_CAMPAIGN, ALPACA_THESIS_TRADING_REHEARSAL } from './plans.js';
import { smokeBundle } from './smokeBundle.js';
import { getBundleSmokeFixtures } from './smokeFixtures/index.js';

const CATALOG_ID = 'alpaca-thesis-trading';
const published = computeStoreCatalogHashes()[CATALOG_ID]!;

function fixtures(change: (f: BundleSmokeFixtures) => BundleSmokeFixtures = (f) => f) {
  return change(getBundleSmokeFixtures(CATALOG_ID)!);
}

const client = (f = fixtures()) => new MockRehearsalClient({ fixtures: f, published, runner });

const step = (result: Awaited<ReturnType<typeof smokeBundle>>, stepId: string) =>
  result.steps.find((s) => s.stepId === stepId);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MockRehearsalClient', () => {
  it('runs the skill’s own task graph, answering each task from its fixtures', async () => {
    const mock = client();
    await mock.startCampaign('daily-trading-cycle', { ...ALPACA_REHEARSAL_CAMPAIGN });
    const started = await mock.startRun('daily-trading-cycle', 'daily-trading-cycle', {
      slot: 'after_close',
    });
    expect(started.ok).toBe(true);
    const run = mock.run(started.ok ? started.runId : '')!;
    expect(run.status).toBe('completed');
    // The bundle ships no market-calendar integration, so only that optional read fails.
    expect(run.tasks.filter((t) => t.status === 'failed').map((t) => t.taskId)).toEqual([
      'ingest-calendar',
    ]);
    const status = new Map(run.tasks.map((t) => [t.taskId, t.status]));
    // The derive and decide tasks run as the orchestrator runs them, not from a fixture.
    expect(status.get('gather-regime')).toBe('succeeded');
    expect(status.get('regime-state')).toBe('succeeded');
    // The close report reads the cycle doc the same run wrote.
    expect(status.get('read-close-cycle-doc')).toBe('succeeded');
    expect(status.get('write-close-report')).toBe('succeeded');
  });

  it('fails a task no fixture answers, and says so', async () => {
    const failed = fixtures((f) => ({
      ...f,
      skills: { ...f.skills, 'trading-reflection': () => undefined },
    }));
    const bare = client(failed);
    const refused = await bare.startRun('trading-reflection', 'trading-reflection', {
      bindingId: 'f',
    });
    const failedRun = bare.run(refused.ok ? refused.runId : '')!;
    expect(failedRun.status).toBe('failed');
    expect(failedRun.tasks.find((t) => t.taskId === 'ingest-clock')).toMatchObject({
      status: 'failed',
      failureReason: 'No smoke fixture answers task ingest-clock (api.http.call).',
    });
  });

  it('refuses a skill the bundle does not carry, a wrong slug and an undeclared input', async () => {
    const mock = client();
    const foreign = await mock.startRun('pr-shepherd', 'pr-shepherd', {});
    expect(foreign).toEqual({
      ok: false,
      message: 'alpaca-thesis-trading carries no skill pr-shepherd.',
    });
    expect(await mock.startRun('desk', 'desk-charter', { bindingId: 'f' })).toMatchObject({
      ok: false,
      message: 'desk-charter has slug desk-charter, not desk.',
    });
    expect(
      await mock.startRun('desk-charter', 'desk-charter', { bindingId: 'f', extra: 1 }),
    ).toMatchObject({ ok: false, message: 'desk-charter declares no run input extra.' });
    expect(await mock.startRun('desk-charter', 'desk-charter', {})).toMatchObject({
      ok: false,
      message: 'desk-charter requires the run input bindingId.',
    });
  });

  it('starts a campaign only for a skill of the bundle that declares one', async () => {
    const mock = client();
    expect(await mock.startCampaign('desk-charter', {})).toMatchObject({ ok: false });
    expect(await mock.startCampaign('daily-trading-cycle', {})).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it('reads the exchange from the fixture, and its clock moves only when the engine sleeps', async () => {
    const f = fixtures();
    const mock = client(f);
    const read = await mock.readExchange();
    expect(read).toEqual({ ok: true, reading: f.exchange });
    const at = mock.now().getTime();
    expect(at).toBe(Date.parse(f.exchange.timestamp));
    await mock.sleep(5_000);
    expect(mock.now().getTime()).toBe(at + 5_000);
  });
});

describe('the smoke run', () => {
  it('runs the plan end to end with no network', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('the smoke run reached the network')));
    vi.stubGlobal('fetch', fetch);
    const result = await smokeBundle(CATALOG_ID, runner);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.outcome).toBe('pass');
    expect(result.steps.map((s) => s.stepId)).toEqual([
      'install',
      'window',
      'hold-writes',
      ...ALPACA_THESIS_TRADING_REHEARSAL.steps.map((s) => s.stepId),
      'release',
    ]);
    for (const step of result.steps) {
      expect(step.detail.startsWith('Mock run, against fixtures.')).toBe(true);
      expect(step.detail).not.toMatch(/The space (holds|’s write policy)/);
    }
  });

  it('fails the step whose run a task fails, naming the task', async () => {
    const f = fixtures((base) => ({
      ...base,
      skills: {
        ...base.skills,
        'daily-trading-cycle': (task, input, context) =>
          task.taskId === 'decide'
            ? { failure: 'The model answered no decision.' }
            : base.skills['daily-trading-cycle']!(task, input, context),
      },
    }));
    const result = await smokeBundle(CATALOG_ID, runner, f);
    expect(result.outcome).toBe('fail');
    expect(result.failingStep).toEqual({
      stepId: 'cycle-pre-market',
      detail: 'Task decide failed: The model answered no decision.',
    });
  });

  it('fails the step whose agent-task fixture breaks the task’s output contract, naming the task', async () => {
    const f = fixtures((base) => ({
      ...base,
      skills: {
        ...base.skills,
        'daily-trading-cycle': (task, input, context) => {
          const answer = base.skills['daily-trading-cycle']!(task, input, context);
          if (task.taskId !== 'decide' || answer === undefined || !('output' in answer)) {
            return answer;
          }
          const { theses: _dropped, ...rest } = answer.output;
          return { output: { ...rest, projectedGrossExposurePct: 'none' } };
        },
      },
    }));
    const result = await smokeBundle(CATALOG_ID, runner, f);
    expect(result.outcome).toBe('fail');
    expect(result.failingStep).toEqual({
      stepId: 'cycle-pre-market',
      detail:
        "Task decide failed: The smoke fixture's output for task decide breaks its outputContract.schema: " +
        "<root>: must have required property 'theses'; /projectedGrossExposurePct: must be number.",
    });
  });

  it('skips a step whose skill no mock can run, with its reason, and does not pass', async () => {
    const reason = 'It needs a real exchange clock.';
    const f = fixtures((base) => ({ ...base, unmockable: { 'trading-reflection': reason } }));
    const result = await smokeBundle(CATALOG_ID, runner, f);
    expect(step(result, 'trading-reflection')).toMatchObject({
      outcome: 'skipped',
      detail: `The run was not started: ${reason}`,
    });
    expect(step(result, 'desk-charter')?.outcome).toBe('pass');
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toContain(reason);
  });

  it('skips a step whose skill has no fixtures, never passing it', async () => {
    const f = fixtures((base) => {
      const { 'desk-charter': _absent, ...skills } = base.skills;
      return { ...base, skills };
    });
    const result = await smokeBundle(CATALOG_ID, runner, f);
    expect(step(result, 'desk-charter')).toMatchObject({
      outcome: 'skipped',
      detail: 'The run was not started: No smoke fixture answers the tasks of desk-charter.',
    });
    expect(result.outcome).toBe('skipped');
  });
});
