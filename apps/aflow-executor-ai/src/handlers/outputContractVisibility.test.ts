import { describe, it, expect } from 'vitest';
import { buildGenerateJsonSystemPrompt } from './ai/handlers/agentTurnPrompts.js';
import { buildNativeFCSystemPrompt } from './ai/handlers/agentNativeFunctionCalling.js';
import type { AgentTurnInput } from './ai/schema.js';

/**
 * The cybernetic Runner is `completionPolicy: 'open_ended'` and submits through
 * a graph tool, so it never sees the `complete` action. While the output schema
 * was rendered inside that action's block, the one agent that builds a
 * contract-bound result was the one agent that could not read the contract.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['cases'],
  properties: { cases: { type: 'array' }, rationale: { type: 'string' } },
};

function turn(over: Partial<AgentTurnInput>): AgentTurnInput {
  return {
    messages: [],
    availableTools: [],
    policy: { allowComplete: true },
    agentRole: 'subagent',
    finalOutputSchema: OUTPUT_SCHEMA,
    ...over,
  } as unknown as AgentTurnInput;
}

describe('output contract visibility', () => {
  it('reaches the Runner, whose completionPolicy suppresses the complete action', () => {
    const prompt = buildGenerateJsonSystemPrompt(
      turn({ completionPolicy: 'open_ended', requestInputPolicy: 'never' }),
    );
    expect(prompt).not.toContain('"action": "complete"');
    expect(prompt).toContain('Output Contract');
    expect(prompt).toContain('"cases"');
  });

  it.each(['allowed', 'must_complete_or_block', 'open_ended'] as const)(
    'renders the contract under completionPolicy=%s',
    (completionPolicy) => {
      const prompt = buildGenerateJsonSystemPrompt(turn({ completionPolicy }));
      expect(prompt).toContain('"rationale"');
    },
  );

  it('omits the section entirely when the task declares no schema', () => {
    const noSchema = turn({ completionPolicy: 'open_ended' });
    delete (noSchema as { finalOutputSchema?: unknown }).finalOutputSchema;
    expect(buildGenerateJsonSystemPrompt(noSchema)).not.toContain('Output Contract');
  });

  // The Runner uses tools, so it takes the native function-calling path — a
  // different prompt builder. Pinning only the generateJson one let the
  // contract go missing on the path that actually runs.
  it('reaches the Runner on the native function-calling path it actually takes', () => {
    const prompt = buildNativeFCSystemPrompt({
      turnNumber: 1,
      totalToolCallsSoFar: 0,
      policy: {
        maxToolCallsPerTurn: 10,
        maxParallel: 3,
        allowComplete: false,
        allowParallel: false,
      },
      agentRole: 'subagent',
      completionPrompt: undefined,
      finalOutputSchema: OUTPUT_SCHEMA,
    });
    expect(prompt).toContain('Output Contract');
    expect(prompt).toContain('"cases"');
  });

  it('omits the section on the native path when no schema is declared', () => {
    const prompt = buildNativeFCSystemPrompt({
      turnNumber: 1,
      totalToolCallsSoFar: 0,
      policy: {
        maxToolCallsPerTurn: 10,
        maxParallel: 3,
        allowComplete: false,
        allowParallel: false,
      },
      agentRole: 'subagent',
      completionPrompt: undefined,
    });
    expect(prompt).not.toContain('Output Contract');
  });
});
