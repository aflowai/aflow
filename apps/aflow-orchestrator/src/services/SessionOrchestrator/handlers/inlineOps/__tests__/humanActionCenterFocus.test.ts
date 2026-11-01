import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';

const mockAddStepResult = vi.fn();
const mockPublishActionCenterFocus = vi.fn();

vi.mock('@aflow/redis', async () => ({
  ...(await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis')),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  publishActionCenterFocus: (...args: unknown[]) => mockPublishActionCenterFocus(...args),
}));

import { handleHumanActionCenterFocusInline } from '../humanActionCenterFocus.js';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeInline(ref: string): unknown {
  const b64 = ref.replace(/^inline:/, '');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
}

function makeFocusStepDef(): StepDefinition {
  return {
    stepId: 'helmsman-focus-step',
    stepType: 'human',
    operation: 'human.action_center.focus',
    name: 'Focus item',
    config: {},
    tags: ['dynamic', 'virtual_tool'],
    optional: false,
    outputOptions: { displayToUser: false },
    onSuccess: { next: [{ stepId: 'helmsman-agent', priority: 50 }] },
    onFailure: { next: [{ stepId: 'helmsman-agent', priority: 50 }] },
  } as StepDefinition;
}

function makeCtx(spaceId: string | undefined) {
  return {
    tenantId: 'a0000000-0000-0000-0000-000000000001' as never,
    runId: 'session-1' as never,
    traceId: 'trace-1' as never,
    ...(spaceId ? { spaceId } : {}),
    agentDefinition: {
      agentId: 'helmsman',
      version: 'v1',
      name: 'Helmsman',
      description: '',
      startStepId: 'helmsman-agent',
      steps: [makeFocusStepDef()],
      metadata: {},
    },
  };
}

const mockPayloadStore = {
  retrieve: vi.fn(),
  shouldStore: () => false,
} as unknown as Parameters<typeof handleHumanActionCenterFocusInline>[1];

/** The Redis keys the attention cache reads, holding what each test puts there. */
const cached = new Map<string, string>();
const mockRedis = {
  get: (key: string) => Promise.resolve(cached.get(key) ?? null),
} as unknown as Parameters<typeof handleHumanActionCenterFocusInline>[0];

const TENANT = 'a0000000-0000-0000-0000-000000000001';

/** The space's attention block as the cache holds it, listing the items given. */
function cacheAttention(spaceId: string, items: Array<Record<string, unknown>>): void {
  cached.set(`entity:attention:gen:${TENANT}:${spaceId}`, '7');
  cached.set(
    `entity:attention:${TENANT}:${spaceId}:7`,
    JSON.stringify({ waitingOnPerson: { items } }),
  );
}

async function focus(spaceId: string, input: Record<string, unknown>) {
  (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(input);
  await handleHumanActionCenterFocusInline(
    mockRedis,
    mockPayloadStore,
    makeCtx(spaceId) as never,
    makeFocusStepDef(),
    'exec-9' as StepExecutionId,
    'idem-9' as IdempotencyKey,
    inlineRef(input),
    0,
    Date.now(),
  );
  return mockAddStepResult.mock.calls[0]![1] as {
    status: string;
    outputRef?: string;
    error?: { message: string };
  };
}

beforeEach(() => {
  mockAddStepResult.mockReset();
  mockPublishActionCenterFocus.mockReset();
  (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockReset();
  cached.clear();
});

describe('handleHumanActionCenterFocusInline — Plan 156 §5.6.2', () => {
  it('publishes a focus signal scoped to {tenantId, spaceId} and emits SUCCESS', async () => {
    const stepDef = makeFocusStepDef();
    const ctx = makeCtx('space-aaa');

    const input = {
      itemId: 'proposal:abc',
      reason: 'Coach wants you to ratify this.',
    };
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(input);

    await handleHumanActionCenterFocusInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      stepDef,
      'exec-1' as StepExecutionId,
      'idem-1' as IdempotencyKey,
      inlineRef(input),
      0,
      Date.now(),
    );

    expect(mockPublishActionCenterFocus).toHaveBeenCalledTimes(1);
    const [, payload] = mockPublishActionCenterFocus.mock.calls[0]!;
    expect(payload).toMatchObject({
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      spaceId: 'space-aaa',
      itemId: 'proposal:abc',
      reason: 'Coach wants you to ratify this.',
    });
    expect((payload as Record<string, unknown>).placement).toBeUndefined();

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      outputRef: string;
    };
    expect(result.status).toBe('SUCCEEDED');
    expect(decodeInline(result.outputRef)).toMatchObject({
      acknowledged: true,
      itemId: 'proposal:abc',
    });
  });

  it('FAILS with a prescriptive correction when itemId is a bare UUID (no prefix)', async () => {
    // Regression for the hallucinated-id case: agent passes a raw UUID
    // instead of the prefixed listing-op id. Zod rejects at parse time;
    // the handler should surface a teaching error so the agent's next
    // turn knows what to do (call proposal.list, or switch to chat.ask).
    const stepDef = makeFocusStepDef();
    const ctx = makeCtx('space-ccc');

    const bareUuid = '4ebbe8e1-6ed0-4300-aec2-2e2c570eb10e';
    const input = { itemId: bareUuid };
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(input);

    await handleHumanActionCenterFocusInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      stepDef,
      'exec-4' as StepExecutionId,
      'idem-4' as IdempotencyKey,
      inlineRef(input),
      0,
      Date.now(),
    );

    expect(mockPublishActionCenterFocus).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      error: { message: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error.message).toContain('proposal.list');
    expect(result.error.message).toContain('human.chat.ask');
  });

  it('SUCCESS output carries a contextual `note` hint for the agent', async () => {
    // Mirror of the "tools teach at point of use" rule: success carries
    // a discriminated next-step hint so the agent doesn't need to read
    // a separate prompt section to know what to do after focusing.
    const stepDef = makeFocusStepDef();
    const ctx = makeCtx('space-ddd');

    const input = { itemId: 'proposal:xyz' };
    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(input);

    await handleHumanActionCenterFocusInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      stepDef,
      'exec-5' as StepExecutionId,
      'idem-5' as IdempotencyKey,
      inlineRef(input),
      0,
      Date.now(),
    );

    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; outputRef: string };
    expect(result.status).toBe('SUCCEEDED');
    const decoded = decodeInline(result.outputRef) as { note?: string };
    expect(decoded.note).toBeTruthy();
    expect(decoded.note).toContain('End your turn');
  });

  it('FAILS (does not throw) when run context has no spaceId', async () => {
    const stepDef = makeFocusStepDef();
    const ctx = makeCtx(undefined);

    (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      itemId: 'proposal:abc',
    });

    await handleHumanActionCenterFocusInline(
      mockRedis,
      mockPayloadStore,
      ctx as never,
      stepDef,
      'exec-3' as StepExecutionId,
      'idem-3' as IdempotencyKey,
      inlineRef({ itemId: 'proposal:abc' }),
      0,
      Date.now(),
    );

    expect(mockPublishActionCenterFocus).not.toHaveBeenCalled();
    const result = mockAddStepResult.mock.calls[0]![1] as { status: string; error: unknown };
    expect(result.status).toBe('FAILED');
  });
});

describe('a focus on an item the attention block lists', () => {
  it('carries the kind and title the block listed it by', async () => {
    cacheAttention('space-eee', [
      {
        kind: 'plan_step',
        itemId: 'plan-ask:node-1',
        title: 'Pending approval: Ship the release',
        requestedAt: '2026-11-01T10:00:00.000Z',
        planNodeId: 'node-1',
      },
    ]);

    const result = await focus('space-eee', { itemId: 'plan-ask:node-1' });

    expect(result.status).toBe('SUCCEEDED');
    expect(decodeInline(result.outputRef!)).toMatchObject({
      itemId: 'plan-ask:node-1',
      listed: { kind: 'plan_step', title: 'Pending approval: Ship the release' },
    });
  });

  it('carries nothing listed where the block is not cached or does not list the id', async () => {
    const uncached = await focus('space-fff', { itemId: 'workflow-task:run-1:task-1' });
    expect(decodeInline(uncached.outputRef!)).not.toHaveProperty('listed');

    mockAddStepResult.mockReset();
    cacheAttention('space-fff', []);
    const unlisted = await focus('space-fff', { itemId: 'workflow-task:run-1:task-1' });
    expect(unlisted.status).toBe('SUCCEEDED');
    expect(decodeInline(unlisted.outputRef!)).not.toHaveProperty('listed');
  });

  it.each([
    'plan-ask:node-1',
    'plan-decision:node-2',
    'workflow-task:run-1:task-1',
    'workflow-write-approval:run-1:2',
    'workflow-oauth-consent:run-1',
  ])('names the field at fault, not the id, when %s fails on another field', async (itemId) => {
    const result = await focus('space-ggg', { itemId, reason: 'x'.repeat(281) });

    expect(result.status).toBe('FAILED');
    expect(result.error!.message).toContain('reason');
    expect(result.error!.message).not.toContain('not from a listing op');
  });
});
