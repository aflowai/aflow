import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from '../schema.js';
import {
  buildAgentDecisionRawJsonSchema,
  validateAgentDecisionForPersistence,
} from './agentTurnDecision.js';
import { AgentTurnDecisionSchema } from '@aflow/schemas';
import type { AgentTurnDecision } from '@aflow/schemas';
import type { HandlerDeps } from './types.js';

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    prompt: 'do work',
    availableTools: [
      {
        toolId: 'memory.store.put',
        operationId: 'memory.store.put',
        stepType: 'memory',
        name: 'Memory Put',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    ],
    policy: {
      maxToolCallsPerTurn: 5,
      allowParallel: true,
      maxParallel: 2,
      allowComplete: true,
    },
    turnNumber: 0,
    model: 'test-model',
    ...overrides,
  };
}

describe('buildAgentDecisionRawJsonSchema (flat object, Zod-authoritative)', () => {
  // The schema is intentionally flat (single root object, all per-action
  // requirements encoded in property descriptions) so Anthropic's adapter does
  // not strip it via the top-level-anyOf rule. Per-branch enforcement runs
  // authoritatively in `AgentTurnDecisionSchema` (Zod) on the response.

  it('returns a single root object schema (no top-level anyOf/oneOf)', () => {
    const schema = buildAgentDecisionRawJsonSchema(baseInput());
    expect(schema['type']).toBe('object');
    expect(schema['anyOf']).toBeUndefined();
    expect(schema['oneOf']).toBeUndefined();
    expect(schema['allOf']).toBeUndefined();
  });

  it('lists every allowed action in the action enum and only "action" as required', () => {
    const schema = buildAgentDecisionRawJsonSchema(baseInput());
    const actionProp = (schema['properties'] as Record<string, Record<string, unknown>>)['action']!;
    expect(actionProp['enum']).toEqual(
      expect.arrayContaining(['invoke_step', 'invoke_steps', 'pause_for_input', 'complete']),
    );
    expect(schema['required']).toEqual(['action']);
  });

  it('includes calls/toolId/args/result/message/reasoning properties for the model to fill', () => {
    const schema = buildAgentDecisionRawJsonSchema(baseInput());
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['toolId']).toBeDefined();
    expect(props['args']).toBeDefined();
    expect(props['calls']).toBeDefined();
    expect(props['result']).toBeDefined();
    expect(props['message']).toBeDefined();
    expect(props['reasoning']).toBeDefined();
  });

  it('encodes per-action required fields in the action enum description', () => {
    const schema = buildAgentDecisionRawJsonSchema(baseInput());
    const actionProp = (schema['properties'] as Record<string, Record<string, unknown>>)['action']!;
    const desc = actionProp['description'] as string;
    expect(desc).toMatch(/invoke_step.*REQUIRES.*toolId.*args/);
    expect(desc).toMatch(/invoke_steps.*REQUIRES.*calls/);
  });

  it('drops actions disabled by policy (e.g. requestInputPolicy=never)', () => {
    const schema = buildAgentDecisionRawJsonSchema(baseInput({ requestInputPolicy: 'never' }));
    const actionProp = (schema['properties'] as Record<string, Record<string, unknown>>)['action']!;
    const actions = actionProp['enum'] as string[];
    expect(actions).not.toContain('pause_for_input');
    expect(actions).toContain('invoke_step');
    expect(actions).toContain('complete');
  });

  // ---- Zod-level enforcement (the authoritative validator on the response) ----

  it('Zod: invoke_step without args is rejected', () => {
    expect(
      AgentTurnDecisionSchema.safeParse({ action: 'invoke_step', toolId: 'memory.store.put' })
        .success,
    ).toBe(false);
  });

  it('Zod: invoke_step with empty args object is accepted', () => {
    expect(
      AgentTurnDecisionSchema.safeParse({
        action: 'invoke_step',
        toolId: 'memory.store.put',
        args: {},
      }).success,
    ).toBe(true);
  });

  it('Zod: invoke_step with args=null is rejected', () => {
    expect(
      AgentTurnDecisionSchema.safeParse({
        action: 'invoke_step',
        toolId: 'memory.store.put',
        args: null,
      }).success,
    ).toBe(false);
  });

  it('Zod: invoke_steps without calls is rejected', () => {
    expect(AgentTurnDecisionSchema.safeParse({ action: 'invoke_steps' }).success).toBe(false);
  });
});

// ============================================================================
// Persistence-validation + repair guidance under requestInputPolicy: 'never'
// ============================================================================
//

const noopDeps: HandlerDeps = {
  validateToolArgs: () => null,
  payloadStore: undefined as unknown as HandlerDeps['payloadStore'],
};

function inputWithRunnerTools(): AgentTurnInput {
  return baseInput({
    requestInputPolicy: 'never',
    availableTools: [
      ...baseInput().availableTools,
      {
        toolId: 'signal_blocked',
        operationId: 'agent.control.signal_blocked',
        stepType: 'agent',
        name: 'Signal Blocked',
        inputSchema: {
          type: 'object',
          properties: { reason: { type: 'string' }, category: { type: 'string' } },
          required: ['reason', 'category'],
        },
      },
      {
        toolId: 'submit_output',
        operationId: 'agent.control.submit_output',
        stepType: 'agent',
        name: 'Submit Output',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      },
    ],
  });
}

const pauseDecision: AgentTurnDecision = {
  action: 'pause_for_input',
  message: 'Which API would you like to bind?',
};

describe('validateAgentDecisionForPersistence — pause under never policy', () => {
  it('rejects pause_for_input with a signal_blocked hint when that tool is in the surface', () => {
    const result = validateAgentDecisionForPersistence(
      inputWithRunnerTools(),
      noopDeps,
      pauseDecision,
    );
    expect(result.kind).toBe('repairable_reject');
    if (result.kind !== 'repairable_reject') return;
    expect(result.code).toBe('policy_violation');
    expect(result.reason).toMatch(/signal_blocked/);
    expect(result.reason).toMatch(/pause_for_input is not allowed/);
    // Should NOT push the runner toward `complete` with a fabricated result.
    expect(result.reason).not.toMatch(/Use complete/);
  });

  it('rejects pause_for_input without a signal_blocked hint when the agent does not have that tool', () => {
    const result = validateAgentDecisionForPersistence(
      baseInput({ requestInputPolicy: 'never' }),
      noopDeps,
      pauseDecision,
    );
    expect(result.kind).toBe('repairable_reject');
    if (result.kind !== 'repairable_reject') return;
    expect(result.reason).not.toMatch(/signal_blocked/);
    expect(result.reason).toMatch(/Do NOT call pause_for_input again/);
  });
});

// ============================================================================

const submitOutputCallingValidateToolArgs = vi.fn();
const trackingDeps: HandlerDeps = {
  validateToolArgs: (...args) => {
    submitOutputCallingValidateToolArgs(...args);
    return null;
  },
  payloadStore: undefined as unknown as HandlerDeps['payloadStore'],
};

function inputWithSubmitOutputAndDeepInvariantSchema(): AgentTurnInput {
  return baseInput({
    requestInputPolicy: 'never',
    availableTools: [
      {
        toolId: 'submit_output',
        operationId: 'agent.control.submit_output',
        stepType: 'agent',
        name: 'Submit Output',
        // Deep input schema with an `if/then` invariant — the kind that
        // would fail Ajv at persistence time and trigger the (failing)
        // generateJson repair path.
        inputSchema: {
          type: 'object',
          properties: {
            result: {
              type: 'object',
              properties: {
                tasks: {
                  type: 'array',
                  items: {
                    if: { properties: { type: { const: 'agent' } } },
                    then: { required: ['providesPurposeId'] },
                  },
                },
              },
            },
          },
          required: ['result'],
        },
      },
    ],
  });
}

describe('validateAgentDecisionForPersistence — submit_output defers to handler', () => {
  it('does NOT call validateToolArgs for invoke_step on submit_output', () => {
    const decision: AgentTurnDecision = {
      action: 'invoke_step',
      toolId: 'submit_output',
      args: {
        result: {
          // Intentionally invalid against the schema's `if/then` rule —
          // would normally trigger a `repairable_reject`. With the fix,
          // the persistence-side validator skips it.
          tasks: [{ type: 'agent' /* no providesPurposeId */ }],
        },
      },
    };

    const result = validateAgentDecisionForPersistence(
      inputWithSubmitOutputAndDeepInvariantSchema(),
      trackingDeps,
      decision,
    );
    expect(result.kind).toBe('accepted');
    expect(submitOutputCallingValidateToolArgs).not.toHaveBeenCalled();
  });

  it('does NOT call validateToolArgs for invoke_steps entries pointing at submit_output', () => {
    submitOutputCallingValidateToolArgs.mockClear();
    const decision: AgentTurnDecision = {
      action: 'invoke_steps',
      calls: [{ toolId: 'submit_output', args: { result: { tasks: [{ type: 'agent' }] } } }],
    };

    const result = validateAgentDecisionForPersistence(
      inputWithSubmitOutputAndDeepInvariantSchema(),
      trackingDeps,
      decision,
    );
    expect(result.kind).toBe('accepted');
    expect(submitOutputCallingValidateToolArgs).not.toHaveBeenCalled();
  });
});
