import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiDefinitionDraft,
  SessionId,
  StepDefinition,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';

const mockAddStepResult = vi.fn();
const mockEnsureParentDirs = vi.fn().mockResolvedValue(undefined);
const mockDocPut = vi.fn().mockResolvedValue(undefined);

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
  createTenantContext: vi.fn(() => ({})),
  createMemoryDocRepository: vi.fn(() => ({ put: (...a: unknown[]) => mockDocPut(...a) })),
  createMemoryDirRepository: vi.fn(() => ({
    ensureParentDirs: (...a: unknown[]) => mockEnsureParentDirs(...a),
  })),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  resolveProposalRoute: () => 'tenant_ratification',
  proposalDirForRoute: () => '/coach/staged',
  runCapabilityBindingProposalValidations: () => ({
    contract: {
      status: 'valid',
      diagnostics: [],
      advisories: [],
      validatedAt: '2026-06-09T00:00:00.000Z',
    },
    capability: { issues: [], warnings: [] },
  }),
  isProposalReadinessSafe: () => true,
  loadSkillGrantReferencesForApiId: vi.fn(async () => []),
  synthesizeEndpoints: () => [],
  // Returns a model-valid definition so the propose-time ApiDefinitionSchema
  // check passes and the handler proceeds to write the proposal. Endpoints are
  // settable, because the propose-time schema guards iterate THEM — a fixed
  // empty list would let a test claim to exercise a guard that never ran.
  buildDefinitionJsonForDraft: () => ({
    apiId: 'x',
    name: 'x',
    baseUrl: 'https://x.example.com',
    // `direct_url` forbids endpoints, so the mode has to follow the fixture or
    // the model check rejects before the schema guards are ever reached.
    callMode: mockDefinitionEndpoints.length > 0 ? 'endpoint' : 'direct_url',
    endpoints: mockDefinitionEndpoints,
  }),
}));

/** Endpoints the mocked synthesis yields; reset per test. */
let mockDefinitionEndpoints: Array<Record<string, unknown>> = [];

const TENANT = 'a0000000-0000-0000-0000-000000000001';
const SPACE = '41be431d-6011-495b-a4f2-6de539a6a0df';
const RUN = '11111111-1111-4111-8111-111111111111';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeOutputRef(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

const validApiDefinition: ApiDefinitionDraft = {
  name: 'Example',
  baseUrl: 'https://api.example.com',
  authKind: 'none',
  endpoints: [
    {
      endpointId: 'getStatus',
      method: 'GET',
      path: '/status',
      summary: 'Service health check',
    },
  ],
};

function makeArgs(resolvedInput: unknown) {
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      traceId: 'trace-1',
      agentDefinition: { steps: [] } as never,
    },
    stepDef: {
      stepId: 'step-1',
      stepType: 'capability',
      operation: 'capability.binding.propose',
      tags: [],
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as unknown as StepDefinition,
    stepExecutionId: 'step-exec-1',
    idempotencyKey: 'idempotent-1' as never,
    resolvedInputRef: inlineRef(resolvedInput),
    attempt: 1,
    scheduledAtMs: Date.now(),
  } as never;
}

describe('capability.binding.propose — Plan 123 Phase B typed input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefinitionEndpoints = [];
  });

  it('reads { apiDefinition } from args.resolvedInputRef and writes the staged proposal', async () => {
    const { handleCapabilityBindingInline } = await import('../capabilityBinding.js');
    await handleCapabilityBindingInline(makeArgs({ apiDefinition: validApiDefinition }));

    // Proposal doc was written.
    expect(mockDocPut).toHaveBeenCalledTimes(1);
    // Step succeeded with the typed output shape.
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const stepResult = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(stepResult['status']).toBe('SUCCEEDED');
    const outputRef = stepResult['outputRef'] as string;
    const output = decodeOutputRef(outputRef);
    expect(output['status']).toBe('proposed');
    expect(output['apiId']).toBe('example');
    expect(output['authKind']).toBe('none');
    expect(output['endpointCount']).toBe(1);
  });

  it('rejects malformed apiDefinition with a typed validation error', async () => {
    const { handleCapabilityBindingInline } = await import('../capabilityBinding.js');
    // authKind 'http_basic' is not a legal value (the legal set is
    // bearer / api_key / oauth2 / basic / none).
    await handleCapabilityBindingInline(
      makeArgs({
        apiDefinition: {
          ...validApiDefinition,
          authKind: 'http_basic' as never,
        },
      }),
    );

    expect(mockDocPut).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const stepResult = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(stepResult['status']).toBe('FAILED');
    const error = stepResult['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CAPABILITY_BINDING_DRAFT_INVALID');
  });

  // A response schema is what a simulation GENERATES against, so one that will
  // not compile produces an endpoint no world can answer. The draft's
  // self-containment rule reads `$ref`s and says nothing about validity, so this
  // is the gate that catches it — in-session, where the Runner can still fix it,
  // rather than as `response_schema_uncompilable` on a definition already made.
  it('rejects a response schema that is not compilable JSON Schema', async () => {
    mockDefinitionEndpoints = [
      {
        endpointId: 'getStatus',
        name: 'getStatus',
        method: 'GET',
        pathTemplate: '/status',
        params: [],
        responseSchemas: { '2xx': { type: 'not-a-type' } },
        tags: [],
      },
    ];
    const { handleCapabilityBindingInline } = await import('../capabilityBinding.js');
    await handleCapabilityBindingInline(makeArgs({ apiDefinition: validApiDefinition }));

    expect(mockDocPut).not.toHaveBeenCalled();
    const stepResult = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(stepResult['status']).toBe('FAILED');
    const error = stepResult['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CAPABILITY_BINDING_RESPONSE_SCHEMA_INVALID');
    expect(String(error['message'])).toContain("'2xx'");
  });

  it('accepts a response schema that compiles', async () => {
    mockDefinitionEndpoints = [
      {
        endpointId: 'getStatus',
        name: 'getStatus',
        method: 'GET',
        pathTemplate: '/status',
        params: [],
        responseSchemas: { '2xx': { type: 'object', properties: { ok: { type: 'boolean' } } } },
        tags: [],
      },
    ];
    const { handleCapabilityBindingInline } = await import('../capabilityBinding.js');
    await handleCapabilityBindingInline(makeArgs({ apiDefinition: validApiDefinition }));

    expect(mockDocPut).toHaveBeenCalledTimes(1);
    const stepResult = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(stepResult['status']).toBe('SUCCEEDED');
  });

  it('reads an input the scheduler spilled to the payload store', async () => {
    const { handleCapabilityBindingInline } = await import('../capabilityBinding.js');
    const store = createMemoryPayloadStore();
    const storedRef = await store.store({
      tenantId: 'a0000000-0000-0000-0000-000000000001' as TenantId,
      runId: '11111111-1111-4111-8111-111111111111' as SessionId,
      stepExecutionId: 'step-exec-1' as StepExecutionId,
      attempt: 1,
      kind: 'input',
      data: { apiDefinition: validApiDefinition },
    });

    await handleCapabilityBindingInline({
      ...makeArgs({ apiDefinition: validApiDefinition }),
      payloadStore: store,
      resolvedInputRef: storedRef,
    } as never);

    expect(mockDocPut).toHaveBeenCalledTimes(1);
    const stepResult = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(stepResult['status']).toBe('SUCCEEDED');
  });

  it('reports the cause when the input cannot be read at all', async () => {
    const { handleCapabilityBindingInline } = await import('../capabilityBinding.js');
    await handleCapabilityBindingInline({
      ...makeArgs({ apiDefinition: validApiDefinition }),
      resolvedInputRef: 'redis:some-key:abc',
    });

    expect(mockDocPut).not.toHaveBeenCalled();
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const stepResult = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
    expect(stepResult['status']).toBe('FAILED');
    const error = stepResult['error'] as Record<string, unknown>;
    expect(error['code']).toBe('CAPABILITY_BINDING_INPUT_READ_FAILED');
  });
});
