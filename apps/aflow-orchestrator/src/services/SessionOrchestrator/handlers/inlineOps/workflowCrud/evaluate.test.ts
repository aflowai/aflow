import { describe, it, expect, vi, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { WorkflowEvaluateInput } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const mocks = vi.hoisted(() => ({
  readJsonDoc: vi.fn(),
  loadRunById: vi.fn(),
  completeRun: vi.fn(),
  writeRunEvaluationEnvelope: vi.fn(),
  emitStepSuccess: vi.fn(),
  emitStepError: vi.fn(),
}));

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  completeRun: mocks.completeRun,
  loadRunById: mocks.loadRunById,
  getRunCampaignId: vi.fn(),
  getCampaignById: vi.fn(),
  writeRunEvaluationEnvelope: mocks.writeRunEvaluationEnvelope,
}));

vi.mock('../../../../cybernetic/postRunHooks.js', () => ({
  fireCyberneticPostRunHooksStandalone: vi.fn(() => Promise.resolve()),
}));

vi.mock('./shared.js', () => ({
  getRepos: () => ({ docRepo: {}, dirRepo: {} }),
  readJsonDoc: mocks.readJsonDoc,
  writeJsonDoc: vi.fn(),
}));

vi.mock('../helpers.js', () => ({
  emitStepSuccess: mocks.emitStepSuccess,
  emitStepError: mocks.emitStepError,
}));

import { handleWorkflowEvaluate } from './evaluate.js';
import { claimScheduleCreate, scheduleCreatesCounted } from '../scheduleCreateBudget.js';

const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const TENANT = 'a0000000-0000-0000-0000-000000000001';
const RUN = '00000000-0000-0000-0000-0000000000e1';
const SLUG = 'evaluated-skill';

function args(redis: Redis): InlineHandlerArgs {
  return {
    redis,
    context: { tenantId: TENANT, runId: '00000000-0000-0000-0000-0000000000e9', spaceId: SPACE },
  } as unknown as InlineHandlerArgs;
}

const INPUT = { slug: SLUG, metrics: { score: 0.9 }, runId: RUN } as WorkflowEvaluateInput;

describe('workflow.evaluate ending a run', () => {
  let redis: Redis;

  beforeEach(async () => {
    vi.clearAllMocks();
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    mocks.readJsonDoc.mockResolvedValue({
      slug: SLUG,
      status: 'active',
      outcomes: [
        {
          id: 'score',
          evaluator: { type: 'threshold', metric: 'score', operator: 'gte', target: 0.5 },
        },
      ],
    });
    mocks.loadRunById.mockResolvedValue({ runId: RUN, workflowSlug: SLUG, status: 'running' });
  });

  it('leaves no schedule-create count for the run it completed', async () => {
    mocks.completeRun.mockResolvedValue(true);
    await claimScheduleCreate(redis, TENANT, RUN);
    expect(await scheduleCreatesCounted(redis, TENANT, RUN)).toBe(1);

    await handleWorkflowEvaluate(args(redis), INPUT, Date.now());

    expect(mocks.completeRun).toHaveBeenCalledOnce();
    expect(await scheduleCreatesCounted(redis, TENANT, RUN)).toBeUndefined();
  });

  it('keeps the count where another writer ended the run first', async () => {
    mocks.completeRun.mockResolvedValue(false);
    await claimScheduleCreate(redis, TENANT, RUN);

    await handleWorkflowEvaluate(args(redis), INPUT, Date.now());

    // That writer releases it on its own terminal path.
    expect(await scheduleCreatesCounted(redis, TENANT, RUN)).toBe(1);
  });
});
