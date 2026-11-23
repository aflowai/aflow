/**
 * Contract: `workflow.campaign.read` runs the reader it names over a campaign
 * of the calling space only, gives the reader's value, and refuses an unknown
 * reader, another space's campaign and a reader's own refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCampaignReader, type CampaignReaderContext } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';

const mockGetCampaignInSpace = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    getCampaignInSpace: (...args: unknown[]) => mockGetCampaignInSpace(...args),
  };
});

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, getDatabase: vi.fn(() => ({ db: true })) };
});

const mockAddStepResult = vi.fn();
vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logOrchestratorError: vi.fn(),
}));

import { handleWorkflowCrudInline } from '../workflowCrud.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const OTHER_SPACE = '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69';
const CAMPAIGN_ID = '8c1f2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const CAMPAIGN = {
  campaignId: CAMPAIGN_ID,
  spaceId: SPACE,
  workflowSlug: 'daily-trading-cycle',
  goalRef: 'daily-trading-cycle:process',
  scoreMetricKey: 'process',
  direction: 'maximize',
  config: { regimeName: 'momentum-1' },
  status: 'active',
  startedAt: '2026-11-02T14:00:00.000Z',
};

const seen: CampaignReaderContext[] = [];
registerCampaignReader('test.echo', (ctx) => {
  seen.push(ctx);
  return Promise.resolve({ ok: true, value: { args: ctx.args, regime: ctx.config['regimeName'] } });
});
registerCampaignReader('test.refuse', () =>
  Promise.resolve({ ok: false, message: 'The period cannot be dated.' }),
);

const payloadStore = {
  retrieve: vi.fn(),
  store: vi.fn().mockResolvedValue('inline:stored='),
  shouldStore: () => false,
};

function args(input: Record<string, unknown>): InlineHandlerArgs {
  const inputRef = `inline:${Buffer.from(JSON.stringify(input)).toString('base64')}`;
  payloadStore.retrieve.mockResolvedValue(input);
  return {
    redis: {} as never,
    payloadStore: payloadStore as never,
    context: {
      tenantId: TENANT,
      runId: 'session-1',
      traceId: 'trace-1',
      spaceId: SPACE,
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'read-period',
      stepType: 'workflow',
      operation: 'workflow.campaign.read',
      tags: [],
    } as never,
    stepExecutionId: 'step-1' as never,
    parentStepExecutionId: null as never,
    attempt: 1,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inputRef,
  };
}

function result(): { status: string; output?: unknown; error?: { code?: string } } {
  const message = mockAddStepResult.mock.calls[0]![1] as {
    status: string;
    outputRef?: string;
    error?: { code?: string };
  };
  return {
    status: message.status,
    ...(message.outputRef?.startsWith('inline:')
      ? {
          output: JSON.parse(
            Buffer.from(message.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
          ) as unknown,
        }
      : {}),
    ...(message.error ? { error: message.error } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seen.length = 0;
  // A campaign is found only in the space it belongs to.
  mockGetCampaignInSpace.mockImplementation(
    (_db: unknown, _tenant: string, spaceId: string, campaignId: string) =>
      Promise.resolve(spaceId === CAMPAIGN.spaceId && campaignId === CAMPAIGN_ID ? CAMPAIGN : null),
  );
});

describe('workflow.campaign.read', () => {
  it('runs the named reader over the campaign and gives its value', async () => {
    await handleWorkflowCrudInline(
      args({
        campaignId: CAMPAIGN_ID,
        reader: 'test.echo',
        args: { periodStart: '2026-11-23', periodEnd: '2026-11-27' },
      }),
    );
    expect(result()).toMatchObject({
      status: 'SUCCEEDED',
      output: {
        campaignId: CAMPAIGN_ID,
        reader: 'test.echo',
        value: {
          args: { periodStart: '2026-11-23', periodEnd: '2026-11-27' },
          regime: 'momentum-1',
        },
      },
    });
    expect(seen[0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: 'daily-trading-cycle',
      startedAt: CAMPAIGN.startedAt,
      db: { db: true },
      payloadStore,
    });
  });

  it('reads absent args as none, since inline inputs arrive un-defaulted', async () => {
    await handleWorkflowCrudInline(args({ campaignId: CAMPAIGN_ID, reader: 'test.echo' }));
    expect(result().status).toBe('SUCCEEDED');
    expect(seen[0]!.args).toEqual({});
  });

  it('refuses a reader no one registered, and reads nothing', async () => {
    await handleWorkflowCrudInline(args({ campaignId: CAMPAIGN_ID, reader: 'test.unknown' }));
    expect(result()).toMatchObject({
      status: 'FAILED',
      error: { code: 'CAMPAIGN_READER_UNKNOWN' },
    });
    expect(mockGetCampaignInSpace).not.toHaveBeenCalled();
  });

  it('refuses a campaign of another space, and runs no reader', async () => {
    const call = args({ campaignId: CAMPAIGN_ID, reader: 'test.echo' });
    (call.context as { spaceId: string }).spaceId = OTHER_SPACE;
    await handleWorkflowCrudInline(call);
    expect(mockGetCampaignInSpace.mock.calls[0]![2]).toBe(OTHER_SPACE);
    expect(result()).toMatchObject({ status: 'FAILED', error: { code: 'CAMPAIGN_NOT_FOUND' } });
    expect(seen).toEqual([]);
  });

  it('fails with the reader’s own reason where the reader refuses', async () => {
    await handleWorkflowCrudInline(args({ campaignId: CAMPAIGN_ID, reader: 'test.refuse' }));
    const failed = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      error?: { code?: string; message?: string };
    };
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatchObject({
      code: 'CAMPAIGN_READ_REFUSED',
      message: 'The period cannot be dated.',
    });
  });
});
