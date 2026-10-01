import { describe, it, expect, vi } from 'vitest';
import { resolveStepInput, StepInputValidationError } from './stepInputResolution.js';
import { validateAgentOutput } from '../handlers/inlineOps/agentOutputValidator.js';
import type { StepDefinition } from '@aflow/schemas';
import { createMemoryPayloadStore, type PayloadStore } from '@aflow/payload-store';
import { randomUUID } from 'node:crypto';
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';

function makePayloadStore(data: Record<string, unknown>): PayloadStore {
  return {
    retrieve: vi.fn(async () => data),
    store: vi.fn(async () => 'inline:test'),
  } as unknown as PayloadStore;
}

function decodeInlineRef(ref: string): Record<string, unknown> {
  const base64 = ref.replace('inline:', '');
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>;
}

function makeStepDef(
  config: Record<string, unknown>,
  operation: StepDefinition['operation'] = 'mock.noop' as StepDefinition['operation'],
): StepDefinition {
  return {
    stepId: 'test-step',
    operation,
    config,
    next: {},
  } as unknown as StepDefinition;
}

describe('resolveStepInput merge behavior', () => {
  it('passes through rawInput when config is empty', async () => {
    const rawInput = { message: 'hello', path: '/foo' };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({});

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result).toEqual({ message: 'hello', path: '/foo' });
  });

  it('config with refs: bound rawInput keys are consumed, unbound keys pass through', async () => {
    const rawInput = { userMessage: 'hello', extra: 'data' };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({ prompt: '${input.userMessage}' });

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result).toEqual({ prompt: 'hello', extra: 'data' });
  });

  it('embedded ${input.*} refs consume their rawInput key; code-protected refs do not', async () => {
    const rawInput = { name: 'Ada', example: 'ignored' };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({
      greeting: 'Hello ${input.name}',
      docs: 'Reference input with `${input.example}`',
    });

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result['greeting']).toBe('Hello Ada');
    expect(result['name']).toBeUndefined();
    expect(result['example']).toBe('ignored');
  });

  it('graph-tool lowering: renamed ${input.*} tool args validate against a strict op schema', async () => {
    const rawInput = {
      workflowSlug: 'lead-scoring',
      workflowInstructions: 'Focus on the newest leads.',
      workflowInputs: { competitionSlug: 'titanic' },
    };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef(
      {
        slug: '${input.workflowSlug}',
        instructions: '${input.workflowInstructions}',
        inputs: '${input.workflowInputs}',
        wait: 'until_pause',
      },
      'workflow.run.start' as StepDefinition['operation'],
    );

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result['slug']).toBe('lead-scoring');
    expect(result['instructions']).toBe('Focus on the newest leads.');
    expect(result['inputs']).toEqual({ competitionSlug: 'titanic' });
    expect(result['workflowSlug']).toBeUndefined();
    expect(result['workflowInstructions']).toBeUndefined();
    expect(result['workflowInputs']).toBeUndefined();
  });

  it('config WITHOUT refs: config values take precedence over rawInput', async () => {
    const rawInput = { path: '/previous/step/output', id: 'old-id', version: 1 };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({ path: '/my/explicit/path', docType: 'markdown' });

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result['path']).toBe('/my/explicit/path');
    expect(result['docType']).toBe('markdown');
    expect(result['id']).toBe('old-id');
    expect(result['version']).toBe(1);
  });

  it('config WITHOUT refs: rawInput provides non-overlapping fields', async () => {
    const rawInput = { extra: 'data', another: 42 };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({ path: '/explicit' });

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result['path']).toBe('/explicit');
    expect(result['extra']).toBe('data');
    expect(result['another']).toBe(42);
  });

  it('regression: chained memory.store.put steps with different paths', async () => {
    const prevStepOutput = {
      id: 'abc-123',
      path: '/test/poems/ozymandias.txt',
      version: 1,
      contentHash: 'sha256:aaa',
      sizeBytes: 100,
      embeddingStatus: 'pending',
    };
    const ps = makePayloadStore(prevStepOutput);

    const step = makeStepDef({
      path: '/test/notes/redis-streams.md',
      docType: 'markdown',
      mimeType: 'text/markdown',
      content: { inlineText: 'Redis Streams notes...' },
      indexing: 'auto',
    });

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result['path']).toBe('/test/notes/redis-streams.md');
    expect(result['path']).not.toBe('/test/poems/ozymandias.txt');
  });

  it('strips a null the op schema rejects (LLM null-for-omitted tolerance)', async () => {
    const rawInput = { prompt: 'hello', model: null };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({}, 'ai.text.generate' as StepDefinition['operation']);

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);

    expect(result['prompt']).toBe('hello');
    expect('model' in result).toBe(false);
  });

  it('draft_patch: required-nullable fields survive resolution to the output-contract seam', async () => {
    // A task result reaches the contract through the draft now, so this is the
    // hop where a null-valued required field would be dropped.
    const taskResult = {
      tradingDay: '2026-07-16',
      proceed: false,
      noopReason: null,
      resolutions: [],
    };
    const ps = makePayloadStore({
      mutationId: 'm1',
      operations: [{ op: 'add', path: '', value: taskResult }],
    });
    const step = makeStepDef({}, 'agent.control.draft_patch' as StepDefinition['operation']);

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const resolved = decodeInlineRef(ref);
    const ops = resolved['operations'] as Array<{ value: Record<string, unknown> }>;
    const result = ops[0]!.value;

    expect('noopReason' in result).toBe(true);
    expect(result['noopReason']).toBeNull();

    // The same Ajv check runnerOutput.ts runs against the task's output
    // contract — a required, nullable field set to null must validate.
    const contract = {
      type: 'object',
      required: ['tradingDay', 'proceed', 'noopReason', 'resolutions'],
      additionalProperties: false,
      properties: {
        tradingDay: { type: 'string' },
        proceed: { type: 'boolean' },
        noopReason: { type: ['string', 'null'] },
        resolutions: { type: 'array' },
      },
    };
    expect(validateAgentOutput(result, contract)).toEqual({ ok: true });
  });

  it('api.http.call: nulls inside the opaque params record are preserved as data', async () => {
    const rawInput = {
      apiId: 'alpaca-paper-orders-write',
      endpointId: 'post_orders',
      params: { body: { symbol: 'SPY', qty: null, notional: '100.00' } },
    };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({}, 'api.http.call' as StepDefinition['operation']);

    const ref = await resolveStepInput(ps, step, 'inline:test');
    const result = decodeInlineRef(ref);
    const body = (result['params'] as Record<string, unknown>)['body'] as Record<string, unknown>;

    expect('qty' in body).toBe(true);
    expect(body['qty']).toBeNull();
  });

  it('rejects invalid ui.artifact.generate artifactId before executor dispatch', async () => {
    const rawInput = {
      prompt: 'Create a chart',
      artifactId: 'goog-price-performance-chart',
    };
    const ps = makePayloadStore(rawInput);
    const step = makeStepDef({}, 'ui.artifact.generate' as StepDefinition['operation']);

    await expect(resolveStepInput(ps, step, 'inline:test')).rejects.toThrow(
      /Input validation failed for ui\.artifact\.generate/,
    );
  });
});

describe('StepInputValidationError message formatting', () => {
  it('renders a root-path error without a dangling path separator', () => {
    const err = new StepInputValidationError('nonexistent.op.test', {
      valid: false,
      errorType: 'INPUT_VALIDATION_ERROR',
      errors: [{ path: [], message: 'Unknown input key(s): "wait".', code: 'unrecognized_keys' }],
    });
    expect(err.message).toBe(
      'Input validation failed for nonexistent.op.test: Unknown input key(s): "wait".',
    );
  });

  it('prefixes field-path errors with the joined path', () => {
    const err = new StepInputValidationError('nonexistent.op.test', {
      valid: false,
      errorType: 'INPUT_VALIDATION_ERROR',
      errors: [
        { path: [], message: 'Unknown input key(s): "wait".', code: 'unrecognized_keys' },
        { path: ['pauseVersion'], message: 'must not be set.', code: 'custom' },
      ],
    });
    expect(err.message).toBe(
      'Input validation failed for nonexistent.op.test: Unknown input key(s): "wait".; pauseVersion: must not be set.',
    );
  });
});

describe('resolveStepInput payload-ref contract', () => {
  const TENANT = 'a0000000-0000-0000-0000-000000000001';
  const RUN = '58f30a78-d27c-49a6-8b79-17270503bc3f';

  async function resolveWith(
    rawInput: Record<string, unknown>,
    identity: { tenantId?: string; runId?: string } = { tenantId: TENANT, runId: RUN },
  ) {
    const store = createMemoryPayloadStore();
    const rawRef = await store.store({
      tenantId: TENANT as TenantId,
      runId: RUN as SessionId,
      stepExecutionId: randomUUID() as StepExecutionId,
      attempt: 1,
      kind: 'input',
      data: rawInput,
    });
    return {
      store,
      ref: await resolveStepInput(
        store,
        makeStepDef({}),
        rawRef,
        undefined,
        undefined,
        identity.tenantId,
        identity.runId,
      ),
    };
  }

  it('an input over the cap is spilled, and the ref it returns is one the store resolves', async () => {
    const oversized = { blob: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES * 2) };
    const { store, ref } = await resolveWith(oversized);

    expect(ref.startsWith('inline:')).toBe(false);
    await expect(store.retrieve(ref)).resolves.toEqual(oversized);
  });

  it('an input under the cap still rides inline', async () => {
    const small = { message: 'hello' };
    const { store, ref } = await resolveWith(small);

    expect(ref.startsWith('inline:')).toBe(true);
    await expect(store.retrieve(ref)).resolves.toEqual(small);
  });

  it('refuses an oversized input it cannot address rather than returning an unreadable ref', async () => {
    const oversized = { blob: 'x'.repeat(MAX_INLINE_PAYLOAD_BYTES * 2) };

    await expect(resolveWith(oversized, {})).rejects.toThrow(/no tenant\/run identity to carry it/);
  });
});

describe('resolveStepInput: a reference to a prior output in workflow.run.start inputs', () => {
  const commissionOutput = { patch: 'diff --git a/x b/x\n', summary: 'one file' };
  const runtimeState = {
    variables: {
      _tool_outputs: {
        ref: { kind: 'inline', value: { call_commission: 'gs://bucket/commission' } },
      },
    },
  } as unknown as NonNullable<Parameters<typeof resolveStepInput>[3]>;

  function storeFor(rawInput: Record<string, unknown>): PayloadStore {
    return {
      retrieve: vi.fn(async (ref: string) => (ref === 'inline:raw' ? rawInput : commissionOutput)),
      store: vi.fn(async () => 'inline:unused'),
    } as unknown as PayloadStore;
  }

  const runStart = makeStepDef({}, 'workflow.run.start' as StepDefinition['operation']);

  it('resolves a reference nested below `inputs` in place', async () => {
    const rawInput = {
      slug: 'publish',
      inputs: { patch: { $ref: 'output.call_commission/patch' } },
    };
    const ref = await resolveStepInput(storeFor(rawInput), runStart, 'inline:raw', runtimeState);
    expect(decodeInlineRef(ref)['inputs']).toEqual({ patch: commissionOutput.patch });
  });

  it('resolves it in place when the model sent `inputs` as a JSON string', async () => {
    const rawInput = {
      slug: 'publish',
      inputs: JSON.stringify({ patch: { $ref: 'output.call_commission/patch' } }),
    };
    const ref = await resolveStepInput(storeFor(rawInput), runStart, 'inline:raw', runtimeState);
    expect(decodeInlineRef(ref)['inputs']).toEqual({ patch: commissionOutput.patch });
  });

  it('refuses `inputs` that is itself the reference, since it resolves to the string', async () => {
    const rawInput = { slug: 'publish', inputs: { $ref: 'output.call_commission/patch' } };
    await expect(
      resolveStepInput(storeFor(rawInput), runStart, 'inline:raw', runtimeState),
    ).rejects.toThrow(/inputs: Expected object, received string/);
  });
});
