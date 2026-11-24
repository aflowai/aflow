import { describe, expect, it } from 'vitest';
import {
  BundleRehearsalPlanSchema,
  BundleRehearsalResultSchema,
  deriveRehearsalOutcome,
  type BundleRehearsalPlan,
  type SpaceWriteApprovalPolicy,
} from '@aflow/schemas';
import {
  HELD_WRITE_REFUSAL,
  REHEARSAL_WRITE_HOLD,
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

interface FakeOptions {
  install?: Awaited<ReturnType<RehearsalClient['readInstall']>>;
  /** What each slug's run reads as, poll after poll; the last repeats. */
  runs?: Record<string, RehearsedRun[]>;
  /** Writes held on the first poll of a slug's run. */
  held?: Record<string, number>;
  campaign?: Awaited<ReturnType<RehearsalClient['startCampaign']>>;
  unreachable?: boolean;
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
  let pendingHeld: HeldWrite[] = [];
  const client: RehearsalClient = {
    readInstall: () =>
      options.unreachable
        ? Promise.reject(new Error('fetch failed'))
        : Promise.resolve(
            options.install ?? {
              ok: true,
              installedVersion: 7,
              catalogVersion: 7,
              customized: false,
            },
          ),
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
      const held = options.held?.[slug] ?? 0;
      pendingHeld = Array.from({ length: held }, (_, i) => ({
        id: `write:${slug}:${String(i)}`,
        origin: { type: 'step' },
        title: 'POST /orders',
      }));
      const runId = `33333333-3333-4333-8333-${String(started.length).padStart(12, '0')}`;
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
    listHeldWrites: () => {
      const held = pendingHeld;
      pendingHeld = [];
      return Promise.resolve(held);
    },
    refuseWrite: (write, reason) => {
      expect(reason).toBe(HELD_WRITE_REFUSAL);
      refused.push(write.id);
      return Promise.resolve();
    },
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  };
  return { client, policies, ended, started, refused, cancelled, policy: () => policy };
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
      REHEARSAL_WRITE_HOLD,
      { requireApprovalByTier: { high: true } },
    ]);
    expect(fake.refused).toEqual(['write:cycle:0', 'write:cycle:1']);
    expect(result.steps.find((s) => s.stepId === 'cycle-open')?.heldWrites).toBe(2);
    expect(fake.ended).toEqual([CAMPAIGN]);
    expect(fake.started[1]?.inputs).toEqual({ bindingId: 'folder-1' });
    expect(result.uncovered).toEqual(PLAN.uncovered);
    expect(BundleRehearsalResultSchema.safeParse(result).success).toBe(true);
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
        install: { ok: true, installedVersion: 6, catalogVersion: 7, customized: false },
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

describe('rehearsal inputs and outcomes', () => {
  it('replaces each $rehearsal parameter and leaves other values alone', () => {
    expect(
      resolveRehearsalInputs(
        { slot: 'open', day: { $rehearsal: 'tradingDay' }, nested: { a: 1 } },
        { tradingDay: '2026-11-24' },
      ),
    ).toEqual({ ok: true, inputs: { slot: 'open', day: '2026-11-24', nested: { a: 1 } } });
    expect(resolveRehearsalInputs({ x: { $rehearsal: 'unknown' } }, {})).toEqual({
      ok: false,
      missing: 'unknown',
    });
  });

  it('a failure outranks a skip, a skip outranks a pass, and no step is no pass', () => {
    const step = (stepId: string, outcome: 'pass' | 'fail' | 'skipped') => ({
      stepId,
      outcome,
      detail: stepId,
    });
    expect(deriveRehearsalOutcome([step('a', 'skipped'), step('b', 'fail')]).outcome).toBe('fail');
    expect(deriveRehearsalOutcome([step('a', 'pass'), step('b', 'skipped')]).outcome).toBe(
      'skipped',
    );
    expect(deriveRehearsalOutcome([]).outcome).toBe('skipped');
    expect(deriveRehearsalOutcome([step('a', 'pass')]).outcome).toBe('pass');
  });

  it('a recorded result whose outcome disagrees with its steps does not parse', () => {
    const parsed = BundleRehearsalResultSchema.safeParse({
      ...TARGET,
      spaceId: SPACE,
      outcome: 'pass',
      steps: [{ stepId: 'install', kind: 'install', outcome: 'skipped', detail: 'not installed' }],
      uncovered: [],
      startedAt: '2026-11-24T14:00:00.000Z',
      finishedAt: '2026-11-24T14:00:01.000Z',
    });
    expect(parsed.success).toBe(false);
  });
});
