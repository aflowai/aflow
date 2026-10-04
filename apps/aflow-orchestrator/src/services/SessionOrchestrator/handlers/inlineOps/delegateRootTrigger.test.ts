/**
 * A delegated session is queued holding its parent's root trigger, so a Runner
 * a person's conversation delegated to counts as attended and the same one a
 * schedule reached does not. The delegation's input is the agent's to write
 * and names nothing that counts.
 */
import type { SessionHotState } from '@aflow/redis';
import type {
  IdempotencyKey,
  SessionId,
  StepDefinition,
  StepExecutionId,
  TenantId,
  TraceId,
} from '@aflow/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionState = vi.fn();
const mockSetSessionState = vi.fn();
const mockAddControlMessage = vi.fn();
const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  setSessionState: (...args: unknown[]) => mockSetSessionState(...args),
  addControlMessage: (...args: unknown[]) => mockAddControlMessage(...args),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  appendSessionEvent: vi.fn(async () => undefined),
  markSessionDirty: vi.fn(async () => undefined),
  addWaitingChild: vi.fn(async () => undefined),
  scheduleShardTimer: vi.fn(async () => undefined),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: () => ({}),
  loadAgentTargetDefinition: vi.fn(),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadSpaceDirectives: vi.fn(async () => undefined),
}));

vi.mock('./helpers.js', () => ({
  encodeInlineOpOutputRef: vi.fn(async () => 'inline:e30='),
}));

const { handleDelegateInline } = await import('./delegate.js');

const TENANT = 'tenant-delegate-root' as TenantId;
const PARENT = '00000000-0000-0000-0000-0000000000d1' as SessionId;
const SPACE = '00000000-0000-0000-0000-0000000000d2';

const stepDef = {
  stepId: 'delegate_1',
  stepType: 'agent',
  operation: 'agent.control.delegate',
  config: {},
  tags: [],
  optional: false,
  onSuccess: { next: [] },
  onFailure: { next: [] },
} as unknown as StepDefinition;

/** What the parent's agent asks for, a trigger of its choosing among it. */
const delegation = {
  target: { kind: 'platform-role', systemRole: 'web-researcher' },
  input: 'look this up',
  wait: false,
  rootTrigger: 'chat',
  trigger: 'chat',
};

async function delegateFrom(parent: Partial<SessionHotState>): Promise<{
  queued: SessionHotState;
  started: Record<string, unknown>;
}> {
  mockGetSessionState.mockResolvedValue({ sessionId: PARENT, status: 'RUNNING', ...parent });
  await handleDelegateInline({
    redis: {} as never,
    payloadStore: { retrieve: vi.fn(async () => delegation) } as never,
    context: {
      tenantId: TENANT,
      runId: PARENT,
      agentDefinition: {} as never,
      traceId: 'trace-d' as TraceId,
      spaceId: SPACE,
    },
    stepDef,
    stepExecutionId: '00000000-0000-0000-0000-0000000000d3' as StepExecutionId,
    idempotencyKey: 'delegate-key' as IdempotencyKey,
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
  });
  expect(mockAddStepResult.mock.calls[0]?.[1]).toMatchObject({ status: 'SUCCEEDED' });
  return {
    queued: mockSetSessionState.mock.calls[0]?.[1] as SessionHotState,
    started: mockAddControlMessage.mock.calls[0]?.[1] as Record<string, unknown>,
  };
}

beforeEach(() => {
  mockGetSessionState.mockReset();
  mockSetSessionState.mockReset().mockResolvedValue(undefined);
  mockAddControlMessage.mockReset().mockResolvedValue(undefined);
  mockAddStepResult.mockReset().mockResolvedValue(undefined);
});

describe('a delegated session’s root trigger', () => {
  it('is a person’s conversation when the parent’s root is one', async () => {
    const { queued, started } = await delegateFrom({ trigger: 'chat', rootTrigger: 'chat' });
    expect(queued.rootTrigger).toBe('chat');
    expect(started).not.toHaveProperty('trigger');
  });

  it('is the schedule when a schedule started the parent’s root, whatever the input says', async () => {
    const { queued, started } = await delegateFrom({ rootTrigger: 'schedule' });
    expect(queued.rootTrigger).toBe('schedule');
    expect(queued).not.toHaveProperty('trigger');
    expect(started).not.toHaveProperty('trigger');
  });

  it('is absent when the parent holds none', async () => {
    const { queued } = await delegateFrom({ trigger: 'chat' });
    expect(queued).not.toHaveProperty('rootTrigger');
  });
});
