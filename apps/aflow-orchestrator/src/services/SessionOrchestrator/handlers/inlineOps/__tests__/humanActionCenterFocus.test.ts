import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';

const mockAddStepResult = vi.fn();
const mockPublishActionCenterFocus = vi.fn();

vi.mock('@aflow/redis', () => ({
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

const mockRedis = {} as Parameters<typeof handleHumanActionCenterFocusInline>[0];

beforeEach(() => {
  mockAddStepResult.mockReset();
  mockPublishActionCenterFocus.mockReset();
  (mockPayloadStore.retrieve as ReturnType<typeof vi.fn>).mockReset();
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
