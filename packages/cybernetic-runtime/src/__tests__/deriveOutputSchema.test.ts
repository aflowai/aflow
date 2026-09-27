import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { PayloadStore } from '@aflow/payload-store';
import type { DerivedFromBinding } from '@aflow/schemas';
import { configureLogging } from '@aflow/observability';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

// ── Mock loadRunById ─────────────────────────────────────────────────────────

const mockLoadRunById = vi.fn();
const mockGetRunCampaignId = vi.fn();
vi.mock('../ledger.js', async () => {
  const actual = await vi.importActual<typeof import('../ledger.js')>('../ledger.js');
  return {
    ...actual,
    loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
    getRunCampaignId: (...args: unknown[]) => mockGetRunCampaignId(...args),
  };
});

const mockGetCampaignById = vi.fn();
vi.mock('../campaigns.js', async () => {
  const actual = await vi.importActual<typeof import('../campaigns.js')>('../campaigns.js');
  return {
    ...actual,
    getCampaignById: (...args: unknown[]) => mockGetCampaignById(...args),
  };
});

import { deriveEffectiveOutputSchema, DeriveSchemaError } from '../deriveOutputSchema.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TENANT = 'tenant-test';
const SPACE = 'space-test';
const RUN = 'run-test';

const fakeDb = {} as never;

function makePayloadStore(payloads: Record<string, unknown>): PayloadStore {
  return {
    retrieve: async (ref: string) => {
      if (!(ref in payloads)) {
        throw new Error(`payloadStore: ref not found: ${ref}`);
      }
      return payloads[ref];
    },
    // Other PayloadStore methods are unused by the helper; cast through unknown.
    store: vi.fn() as never,
    exists: vi.fn() as never,
    delete: vi.fn() as never,
    getSignedUrl: vi.fn() as never,
  } as unknown as PayloadStore;
}

function makeRunWithUpstream(params: {
  upstreamTaskId: string;
  upstreamStatus: 'succeeded' | 'failed' | 'scheduled';
  outputRef: string | null;
}) {
  return {
    runId: RUN,
    spaceId: SPACE,
    workflowSlug: 'test-skill',
    sessionId: 'sess-1',
    status: 'running',
    workflowRevision: 1,
    startedAt: new Date(),
    completedAt: null,
    totalCostCents: 0,
    totalTokens: 0,
    tasks: [
      {
        id: 't-row-1',
        runId: RUN,
        taskId: params.upstreamTaskId,
        status: params.upstreamStatus,
        attempt: 1,
        sessionId: 'sess-1',
        workerSessionId: null,
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 100,
        costCents: 0,
        metricsJson: null,
        summary: null,
        failureReason: null,
        outputRef: params.outputRef,
        reflectionJson: null,
      },
    ],
  };
}

const composeSkillBinding: DerivedFromBinding = {
  bindingId: 'taskcriteria-keys-from-workflow',
  from: 'design-skill',
  binding: 'enum:$.workflow.tasks[*].taskId',
  target: '$.evalSuite.taskCriteria.propertyNames.enum',
};

const baseDraftEvalsSchema = {
  type: 'object',
  properties: {
    evalSuite: {
      type: 'object',
      properties: {
        taskCriteria: {
          type: 'object',
          additionalProperties: { type: 'array' },
        },
      },
    },
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('deriveEffectiveOutputSchema — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces an effective schema with propertyNames.enum populated from upstream output (compose-skill scenario)', async () => {
    // Upstream design-skill output, wrapped in the standard delegation envelope.
    const designOutputRef = 'inline:envelope-1';
    const designOutputPayload = {
      childSessionId: 'child-sess-1',
      status: 'SUCCEEDED',
      childOutput: {
        workflow: {
          slug: 'kaggle-optimizer',
          tasks: [
            { taskId: 'download-data', type: 'agent' },
            { taskId: 'run-ml-pipeline', type: 'agent' },
            { taskId: 'submit-and-collect', type: 'human' },
          ],
        },
      },
    };

    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: designOutputRef,
      }),
    );

    const result = await deriveEffectiveOutputSchema({
      tenantId: TENANT,
      spaceId: SPACE,
      runId: RUN,
      task: {
        taskId: 'draft-evals',
        outputContract: {
          schema: baseDraftEvalsSchema,
          derivedFrom: [composeSkillBinding],
        },
      },
      db: fakeDb,
      payloadStore: makePayloadStore({ [designOutputRef]: designOutputPayload }),
    });

    // The compose-skill case in production: propertyNames.enum is now present
    // on the schema the runner's submit_output validates against.
    const evalSuite = (result.effectiveSchema as any).properties.evalSuite;
    expect(evalSuite.properties.taskCriteria.propertyNames.enum).toEqual([
      'download-data',
      'run-ml-pipeline',
      'submit-and-collect',
    ]);

    // Sidecar attribution lets Coach evidence map a validation failure back
    // to the binding that injected the constraint.
    expect(
      result.pathToBindingId['/properties/evalSuite/properties/taskCriteria/propertyNames/enum'],
    ).toBe('taskcriteria-keys-from-workflow');

    expect(typeof result.effectiveSchemaHash).toBe('string');
    expect(result.effectiveSchemaHash).toMatch(/^[0-9a-f]{64}$/);

    expect(result.resolvedBindings).toHaveLength(1);
    expect(result.resolvedBindings[0]?.bindingId).toBe('taskcriteria-keys-from-workflow');
    expect(result.resolvedBindings[0]?.value).toEqual([
      'download-data',
      'run-ml-pipeline',
      'submit-and-collect',
    ]);
  });

  it('returns the static schema unchanged when derivedFrom is empty', async () => {
    const result = await deriveEffectiveOutputSchema({
      tenantId: TENANT,
      spaceId: SPACE,
      runId: RUN,
      task: {
        taskId: 'design-skill',
        outputContract: {
          schema: baseDraftEvalsSchema,
        },
      },
      db: fakeDb,
      payloadStore: makePayloadStore({}),
    });

    expect(result.effectiveSchema).toBe(baseDraftEvalsSchema);
    expect(result.effectiveSchemaHash).toBeUndefined();
    expect(result.resolvedBindings).toEqual([]);
    expect(result.pathToBindingId).toEqual({});
    expect(mockLoadRunById).not.toHaveBeenCalled();
  });

  it('handles non-envelope payloads (raw output, not wrapped in childOutput)', async () => {
    const rawRef = 'inline:raw-1';
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: rawRef,
      }),
    );

    const result = await deriveEffectiveOutputSchema({
      tenantId: TENANT,
      spaceId: SPACE,
      runId: RUN,
      task: {
        taskId: 'draft-evals',
        outputContract: { schema: baseDraftEvalsSchema, derivedFrom: [composeSkillBinding] },
      },
      db: fakeDb,
      payloadStore: makePayloadStore({
        [rawRef]: { workflow: { tasks: [{ taskId: 'only' }] } },
      }),
    });

    expect(
      (result.effectiveSchema as any).properties.evalSuite.properties.taskCriteria.propertyNames
        .enum,
    ).toEqual(['only']);
  });
});

describe('deriveEffectiveOutputSchema — typed failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws DERIVED_SCHEMA_RUN_NOT_FOUND when the run does not exist', async () => {
    mockLoadRunById.mockResolvedValueOnce(null);
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: { schema: baseDraftEvalsSchema, derivedFrom: [composeSkillBinding] },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({}),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_RUN_NOT_FOUND' }));
  });

  it('throws DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED when upstream is still scheduled', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'scheduled',
        outputRef: 'inline:x',
      }),
    );
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: { schema: baseDraftEvalsSchema, derivedFrom: [composeSkillBinding] },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({}),
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED',
        bindingId: 'taskcriteria-keys-from-workflow',
      }),
    );
  });

  it('throws DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED when from references a missing task', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'some-other-task',
        upstreamStatus: 'succeeded',
        outputRef: 'inline:x',
      }),
    );
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: { schema: baseDraftEvalsSchema, derivedFrom: [composeSkillBinding] },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({}),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_UPSTREAM_NOT_SUCCEEDED' }));
  });

  it('throws DERIVED_SCHEMA_UPSTREAM_NO_OUTPUT when upstream succeeded with no outputRef', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: null,
      }),
    );
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: { schema: baseDraftEvalsSchema, derivedFrom: [composeSkillBinding] },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({}),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_UPSTREAM_NO_OUTPUT' }));
  });

  it('throws DERIVED_SCHEMA_PAYLOAD_UNAVAILABLE when payload retrieval fails', async () => {
    const ref = 'inline:missing';
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: ref,
      }),
    );
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: { schema: baseDraftEvalsSchema, derivedFrom: [composeSkillBinding] },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({}), // ref not present → retrieve throws
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_PAYLOAD_UNAVAILABLE' }));
  });

  it('throws DERIVED_SCHEMA_EMPTY_ENUM when upstream emits an empty array', async () => {
    const ref = 'inline:empty';
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: ref,
      }),
    );
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: { schema: baseDraftEvalsSchema, derivedFrom: [composeSkillBinding] },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({
          [ref]: { childOutput: { workflow: { tasks: [] } } },
        }),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_EMPTY_ENUM' }));
  });

  it('throws DERIVED_SCHEMA_INVALID_BINDING for malformed binding strings', async () => {
    const ref = 'inline:ok';
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: ref,
      }),
    );
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: {
            schema: baseDraftEvalsSchema,
            derivedFrom: [
              {
                ...composeSkillBinding,
                binding: 'wrong-prefix:$.workflow.tasks',
              },
            ],
          },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({ [ref]: { workflow: { tasks: [{ taskId: 'x' }] } } }),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_INVALID_BINDING' }));
  });

  it('throws DERIVED_SCHEMA_AMBIGUOUS_VALUE for value: bindings with multiple matches', async () => {
    const ref = 'inline:dupes';
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: ref,
      }),
    );
    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'draft-evals',
          outputContract: {
            schema: baseDraftEvalsSchema,
            derivedFrom: [
              {
                bindingId: 'too-many-matches',
                from: 'design-skill',
                binding: 'value:$.workflow.tasks[*].taskId',
                target: '$.evalSuite.foo.const',
              },
            ],
          },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({
          [ref]: { workflow: { tasks: [{ taskId: 'a' }, { taskId: 'b' }] } },
        }),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_AMBIGUOUS_VALUE' }));
  });
});

describe('deriveEffectiveOutputSchema — multi-binding behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caches upstream output across bindings with the same `from`', async () => {
    const ref = 'inline:once';
    const retrieveSpy = vi.fn().mockResolvedValue({
      workflow: { slug: 'kaggle', tasks: [{ taskId: 'a' }, { taskId: 'b' }] },
    });
    const payloadStore = {
      retrieve: retrieveSpy,
      store: vi.fn(),
      exists: vi.fn(),
      delete: vi.fn(),
      getSignedUrl: vi.fn(),
    } as unknown as PayloadStore;

    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'design-skill',
        upstreamStatus: 'succeeded',
        outputRef: ref,
      }),
    );

    await deriveEffectiveOutputSchema({
      tenantId: TENANT,
      spaceId: SPACE,
      runId: RUN,
      task: {
        taskId: 'draft-evals',
        outputContract: {
          schema: baseDraftEvalsSchema,
          derivedFrom: [
            {
              bindingId: 'a-keys',
              from: 'design-skill',
              binding: 'enum:$.workflow.tasks[*].taskId',
              target: '$.evalSuite.taskCriteria.propertyNames.enum',
            },
            {
              bindingId: 'b-slug',
              from: 'design-skill',
              binding: 'value:$.workflow.slug',
              target: '$.evalSuite.suiteSlug.const',
            },
          ],
        },
      },
      db: fakeDb,
      payloadStore,
    });

    expect(retrieveSpy).toHaveBeenCalledTimes(1);
  });
});

describe('deriveEffectiveOutputSchema — $campaign source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const riskGateSchema = {
    type: 'object',
    properties: {
      theses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instrument: { type: 'string' },
            sizePct: { type: 'number', exclusiveMinimum: 0 },
          },
        },
      },
    },
  };

  const campaignBindings: DerivedFromBinding[] = [
    {
      bindingId: 'universe-instruments',
      from: '$campaign',
      binding: 'enum:$.universe[*]',
      target: '$.theses.items.instrument.enum',
    },
    {
      bindingId: 'theses-per-day-cap',
      from: '$campaign',
      binding: 'value:$.maxThesesPerDay',
      target: '$.theses.maxItems',
    },
    {
      bindingId: 'position-size-cap',
      from: '$campaign',
      binding: 'value:$.maxPositionSizePct',
      target: '$.theses.items.sizePct.maximum',
    },
  ];

  it('resolves campaign-config caps into enum + numeric-bound leaves', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'unused',
        upstreamStatus: 'succeeded',
        outputRef: null,
      }),
    );
    mockGetRunCampaignId.mockResolvedValueOnce('campaign-1');
    mockGetCampaignById.mockResolvedValueOnce({
      campaignId: 'campaign-1',
      config: { universe: ['AAPL', 'MSFT', 'SPY'], maxThesesPerDay: 3, maxPositionSizePct: 10 },
    });

    const result = await deriveEffectiveOutputSchema({
      tenantId: TENANT,
      spaceId: SPACE,
      runId: RUN,
      task: {
        taskId: 'decide',
        outputContract: { schema: riskGateSchema, derivedFrom: campaignBindings },
      },
      db: fakeDb,
      payloadStore: makePayloadStore({}),
    });

    const theses = (result.effectiveSchema as any).properties.theses;
    expect(theses.maxItems).toBe(3);
    expect(theses.items.properties.instrument.enum).toEqual(['AAPL', 'MSFT', 'SPY']);
    expect(theses.items.properties.sizePct.maximum).toBe(10);
    // One campaign load serves all three bindings.
    expect(mockGetRunCampaignId).toHaveBeenCalledTimes(1);
    expect(mockGetCampaignById).toHaveBeenCalledTimes(1);
  });

  it('throws DERIVED_SCHEMA_CAMPAIGN_UNAVAILABLE when the run has no campaign', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'unused',
        upstreamStatus: 'succeeded',
        outputRef: null,
      }),
    );
    mockGetRunCampaignId.mockResolvedValueOnce(null);

    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'decide',
          outputContract: { schema: riskGateSchema, derivedFrom: campaignBindings },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({}),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_CAMPAIGN_UNAVAILABLE' }));
  });

  it('throws DERIVED_SCHEMA_MISSING_PATH when the campaign config lacks the referenced field', async () => {
    mockLoadRunById.mockResolvedValueOnce(
      makeRunWithUpstream({
        upstreamTaskId: 'unused',
        upstreamStatus: 'succeeded',
        outputRef: null,
      }),
    );
    mockGetRunCampaignId.mockResolvedValueOnce('campaign-1');
    mockGetCampaignById.mockResolvedValueOnce({ campaignId: 'campaign-1', config: {} });

    await expect(
      deriveEffectiveOutputSchema({
        tenantId: TENANT,
        spaceId: SPACE,
        runId: RUN,
        task: {
          taskId: 'decide',
          outputContract: {
            schema: riskGateSchema,
            derivedFrom: [
              {
                bindingId: 'theses-per-day-cap',
                from: '$campaign',
                binding: 'value:$.maxThesesPerDay',
                target: '$.theses.maxItems',
              },
            ],
          },
        },
        db: fakeDb,
        payloadStore: makePayloadStore({}),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'DERIVED_SCHEMA_MISSING_PATH' }));
  });
});

// Type-shape sanity: DeriveSchemaError is exported and instanceof works.
describe('DeriveSchemaError export', () => {
  it('is a constructable class with code + bindingId', () => {
    const e = new DeriveSchemaError('DERIVED_SCHEMA_EMPTY_ENUM', 'msg', 'b1');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('DERIVED_SCHEMA_EMPTY_ENUM');
    expect(e.bindingId).toBe('b1');
  });
});
