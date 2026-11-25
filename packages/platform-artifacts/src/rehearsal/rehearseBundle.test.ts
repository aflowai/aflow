import { describe, expect, it } from 'vitest';
import {
  BundleRehearsalPlanSchema,
  BundleRehearsalResultSchema,
  deriveRehearsalOutcome,
  rehearsalPlanStepsHash,
  type BundleRehearsalPlan,
  type SpaceWriteApprovalPolicy,
  WRITE_HOLD_EVERY_TIER,
} from '@aflow/schemas';
import { exchangeWindowVerdict } from './exchangeWindow.js';
import {
  HELD_WRITE_REFUSAL,
  rehearseInstalledBundle,
  resolveRehearsalInputs,
  type HeldWrite,
  type RehearsalClient,
  type RehearsedRun,
} from './rehearseBundle.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const TARGET = { catalogId: 'demo-bundle', version: 7, contentHash: 'abc123' };

const PLAN: BundleRehearsalPlan = BundleRehearsalPlanSchema.parse({
  catalogId: 'demo-bundle',
  gateFromVersion: 1,
  steps: [
    { kind: 'campaign_start', stepId: 'start-campaign', slug: 'cycle', config: { name: 'r' } },
    {
      kind: 'run',
      stepId: 'cycle-open',
      slug: 'cycle',
      skillCatalogId: 'cycle',
      inputs: { slot: 'open' },
      timeoutMinutes: 5,
      requiredTasks: ['decide', 'record'],
      toleratedFailures: [{ taskId: 'calendar', reason: 'No calendar source.' }],
    },
    {
      kind: 'run',
      stepId: 'reflection',
      slug: 'reflect',
      skillCatalogId: 'reflect',
      inputs: { bindingId: { $rehearsal: 'folderBindingId' } },
      timeoutMinutes: 5,
      requiredTasks: ['write'],
      toleratedFailures: [],
    },
  ],
  uncovered: [{ skillCatalogId: 'review', reason: 'It needs a closed week.' }],
});

const ok = (tasks: Record<string, string>, status = 'completed'): RehearsedRun => ({
  status,
  tasks: Object.entries(tasks).map(([taskId, s]) => ({ taskId, status: s })),
});

const INSTALLED = {
  ok: true as const,
  installedVersion: 7,
  catalogVersion: 7,
  installedContentHash: TARGET.contentHash,
  catalogContentHash: TARGET.contentHash,
  customized: false,
};

const AGENT_SESSION = '44444444-4444-4444-8444-444444444444';

interface FakeOptions {
  install?: Awaited<ReturnType<RehearsalClient['readInstall']>>;
  /** What each slug's run reads as, poll after poll; the last repeats. */
  runs?: Record<string, RehearsedRun[]>;
  /** Writes the operation tasks of a slug's run hold once it starts. */
  held?: Record<string, number>;
  /** Writes the agent session of a slug's run holds once it starts. */
  heldBySession?: Record<string, number>;
  /** Writes others raised in the space, open before the rehearsal starts. */
  foreign?: HeldWrite[];
  campaign?: Awaited<ReturnType<RehearsalClient['startCampaign']>>;
  unreachable?: boolean;
  /** What each exchange read returns, read after read; the last repeats. */
  exchange?: Array<Awaited<ReturnType<RehearsalClient['readExchange']>>>;
}

function fakeClient(options: FakeOptions = {}) {
  let clock = Date.parse('2026-11-24T14:00:00Z');
  let policy: SpaceWriteApprovalPolicy | null = { requireApprovalByTier: { high: true } };
  const policies: Array<SpaceWriteApprovalPolicy | null> = [];
  const ended: string[] = [];
  const started: Array<{ slug: string; inputs: Record<string, unknown> }> = [];
  const refused: string[] = [];
  const cancelled: string[] = [];
  const polls = new Map<string, number>();
  let exchangeReads = 0;
  let open: HeldWrite[] = [...(options.foreign ?? [])];
  const client: RehearsalClient = {
    readInstall: () =>
      options.unreachable
        ? Promise.reject(new Error('fetch failed'))
        : Promise.resolve(options.install ?? INSTALLED),
    applyUpdate: () => Promise.resolve({ ok: true }),
    readWritePolicy: () => Promise.resolve(policy),
    writeWritePolicy: (next) => {
      policy = next;
      policies.push(next);
      return Promise.resolve();
    },
    startCampaign: () =>
      Promise.resolve(options.campaign ?? { ok: true, campaignId: CAMPAIGN, created: true }),
    endCampaign: (_slug, id) => {
      ended.push(id);
      return Promise.resolve();
    },
    startRun: (slug, _catalogId, inputs) => {
      started.push({ slug, inputs });
      const runId = `33333333-3333-4333-8333-${String(started.length).padStart(12, '0')}`;
      const byTask = Array.from({ length: options.held?.[slug] ?? 0 }, (_, i) => ({
        id: `write:${slug}:${String(i)}`,
        origin: { type: 'workflow_task', runId, taskId: 'execute-orders', pauseVersion: 1 },
        title: 'POST /orders',
      }));
      const bySession = Array.from({ length: options.heldBySession?.[slug] ?? 0 }, (_, i) => ({
        id: `session-write:${slug}:${String(i)}`,
        origin: {
          type: 'step',
          runId: '55555555-5555-4555-8555-555555555555',
          stepExecutionId: `step-${String(i)}`,
          sessionId: AGENT_SESSION,
          pauseVersion: 1,
          operationId: 'api.call.invoke',
        },
        title: 'POST /orders',
      }));
      open = [...open, ...byTask, ...bySession];
      return Promise.resolve({ ok: true as const, runId });
    },
    readRun: (runId) => {
      const slug = started[Number(runId.slice(-12)) - 1]!.slug;
      const seq = options.runs?.[slug] ?? [
        ok({ decide: 'succeeded', record: 'succeeded', write: 'succeeded' }),
      ];
      const n = polls.get(runId) ?? 0;
      polls.set(runId, n + 1);
      return Promise.resolve(seq[Math.min(n, seq.length - 1)]!);
    },
    cancelRun: (runId) => {
      cancelled.push(runId);
      return Promise.resolve();
    },
    listHeldWrites: () => Promise.resolve([...open]),
    refuseWrite: (write, reason) => {
      expect(reason).toBe(HELD_WRITE_REFUSAL);
      refused.push(write.id);
      open = open.filter((w) => w.id !== write.id);
      return Promise.resolve();
    },
    readExchange: () => {
      exchangeReads += 1;
      const seq = options.exchange ?? [{ ok: false as const, message: 'no exchange in this fake' }];
      return Promise.resolve(seq[Math.min(exchangeReads - 1, seq.length - 1)]!);
    },
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  };
  return {
    client,
    policies,
    ended,
    started,
    refused,
    cancelled,
    policy: () => policy,
    open: () => open,
    exchangeReads: () => exchangeReads,
  };
}

const rehearse = (fake: ReturnType<typeof fakeClient>, extra: { folder?: string } = {}) =>
  rehearseInstalledBundle({
    plan: PLAN,
    target: TARGET,
    spaceId: SPACE,
    client: fake.client,
    parameters: {
      tradingDay: '2026-11-24',
      ...(extra.folder !== undefined ? { folderBindingId: extra.folder } : {}),
    },
    pollMs: 1_000,
  });

describe('the go-live rehearsal', () => {
  it('passes when every step ran and passed, and holds then restores the space’s writes', async () => {
    const fake = fakeClient({ held: { cycle: 2 } });
    const result = await rehearse(fake, { folder: 'folder-1' });
    expect(result.outcome).toBe('pass');
    expect(result.steps.map((s) => [s.stepId, s.outcome])).toEqual([
      ['install', 'pass'],
      ['hold-writes', 'pass'],
      ['start-campaign', 'pass'],
      ['cycle-open', 'pass'],
      ['reflection', 'pass'],
      ['release', 'pass'],
    ]);
    expect(fake.policies).toEqual([
      WRITE_HOLD_EVERY_TIER,
      { requireApprovalByTier: { high: true } },
    ]);
    expect(fake.refused).toEqual(['write:cycle:0', 'write:cycle:1']);
    expect(result.steps.find((s) => s.stepId === 'cycle-open')?.heldWrites).toBe(2);
    expect(fake.ended).toEqual([CAMPAIGN]);
    expect(fake.started[1]?.inputs).toEqual({ bindingId: 'folder-1' });
    expect(result.uncovered).toEqual(PLAN.uncovered);
    expect(result.contentHash).toBe(TARGET.contentHash);
    expect(result.planStepsHash).toBe(rehearsalPlanStepsHash(PLAN));
    expect(BundleRehearsalResultSchema.safeParse(result).success).toBe(true);
  });

  it('a space that installed other content under the version fails before any step runs', async () => {
    const fake = fakeClient({ install: { ...INSTALLED, installedContentHash: 'older-content' } });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('fail');
    expect(result.failingStep?.stepId).toBe('install');
    expect(result.failingStep?.detail).toContain('installed other content under the same version');
    expect(fake.policies).toEqual([]);
    expect(fake.started).toEqual([]);
    expect(result.contentHash).toBe(TARGET.contentHash);
  });

  it('a stack whose catalog carries other content at the version is skipped', async () => {
    const fake = fakeClient({ install: { ...INSTALLED, catalogContentHash: 'other-revision' } });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toContain('Rehearse on a stack that runs this revision');
    expect(fake.started).toEqual([]);
  });

  it('refuses only the writes its own runs raised, and leaves others in the space alone', async () => {
    const foreign: HeldWrite[] = [
      {
        id: 'step:operator-browser',
        origin: {
          type: 'step',
          runId: '66666666-6666-4666-8666-666666666666',
          stepExecutionId: 'browser-step',
          sessionId: '77777777-7777-4777-8777-777777777777',
          pauseVersion: 1,
          operationId: 'browser.page.act',
        },
        title: 'Click Submit',
      },
      {
        id: 'workflow_task:other-run',
        origin: {
          type: 'workflow_task',
          runId: '88888888-8888-4888-8888-888888888888',
          taskId: 'post',
          pauseVersion: 1,
        },
        title: 'POST /messages',
      },
    ];
    const fake = fakeClient({
      foreign,
      held: { cycle: 1 },
      heldBySession: { cycle: 1 },
      runs: {
        cycle: [
          {
            status: 'completed',
            tasks: [
              { taskId: 'decide', status: 'succeeded', workerSessionId: AGENT_SESSION },
              { taskId: 'record', status: 'succeeded' },
            ],
          },
        ],
      },
    });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('pass');
    expect(fake.refused).toEqual(['write:cycle:0', 'session-write:cycle:0']);
    expect(fake.open()).toEqual(foreign);
  });

  it('fails naming the step and the task that failed, and still releases the space', async () => {
    const fake = fakeClient({
      runs: {
        cycle: [
          {
            status: 'completed',
            tasks: [
              {
                taskId: 'decide',
                status: 'failed',
                errorCode: 'OUTPUT_TRUNCATED',
                failureReason: 'ran out of output',
              },
              { taskId: 'record', status: 'succeeded' },
            ],
          },
        ],
      },
    });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('fail');
    expect(result.failingStep).toEqual({
      stepId: 'cycle-open',
      detail: 'Task decide failed: OUTPUT_TRUNCATED: ran out of output',
    });
    expect(result.steps.find((s) => s.stepId === 'cycle-open')?.failedTask).toBe('decide');
    expect(result.steps.at(-1)).toMatchObject({ stepId: 'release', outcome: 'pass' });
    expect(fake.policy()).toEqual({ requireApprovalByTier: { high: true } });
  });

  it('a tolerated failure does not fail the step, and the detail names it', async () => {
    const fake = fakeClient({
      runs: { cycle: [ok({ calendar: 'failed', decide: 'succeeded', record: 'succeeded' })] },
    });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('pass');
    expect(result.steps.find((s) => s.stepId === 'cycle-open')?.detail).toContain(
      'calendar failed as expected: No calendar source.',
    );
  });

  it('a run that skips a required task is skipped, never passed', async () => {
    const fake = fakeClient({ runs: { cycle: [ok({ decide: 'skipped', record: 'succeeded' })] } });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toContain('decide (skipped)');
  });

  it('a step whose parameter the rehearsal was not given is skipped and names it', async () => {
    const result = await rehearse(fakeClient());
    expect(result.outcome).toBe('skipped');
    expect(result.steps.find((s) => s.stepId === 'reflection')).toMatchObject({
      outcome: 'skipped',
      detail: expect.stringContaining('folderBindingId'),
    });
  });

  it('an unreachable API skips every step, and holds nothing', async () => {
    const fake = fakeClient({ unreachable: true });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toBe(
      'install: The rehearsal could not reach the platform API: fetch failed',
    );
    expect(result.steps.every((s) => s.outcome === 'skipped')).toBe(true);
    expect(fake.policies).toEqual([]);
  });

  it('a space that holds another version is skipped, and says how to rehearse', async () => {
    const result = await rehearse(
      fakeClient({
        install: { ...INSTALLED, installedVersion: 6 },
      }),
      { folder: 'f' },
    );
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toContain('holds version 6, not 7');
  });

  it('no space named is skipped, and asks for one', async () => {
    const fake = fakeClient();
    const result = await rehearseInstalledBundle({
      plan: PLAN,
      target: TARGET,
      spaceId: null,
      client: fake.client,
      parameters: {},
    });
    expect(result.outcome).toBe('skipped');
    expect(result.spaceId).toBeNull();
    expect(result.skipReason).toContain('--space');
  });

  it('a campaign that does not start fails, and no run starts', async () => {
    const fake = fakeClient({
      campaign: { ok: false, message: 'CAMPAIGN_START_CHECK_REFUSED: TSLA has 3 sessions' },
    });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.outcome).toBe('fail');
    expect(result.failingStep?.stepId).toBe('start-campaign');
    expect(fake.started).toEqual([]);
    expect(result.steps.filter((s) => s.kind === 'run').every((s) => s.outcome === 'skipped')).toBe(
      true,
    );
    expect(fake.ended).toEqual([]);
  });

  it('a run that pauses on a person fails and is cancelled', async () => {
    const fake = fakeClient({
      runs: { cycle: [{ status: 'paused', pausedReason: 'human_input', tasks: [] }] },
    });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.failingStep).toMatchObject({ stepId: 'cycle-open' });
    expect(result.failingStep?.detail).toContain('human_input');
    expect(fake.cancelled).toHaveLength(1);
  });

  it('a run that outlives its timeout fails and is cancelled', async () => {
    const fake = fakeClient({ runs: { cycle: [{ status: 'running', tasks: [] }] } });
    const result = await rehearse(fake, { folder: 'f' });
    expect(result.failingStep?.detail).toBe(
      'The run did not finish in 5 minutes. The rehearsal cancelled it.',
    );
    expect(fake.cancelled).toHaveLength(1);
  });
});

const SOURCE = { apiId: 'broker', clockEndpointId: 'clock', calendarEndpointId: 'calendar' };
const WINDOW_PLAN: BundleRehearsalPlan = BundleRehearsalPlanSchema.parse({
  ...PLAN,
  window: { source: SOURCE, startsIn: 'session_closed', schedule: 'Start after the close.' },
  steps: [
    PLAN.steps[0],
    {
      ...PLAN.steps[1],
      inputs: { slot: 'open', day: { $rehearsal: 'tradingDay' } },
      exchangeWindow: 'session_day',
    },
    { ...PLAN.steps[2], exchangeWindow: 'session_closed' },
  ],
});
const SESSIONS = [
  { date: '2026-11-24', open: '09:30', close: '16:00' },
  { date: '2026-11-25', open: '09:30', close: '16:00' },
  { date: '2026-11-27', open: '09:30', close: '13:00' },
  { date: '2026-11-30', open: '09:30', close: '16:00' },
];
const reading = (timestamp: string, isOpen = false) => ({
  ok: true as const,
  reading: { timestamp, isOpen, sessions: SESSIONS },
});
const AFTER_CLOSE = reading('2026-11-24T16:30:00.000-05:00');

const rehearseInWindow = (fake: ReturnType<typeof fakeClient>) =>
  rehearseInstalledBundle({
    plan: WINDOW_PLAN,
    target: TARGET,
    spaceId: SPACE,
    client: fake.client,
    parameters: { folderBindingId: 'f' },
    pollMs: 1_000,
  });

describe('the exchange window', () => {
  it('passes after the close, and takes the trading day from the exchange clock', async () => {
    const fake = fakeClient({ exchange: [AFTER_CLOSE] });
    const result = await rehearseInWindow(fake);
    expect(result.outcome).toBe('pass');
    expect(result.steps.map((s) => [s.stepId, s.outcome])).toEqual([
      ['install', 'pass'],
      ['window', 'pass'],
      ['hold-writes', 'pass'],
      ['start-campaign', 'pass'],
      ['cycle-open', 'pass'],
      ['reflection', 'pass'],
      ['release', 'pass'],
    ]);
    expect(fake.started[0]?.inputs).toEqual({ slot: 'open', day: '2026-11-24' });
    expect(fake.exchangeReads()).toBe(3);
    expect(result.window).toEqual(WINDOW_PLAN.window);
    expect(result.planStepsHash).toBe(rehearsalPlanStepsHash(WINDOW_PLAN));
  });

  it('a start inside the session is not_due, names the window, and changes nothing', async () => {
    const fake = fakeClient({ exchange: [reading('2026-11-24T11:00:00.000-05:00', true)] });
    const result = await rehearseInWindow(fake);
    expect(result.outcome).toBe('not_due');
    expect(result.notDue).toMatchObject({
      stepId: 'window',
      window: 'session_closed',
      nextOpensAt: '2026-11-24T16:00',
    });
    expect(result.notDue?.detail).toContain('the market is open at 11:00');
    expect(result.notDue?.detail).toContain('Start after the close.');
    expect(result.steps.map((s) => [s.stepId, s.outcome])).toEqual([
      ['install', 'pass'],
      ['window', 'not_due'],
      ['start-campaign', 'not_due'],
      ['cycle-open', 'not_due'],
      ['reflection', 'not_due'],
    ]);
    expect(fake.policies).toEqual([]);
    expect(fake.started).toEqual([]);
  });

  it('a step whose window has closed by its start is not_due, and no later step starts', async () => {
    const fake = fakeClient({
      exchange: [AFTER_CLOSE, AFTER_CLOSE, reading('2026-11-25T00:10:00.000-05:00')],
    });
    const result = await rehearseInWindow(fake);
    expect(result.outcome).toBe('not_due');
    expect(result.notDue).toMatchObject({
      stepId: 'reflection',
      window: 'session_closed',
      nextOpensAt: '2026-11-25T16:00',
    });
    expect(result.notDue?.detail).toContain("the rehearsal's trading day is 2026-11-24");
    expect(fake.started.map((s) => s.slug)).toEqual(['cycle']);
    expect(result.steps.at(-1)).toMatchObject({ stepId: 'release', outcome: 'pass' });
    expect(BundleRehearsalResultSchema.safeParse(result).success).toBe(true);
  });

  it('a day with no session is not_due until the next session closes', async () => {
    const fake = fakeClient({ exchange: [reading('2026-11-28T17:00:00.000-05:00')] });
    const result = await rehearseInWindow(fake);
    expect(result.notDue).toMatchObject({ stepId: 'window', nextOpensAt: '2026-11-30T16:00' });
    expect(result.notDue?.detail).toContain('the exchange calendar holds no session on 2026-11-28');
  });

  it('an exchange read that fails is skipped, because no window was decided', async () => {
    const fake = fakeClient({ exchange: [{ ok: false, message: 'no broker binding' }] });
    const result = await rehearseInWindow(fake);
    expect(result.outcome).toBe('skipped');
    expect(result.skipReason).toContain('no broker binding');
    expect(fake.started).toEqual([]);
  });

  it('a plan whose step needs a window and that names none does not parse', () => {
    const parsed = BundleRehearsalPlanSchema.safeParse({ ...WINDOW_PLAN, window: undefined });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('the plan names no window');
  });
});

describe('the exchange window rule', () => {
  const at = (timestamp: string, isOpen = false) => reading(timestamp, isOpen).reading;

  it('a session day is open before the open, in the session and after the close', () => {
    for (const t of ['08:00', '11:00', '20:00']) {
      expect(
        exchangeWindowVerdict('session_day', at(`2026-11-24T${t}:00-05:00`), '2026-11-24'),
      ).toEqual({ open: true, date: '2026-11-24' });
    }
  });

  it('an early close opens session_closed at its own close', () => {
    expect(
      exchangeWindowVerdict('session_closed', at('2026-11-27T13:05:00-05:00'), undefined),
    ).toEqual({ open: true, date: '2026-11-27' });
    expect(
      exchangeWindowVerdict('session_closed', at('2026-11-27T12:55:00-05:00'), undefined),
    ).toMatchObject({ open: false, nextOpensAt: '2026-11-27T13:00' });
  });

  it('a calendar read with no later session names no next opening', () => {
    expect(
      exchangeWindowVerdict(
        'session_day',
        { timestamp: '2026-12-31T10:00:00-05:00', isOpen: false, sessions: [] },
        undefined,
      ),
    ).toMatchObject({ open: false, nextOpensAt: null });
  });
});

describe('rehearsal inputs and outcomes', () => {
  it('replaces each $rehearsal parameter and leaves other values alone', () => {
    expect(
      resolveRehearsalInputs(
        { slot: 'open', day: { $rehearsal: 'tradingDay' }, nested: { a: 1 } },
        { tradingDay: '2026-11-24' },
      ),
    ).toEqual({ ok: true, inputs: { slot: 'open', day: '2026-11-24', nested: { a: 1 } } });
    expect(resolveRehearsalInputs({ x: { $rehearsal: 'tradingDay' } }, {})).toEqual({
      ok: false,
      missing: 'tradingDay',
    });
    expect(resolveRehearsalInputs({ x: { $rehearsal: 'unknown' } }, {})).toEqual({
      ok: false,
      unknown: 'unknown',
    });
  });

  it('a plan that names a rehearsal parameter that does not exist does not parse, and names it', () => {
    const parsed = BundleRehearsalPlanSchema.safeParse({
      ...PLAN,
      steps: [
        {
          ...PLAN.steps[1]!,
          inputs: { slot: 'open', day: { $rehearsal: 'tradingDate' } },
        },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ['steps', 0, 'inputs', 'day', '$rehearsal'],
        message: expect.stringContaining('"tradingDate", which does not exist'),
      }),
    ]);
  });

  it('the steps hash moves when a step is added or changed', () => {
    const base = rehearsalPlanStepsHash(PLAN);
    const changed = {
      steps: PLAN.steps.map((s, i) => (i === 1 ? { ...s, timeoutMinutes: 6 } : s)),
    };
    expect(rehearsalPlanStepsHash(changed)).not.toBe(base);
    expect(rehearsalPlanStepsHash({ steps: [...PLAN.steps, PLAN.steps[1]!] })).not.toBe(base);
    expect(rehearsalPlanStepsHash({ steps: [...PLAN.steps] })).toBe(base);
  });

  it('a failure outranks a skip, a skip outranks not_due, not_due outranks a pass, and no step is no pass', () => {
    const step = (stepId: string, outcome: 'pass' | 'fail' | 'skipped') => ({
      stepId,
      outcome,
      detail: stepId,
    });
    const notDue = {
      stepId: 'c',
      outcome: 'not_due' as const,
      detail: 'closed',
      notDue: {
        stepId: 'c',
        window: 'session_closed' as const,
        detail: 'closed',
        nextOpensAt: null,
      },
    };
    expect(deriveRehearsalOutcome([step('a', 'skipped'), step('b', 'fail')]).outcome).toBe('fail');
    expect(deriveRehearsalOutcome([step('a', 'pass'), step('b', 'skipped')]).outcome).toBe(
      'skipped',
    );
    expect(deriveRehearsalOutcome([notDue, step('b', 'skipped')]).outcome).toBe('skipped');
    expect(deriveRehearsalOutcome([step('a', 'pass'), notDue])).toEqual({
      outcome: 'not_due',
      notDue: notDue.notDue,
    });
    expect(
      deriveRehearsalOutcome([{ stepId: 'd', outcome: 'not_due', detail: 'closed' }]).outcome,
    ).toBe('skipped');
    expect(deriveRehearsalOutcome([]).outcome).toBe('skipped');
    expect(deriveRehearsalOutcome([step('a', 'pass')]).outcome).toBe('pass');
  });

  it('a recorded result whose outcome disagrees with its steps does not parse', () => {
    const parsed = BundleRehearsalResultSchema.safeParse({
      ...TARGET,
      planStepsHash: rehearsalPlanStepsHash(PLAN),
      spaceId: SPACE,
      outcome: 'pass',
      window: null,
      steps: [{ stepId: 'install', kind: 'install', outcome: 'skipped', detail: 'not installed' }],
      uncovered: [],
      startedAt: '2026-11-24T14:00:00.000Z',
      finishedAt: '2026-11-24T14:00:01.000Z',
    });
    expect(parsed.success).toBe(false);
  });
});
