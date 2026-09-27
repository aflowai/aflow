import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  appendEntityEvent: vi.fn(),
}));

import { handleProposalCrudInline } from '../proposalCrud.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = 'a66bd50b-2c17-4a36-bcc4-5538a8fc2961';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeOutput(ref: string): Record<string, unknown> {
  const decoded = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8');
  return JSON.parse(decoded) as Record<string, unknown>;
}

function makeArgs(operation: string, input: unknown): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: {
      retrieve: vi.fn(async () => input),
    } as never,
    context: {
      tenantId: TENANT_ID,
      runId: 'session-1',
      traceId: 'trace-1',
      spaceId: SPACE_ID,
      actorContext: {},
      agentDefinition: { steps: [] },
    } as never,
    stepDef: {
      stepId: 'step-1',
      stepType: 'proposal',
      operation,
    } as never,
    stepExecutionId: 'sx-1' as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inlineRef(input),
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

beforeEach(() => {
  mockAddStepResult.mockReset();
});

describe('proposalCrud inline-op gate (Plan 156 §7A)', () => {
  it.each(['proposal.ratify', 'proposal.reject', 'proposal.dismiss'])(
    '%s emits PROPOSAL_MUTATION_NOT_PERMITTED pointing at human.action_center.focus',
    async (operation) => {
      await handleProposalCrudInline(
        makeArgs(operation, { proposalId: '00000000-0000-0000-0000-000000000001' }),
      );

      expect(mockAddStepResult).toHaveBeenCalledTimes(1);
      const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
      expect(msg['status']).toBe('FAILED');

      const err = decodeOutput(msg['errorRef'] as string);
      expect(err['code']).toBe('PROPOSAL_MUTATION_NOT_PERMITTED');
      // The error message must name the recovery path so the agent's next
      // turn knows what to call instead. Loose match — wording may evolve
      // but the op name should always appear.
      expect(String(err['message'])).toContain('human.action_center.focus');
    },
  );

  // Read ops stay callable — the gate is mutation-only. This pin keeps the
  // gate from accidentally widening into "no proposal ops at all."
  it('proposal.list is NOT gated (read path stays open for summarization)', async () => {
    await handleProposalCrudInline(makeArgs('proposal.list', { pendingOnly: true }));
    // The gate does not fire. We can't easily assert success without
    // mocking the entire DB read path, but we can assert the gate did NOT
    // emit the mutation-not-permitted error code.
    if (mockAddStepResult.mock.calls.length > 0) {
      const msg = mockAddStepResult.mock.calls[0]![1] as Record<string, unknown>;
      if (msg['errorRef']) {
        const err = decodeOutput(msg['errorRef'] as string);
        expect(err['code']).not.toBe('PROPOSAL_MUTATION_NOT_PERMITTED');
      }
    }
  });
});
