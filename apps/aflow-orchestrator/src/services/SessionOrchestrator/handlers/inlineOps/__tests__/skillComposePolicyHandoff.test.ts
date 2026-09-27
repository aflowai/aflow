import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import type { IdempotencyKey, StepDefinition, StepExecutionId } from '@aflow/schemas';
import type { InlineHandlerArgs } from '../types.js';
import { createMemoryPayloadStore } from '@aflow/payload-store';

const mockAddStepResult = vi.fn();
const mockCheckMissingCapabilities = vi.fn<(...args: unknown[]) => Promise<string[]>>();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(async () => null),
}));

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getDatabase: vi.fn(() => ({})) };
});

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkMissingCapabilities: (...args: unknown[]) => mockCheckMissingCapabilities(...args),
  };
});

function decodeInline(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * The shipped coding skill stands in for a composed bundle: it is a real,
 * graph-valid workflow whose tasks carry `code.*` operations, so the handler
 * reaches the capability check instead of tripping an earlier validator.
 */
function assembledCodingSkill(): Record<string, unknown> {
  const entry = getSkillCatalogEntry('open-pr-from-request');
  if (!entry) throw new Error('open-pr-from-request must exist in the skill catalog');
  const { workflow, manifest } = entry.bundle;
  return {
    workflow,
    ...(manifest.campaign ? { campaign: manifest.campaign } : {}),
    ...(typeof manifest.goal === 'object' ? { goal: manifest.goal } : {}),
  };
}

function makeArgs(): InlineHandlerArgs {
  const stepDef = {
    stepId: 'wf_task__validate-and-propose__execute__a1',
    stepType: 'skill',
    operation: 'skill.compose.propose',
    config: {},
    tags: ['dynamic', '_taskId:validate-and-propose'],
    onSuccess: { next: [] },
    onFailure: { next: [] },
  } as unknown as StepDefinition;
  const opInput = { assembled: assembledCodingSkill() };
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: '11111111-1111-4111-8111-111111111111',
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
      traceId: 'trace-1',
      agentDefinition: { steps: [stepDef] },
    } as never,
    stepDef,
    stepExecutionId: 'step-exec-1' as StepExecutionId,
    idempotencyKey: 'idem-1' as IdempotencyKey,
    resolvedInputRef: `inline:${Buffer.from(JSON.stringify(opInput)).toString('base64')}`,
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

describe('skill.compose.propose — a disabled lane is an operator setting, not a regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pauses with the space-settings handoff when the coding lane is off', async () => {
    mockCheckMissingCapabilities.mockResolvedValue(['code']);

    const { handleSkillComposeInline } = await import('../skillCompose.js');
    await handleSkillComposeInline(makeArgs());

    const msg = mockAddStepResult.mock.calls.at(-1)?.[1] as {
      status: string;
      requestedInputRef: string;
    };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('blocked');
    expect(payload['reason']).toBe('policy_disabled');
    expect(payload['missing']).toEqual([{ kind: 'policy', identifier: 'code' }]);
    expect(payload['handoff']).toEqual({
      skillSlug: 'space-settings',
      prefill: { policies: ['code'], enable: true },
    });
  });

  it('still fails an unbound API reference as an invariant regression', async () => {
    mockCheckMissingCapabilities.mockResolvedValue(['github']);

    const { handleSkillComposeInline } = await import('../skillCompose.js');
    await handleSkillComposeInline(makeArgs());

    const msg = mockAddStepResult.mock.calls.at(-1)?.[1] as { status: string; errorRef: string };
    expect(msg.status).toBe('FAILED');
    expect(decodeInline(msg.errorRef)['code']).toBe('BUNDLE_INVARIANT_REGRESSION');
  });
});
