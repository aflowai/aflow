import { describe, expect, it } from 'vitest';

import {
  AgentTurnDecisionSchema,
  BLOCKED_REASON_AUTO_CONVERT_PREFIX,
  buildImplicitTextOnlyAgentDecision,
  canImplicitlyPauseOnTextOnly,
  findBlockedSignalTool,
  getAllowedAgentDecisionActions,
  isExplicitlyBlockedPauseDecision,
  isPauseForInputAllowed,
  normalizeDisallowedPauseDecision,
} from './agentTurn.js';

const signalBlockedTool = {
  toolId: 'signal_blocked',
  operationId: 'agent.control.signal_blocked',
  inputSchema: {
    type: 'object',
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      category: {
        type: 'string',
        enum: [
          'missing_input',
          'ambiguous_requirement',
          'approval_required',
          'external_dependency',
          'access_denied',
          'capability_unavailable',
          'data_unavailable',
          'other',
        ],
      },
      needed: { type: 'string', maxLength: 500 },
    },
    required: ['reason', 'category'],
  },
};

const unrelatedTool = {
  toolId: 'memory.store.put',
  operationId: 'memory.store.put',
  inputSchema: { type: 'object', properties: {} },
};

describe('agent turn pause policy helpers', () => {
  describe('policy predicates', () => {
    it('isPauseForInputAllowed: only never forbids the action entirely', () => {
      expect(isPauseForInputAllowed('allowed')).toBe(true);
      expect(isPauseForInputAllowed('blocked_only')).toBe(true);
      expect(isPauseForInputAllowed('never')).toBe(false);
      expect(isPauseForInputAllowed(undefined)).toBe(true);
    });

    it('canImplicitlyPauseOnTextOnly: allowed and blocked_only opt in; never does not', () => {
      expect(canImplicitlyPauseOnTextOnly('allowed')).toBe(true);
      expect(canImplicitlyPauseOnTextOnly('blocked_only')).toBe(true);
      expect(canImplicitlyPauseOnTextOnly('never')).toBe(false);
      expect(canImplicitlyPauseOnTextOnly(undefined)).toBe(true);
    });
  });

  describe('getAllowedAgentDecisionActions', () => {
    it('removes pause_for_input when input requests are disabled', () => {
      expect(
        getAllowedAgentDecisionActions({
          requestInputPolicy: 'never',
          allowComplete: true,
        }),
      ).toEqual(['invoke_step', 'invoke_steps', 'complete']);
    });

    it('keeps pause_for_input under blocked_only (explicit blocks are legitimate)', () => {
      expect(
        getAllowedAgentDecisionActions({
          requestInputPolicy: 'blocked_only',
          allowComplete: true,
        }),
      ).toEqual(['invoke_step', 'invoke_steps', 'pause_for_input', 'complete']);
    });
  });

  describe('buildImplicitTextOnlyAgentDecision (text-only fallback)', () => {
    it('assistant (allowed): text-only maps to pause_for_input', () => {
      expect(
        buildImplicitTextOnlyAgentDecision({
          requestInputPolicy: 'allowed',
          allowComplete: true,
          message: 'Here is what I think.',
        }),
      ).toEqual({
        action: 'pause_for_input',
        message: 'Here is what I think.',
      });
    });

    it('subagent (blocked_only): text-only maps to pause_for_input with auto blockingReason', () => {
      const result = buildImplicitTextOnlyAgentDecision({
        requestInputPolicy: 'blocked_only',
        allowComplete: true,
        message: 'I need the API endpoint URL to proceed.',
      });
      expect(result.action).toBe('pause_for_input');
      expect(result.message).toBe('I need the API endpoint URL to proceed.');
      expect((result as Record<string, unknown>)['blockingReason']).toBeTruthy();
      expect((result as Record<string, unknown>)['blockingCategory']).toBe('missing_input');
    });

    it('subagent (never): text-only maps to complete', () => {
      expect(
        buildImplicitTextOnlyAgentDecision({
          requestInputPolicy: 'never',
          allowComplete: true,
          message: 'Final summary',
        }),
      ).toEqual({
        action: 'complete',
        result: 'Final summary',
        message: 'Final summary',
      });
    });

    it('falls back to pause_for_input when completion is not allowed (never policy)', () => {
      expect(
        buildImplicitTextOnlyAgentDecision({
          requestInputPolicy: 'never',
          allowComplete: false,
          message: 'Status update',
        }),
      ).toEqual({
        action: 'pause_for_input',
        message: 'Status update',
      });
    });

    it('never + no completion: routes text-only through the blocked-signal tool when present', () => {
      const decision = buildImplicitTextOnlyAgentDecision({
        requestInputPolicy: 'never',
        allowComplete: false,
        message: 'I need the dataset location to continue.',
        availableTools: [unrelatedTool, signalBlockedTool],
      });
      expect(decision).toEqual({
        action: 'invoke_step',
        toolId: 'signal_blocked',
        args: {
          reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}I need the dataset location to continue.`,
          category: 'missing_input',
        },
        message: 'I need the dataset location to continue.',
      });
      expect(AgentTurnDecisionSchema.safeParse(decision).success).toBe(true);
    });

    it('never + completion allowed: still completes even when the blocked-signal tool is present', () => {
      expect(
        buildImplicitTextOnlyAgentDecision({
          requestInputPolicy: 'never',
          allowComplete: true,
          message: 'Final summary',
          availableTools: [signalBlockedTool],
        }),
      ).toEqual({
        action: 'complete',
        result: 'Final summary',
        message: 'Final summary',
      });
    });

    it('blocked_only: text-only stays a pause with blocking metadata even when the tool is present', () => {
      const decision = buildImplicitTextOnlyAgentDecision({
        requestInputPolicy: 'blocked_only',
        allowComplete: true,
        message: 'I need the API endpoint URL to proceed.',
        availableTools: [signalBlockedTool],
      });
      expect(decision.action).toBe('pause_for_input');
      expect((decision as Record<string, unknown>)['blockingReason']).toBeTruthy();
      expect((decision as Record<string, unknown>)['blockingCategory']).toBe('missing_input');
    });

    it('never + no completion: truncates the blocking reason to the tool schema cap', () => {
      const decision = buildImplicitTextOnlyAgentDecision({
        requestInputPolicy: 'never',
        allowComplete: false,
        message: 'x'.repeat(5000),
        availableTools: [signalBlockedTool],
      });
      expect(decision.action).toBe('invoke_step');
      if (decision.action !== 'invoke_step') return;
      expect((decision.args['reason'] as string).length).toBe(1000);
      expect((decision.message as string).length).toBe(5000);
    });

    it('never + no completion: falls back to the first enum entry when missing_input is absent', () => {
      const narrowEnumTool = {
        ...signalBlockedTool,
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string', maxLength: 200 },
            category: { type: 'string', enum: ['external_dependency', 'other'] },
          },
          required: ['reason', 'category'],
        },
      };
      const decision = buildImplicitTextOnlyAgentDecision({
        requestInputPolicy: 'never',
        allowComplete: false,
        message: 'Blocked on upstream service.',
        availableTools: [narrowEnumTool],
      });
      expect(decision.action).toBe('invoke_step');
      if (decision.action !== 'invoke_step') return;
      expect(decision.args['category']).toBe('external_dependency');
    });
  });

  describe('normalizeDisallowedPauseDecision', () => {
    it('never + allowComplete: coerces pause to complete', () => {
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'never',
          allowComplete: true,
          decision: {
            action: 'pause_for_input',
            message: 'All work is done.',
            reasoning: 'Summarizing the result',
          },
        }),
      ).toEqual({
        action: 'complete',
        result: 'All work is done.',
        message: 'All work is done.',
        reasoning: 'Summarizing the result',
      });
    });

    it('blocked_only: coerces pause WITHOUT blocking metadata to complete', () => {
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'blocked_only',
          allowComplete: true,
          decision: {
            action: 'pause_for_input',
            message: 'Here is my finished review.',
          },
        }),
      ).toEqual({
        action: 'complete',
        result: 'Here is my finished review.',
        message: 'Here is my finished review.',
      });
    });

    it('blocked_only: preserves pause WITH blockingReason (legitimate block)', () => {
      const decision = {
        action: 'pause_for_input' as const,
        message: 'Need API key',
        blockingReason: 'Missing credentials for external service',
      };
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'blocked_only',
          allowComplete: true,
          decision,
        }),
      ).toEqual(decision);
    });

    it('blocked_only: preserves pause WITH blockingCategory (legitimate block)', () => {
      const decision = {
        action: 'pause_for_input' as const,
        message: 'Waiting on approval',
        blockingCategory: 'approval_required' as const,
      };
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'blocked_only',
          allowComplete: true,
          decision,
        }),
      ).toEqual(decision);
    });

    it('allowed: leaves any pause untouched', () => {
      const decision = {
        action: 'pause_for_input' as const,
        message: 'Which option do you prefer?',
      };
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'allowed',
          allowComplete: true,
          decision,
        }),
      ).toEqual(decision);
    });

    it('non-pause decisions are always left untouched', () => {
      const decision = { action: 'complete' as const, result: 'ok' };
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'blocked_only',
          allowComplete: true,
          decision,
        }),
      ).toBe(decision);
    });

    it('never + no completion: coerces pause into the blocked-signal call when the tool is present', () => {
      const decision = normalizeDisallowedPauseDecision({
        requestInputPolicy: 'never',
        allowComplete: false,
        availableTools: [unrelatedTool, signalBlockedTool],
        decision: {
          action: 'pause_for_input',
          message: 'Which API should I use?',
          reasoning: 'Unsure about the binding',
        },
      });
      expect(decision).toEqual({
        action: 'invoke_step',
        toolId: 'signal_blocked',
        args: {
          reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}Which API should I use?`,
          category: 'missing_input',
        },
        message: 'Which API should I use?',
        reasoning: 'Unsure about the binding',
      });
      expect(AgentTurnDecisionSchema.safeParse(decision).success).toBe(true);
    });

    it('never + no completion: leaves the pause alone when the tool is absent (validation rejects loudly)', () => {
      const decision = {
        action: 'pause_for_input' as const,
        message: 'Which API should I use?',
      };
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'never',
          allowComplete: false,
          availableTools: [unrelatedTool],
          decision,
        }),
      ).toBe(decision);
    });

    it('blocked_only + no completion: never coerces into the blocked-signal call', () => {
      const decision = {
        action: 'pause_for_input' as const,
        message: 'Need approval before writing.',
      };
      expect(
        normalizeDisallowedPauseDecision({
          requestInputPolicy: 'blocked_only',
          allowComplete: false,
          availableTools: [signalBlockedTool],
          decision,
        }),
      ).toBe(decision);
    });
  });

  describe('findBlockedSignalTool', () => {
    it('matches by operationId, not toolId', () => {
      const renamed = { ...signalBlockedTool, toolId: 'escalate' };
      expect(findBlockedSignalTool([unrelatedTool, renamed])).toBe(renamed);
      expect(
        findBlockedSignalTool([{ ...unrelatedTool, toolId: 'signal_blocked' }]),
      ).toBeUndefined();
      expect(findBlockedSignalTool(undefined)).toBeUndefined();
    });
  });

  describe('isExplicitlyBlockedPauseDecision', () => {
    it('returns true when blockingReason is non-empty', () => {
      expect(
        isExplicitlyBlockedPauseDecision({
          action: 'pause_for_input',
          message: 'Need input',
          blockingReason: 'Missing data',
        }),
      ).toBe(true);
    });

    it('returns true when blockingCategory is set', () => {
      expect(
        isExplicitlyBlockedPauseDecision({
          action: 'pause_for_input',
          message: 'Need input',
          blockingCategory: 'missing_input',
        }),
      ).toBe(true);
    });

    it('returns false when neither is present', () => {
      expect(
        isExplicitlyBlockedPauseDecision({
          action: 'pause_for_input',
          message: 'Need input',
        }),
      ).toBe(false);
    });

    it('returns false when action is not pause_for_input', () => {
      expect(
        isExplicitlyBlockedPauseDecision({
          action: 'complete',
          result: 'done',
        }),
      ).toBe(false);
    });
  });

  describe('AgentTurnDecisionSchema invoke_step args', () => {
    it('rejects invoke_step when args is missing', () => {
      const result = AgentTurnDecisionSchema.safeParse({
        action: 'invoke_step',
        toolId: 'memory.store.put',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const argsIssue = result.error.issues.find((i) => i.path.includes('args'));
        expect(argsIssue).toBeDefined();
      }
    });

    it('rejects invoke_step when args is null', () => {
      const result = AgentTurnDecisionSchema.safeParse({
        action: 'invoke_step',
        toolId: 'memory.store.put',
        args: null,
      });
      expect(result.success).toBe(false);
    });

    it('accepts invoke_step with empty args object', () => {
      const result = AgentTurnDecisionSchema.safeParse({
        action: 'invoke_step',
        toolId: 'memory.store.put',
        args: {},
      });
      expect(result.success).toBe(true);
    });

    it('rejects invoke_steps when a call has missing args', () => {
      const result = AgentTurnDecisionSchema.safeParse({
        action: 'invoke_steps',
        calls: [{ toolId: 'memory.store.put' }],
      });
      expect(result.success).toBe(false);
    });
  });
});
