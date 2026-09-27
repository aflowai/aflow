import { describe, it, expect } from 'vitest';
import type { AgentToolSpec, AgentTurnDecision } from '@aflow/schemas';
import { BLOCKED_REASON_AUTO_CONVERT_PREFIX } from '@aflow/schemas';
import type { ToolCall } from '@aflow/ai-client';

type PauseForInputDecision = Extract<AgentTurnDecision, { action: 'pause_for_input' }>;
type InvokeStepDecision = Extract<AgentTurnDecision, { action: 'invoke_step' }>;
type InvokeStepsDecision = Extract<AgentTurnDecision, { action: 'invoke_steps' }>;
type CompleteDecision = Extract<AgentTurnDecision, { action: 'complete' }>;
import type { ChatMessage } from '@aflow/ai-client';
import {
  toolIdToFnName,
  buildFunctionDeclarations,
  mapToolCallsToDecision,
  buildNativeFCSystemPrompt,
  sanitizeSchemaForGeminiFunctionCalling,
  buildRawContentFromResponse,
  convertOrphanToolMessages,
  remapFunctionNamesForNativeFC,
} from './agentNativeFunctionCalling.js';

// ============================================================================
// toolIdToFnName
// ============================================================================

describe('toolIdToFnName', () => {
  it('replaces hyphens with underscores', () => {
    expect(toolIdToFnName('search-1')).toBe('search_1');
    expect(toolIdToFnName('flow-1')).toBe('flow_1');
    expect(toolIdToFnName('ai-1')).toBe('ai_1');
    expect(toolIdToFnName('flowcontrol-1')).toBe('flowcontrol_1');
  });

  it('replaces dots with underscores', () => {
    expect(toolIdToFnName('my.step.name')).toBe('my_step_name');
  });

  it('prefixes with underscore when starting with a digit', () => {
    expect(toolIdToFnName('123invalid')).toBe('_123invalid');
  });

  it('truncates long names to 58 chars', () => {
    const longName = 'a'.repeat(100);
    const result = toolIdToFnName(longName);
    expect(result.length).toBe(58);
  });

  it('keeps valid names unchanged', () => {
    expect(toolIdToFnName('valid_name')).toBe('valid_name');
    expect(toolIdToFnName('_leading')).toBe('_leading');
  });

  it('handles empty string', () => {
    expect(toolIdToFnName('')).toBe('');
  });

  it('handles special characters', () => {
    expect(toolIdToFnName('step@#$%')).toBe('step____');
  });
});

// ============================================================================
// buildFunctionDeclarations
// ============================================================================

describe('buildFunctionDeclarations', () => {
  const makeTool = (overrides: Partial<AgentToolSpec> = {}): AgentToolSpec => ({
    toolId: 'search-1',
    operationId: 'api.http.call',
    stepType: 'api',
    name: 'Search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    ...overrides,
  });

  it('creates tool functions without pause_for_input for assistant role', () => {
    const result = buildFunctionDeclarations([makeTool()], {
      allowComplete: false,
      allowParallel: false,
    });
    // Assistant role: no pause_for_input (text-only response auto-maps to pause), but present_options is included
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.function.name)).toEqual(['search_1', 'present_options']);
  });

  it('creates tool + complete when allowComplete=true (assistant role)', () => {
    const result = buildFunctionDeclarations([makeTool()], {
      allowComplete: true,
      allowParallel: false,
    });
    // Assistant role: no pause_for_input, but complete + present_options are included
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.function.name)).toEqual([
      'search_1',
      'present_options',
      'complete',
    ]);
  });

  it('creates N+1 functions for multiple tools (assistant role, no pause_for_input)', () => {
    const tools = [
      makeTool({ toolId: 'search-1' }),
      makeTool({
        toolId: 'flow-1',
        name: 'Flow',
        operationId: 'agent.control.run_step',
      }),
    ];
    const result = buildFunctionDeclarations(tools, {
      allowComplete: true,
      allowParallel: true,
    });
    // 2 tools + complete + present_options (no pause_for_input for assistant role)
    expect(result.tools).toHaveLength(4);
    expect(result.tools.map((t) => t.function.name)).toContain('search_1');
    expect(result.tools.map((t) => t.function.name)).toContain('flow_1');
    expect(result.tools.map((t) => t.function.name)).not.toContain('pause_for_input');
    expect(result.tools.map((t) => t.function.name)).toContain('complete');
  });

  it('includes pause_for_input for subagent role', () => {
    const result = buildFunctionDeclarations([makeTool()], {
      allowComplete: true,
      allowParallel: false,
      agentRole: 'subagent',
    });
    expect(result.tools.map((t) => t.function.name)).toContain('pause_for_input');
    expect(result.tools.map((t) => t.function.name)).toContain('complete');
  });

  it('removes pause_for_input for non-interactive subagents', () => {
    const result = buildFunctionDeclarations([makeTool()], {
      allowComplete: true,
      allowParallel: false,
      agentRole: 'subagent',
      requestInputPolicy: 'never',
    });
    expect(result.tools.map((t) => t.function.name)).not.toContain('pause_for_input');
    expect(result.tools.map((t) => t.function.name)).toContain('complete');
  });

  it('strips additionalProperties from tool schemas for google provider', () => {
    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        additionalProperties: true,
      },
    });
    const result = buildFunctionDeclarations(
      [tool],
      { allowComplete: false, allowParallel: false },
      'google',
    );
    const toolDef = result.tools.find((t) => t.function.name === 'search_1');
    expect(toolDef?.function.parameters).not.toHaveProperty('additionalProperties');
  });

  it('preserves additionalProperties for non-google providers', () => {
    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        additionalProperties: true,
      },
    });
    const result = buildFunctionDeclarations(
      [tool],
      { allowComplete: false, allowParallel: false },
      'anthropic',
    );
    const toolDef = result.tools.find((t) => t.function.name === 'search_1');
    expect(toolDef?.function.parameters).toHaveProperty('additionalProperties', true);
  });

  it('builds bidirectional name maps', () => {
    const result = buildFunctionDeclarations([makeTool()], {
      allowComplete: false,
      allowParallel: false,
    });
    expect(result.fnNameToToolId.get('search_1')).toBe('search-1');
    expect(result.toolIdToFnNameMap.get('search-1')).toBe('search_1');
  });

  it('handles collision between two tools that sanitize to the same name', () => {
    const tools = [
      makeTool({ toolId: 'foo-bar', name: 'Foo Bar' }),
      makeTool({ toolId: 'foo_bar', name: 'Foo_Bar' }),
    ];
    const result = buildFunctionDeclarations(tools, {
      allowComplete: false,
      allowParallel: false,
    });
    const toolNames = result.tools.map((t) => t.function.name);
    // 2 tools + present_options (assistant role)
    expect(toolNames).toHaveLength(3);
    // Tool names should be unique
    const toolOnlyNames = toolNames.filter((n) => n !== 'present_options');
    expect(new Set(toolOnlyNames).size).toBe(2);
    // First alphabetically keeps clean name, second gets suffix
    expect(toolNames).toContain('foo_bar');
    expect(toolNames).toContain('foo_bar_2');
  });

  it('appends _step suffix when tool name collides with complete', () => {
    const tool = makeTool({ toolId: 'complete', name: 'Complete Step' });
    const result = buildFunctionDeclarations([tool], {
      allowComplete: true,
      allowParallel: false,
    });
    const toolNames = result.tools.map((t) => t.function.name);
    expect(toolNames).toContain('complete_step');
    expect(toolNames).toContain('complete');
    expect(result.fnNameToToolId.get('complete_step')).toBe('complete');
  });

  it('appends _step suffix when tool name collides with pause_for_input (subagent)', () => {
    const tool = makeTool({
      toolId: 'pause_for_input',
      name: 'Pause',
    });
    const result = buildFunctionDeclarations([tool], {
      allowComplete: false,
      allowParallel: false,
      agentRole: 'subagent',
    });
    const toolNames = result.tools.map((t) => t.function.name);
    expect(toolNames).toContain('pause_for_input_step');
    expect(toolNames).toContain('pause_for_input');
  });

  it('does not collide with pause_for_input for assistant role (no meta-function)', () => {
    const tool = makeTool({
      toolId: 'pause_for_input',
      name: 'Pause',
    });
    const result = buildFunctionDeclarations([tool], {
      allowComplete: false,
      allowParallel: false,
    });
    const toolNames = result.tools.map((t) => t.function.name);
    // No collision since pause_for_input meta-function is not included
    expect(toolNames).toContain('pause_for_input');
    expect(toolNames).not.toContain('pause_for_input_step');
  });

  it('produces deterministic output regardless of input order', () => {
    const tools = [
      makeTool({ toolId: 'z-tool', name: 'Z' }),
      makeTool({ toolId: 'a-tool', name: 'A' }),
    ];
    const result1 = buildFunctionDeclarations(tools, {
      allowComplete: false,
      allowParallel: false,
    });
    const result2 = buildFunctionDeclarations([...tools].reverse(), {
      allowComplete: false,
      allowParallel: false,
    });
    const names1 = result1.tools.map((t) => t.function.name);
    const names2 = result2.tools.map((t) => t.function.name);
    expect(names1).toEqual(names2);
  });

  it('uses fallback description when tool has no description', () => {
    const tool = makeTool({ description: undefined });
    const result = buildFunctionDeclarations([tool], {
      allowComplete: false,
      allowParallel: false,
    });
    const toolDef = result.tools.find((t) => t.function.name === 'search_1');
    expect(toolDef?.function.description).toBe('Search (api.http.call)');
  });

  it('uses empty schema wrapper for tools with no inputSchema', () => {
    const tool = makeTool({ inputSchema: {} });
    const result = buildFunctionDeclarations([tool], {
      allowComplete: false,
      allowParallel: false,
    });
    const toolDef = result.tools.find((t) => t.function.name === 'search_1');
    expect(toolDef?.function.parameters).toEqual({ type: 'object', properties: {} });
  });
});

// ============================================================================
// mapToolCallsToDecision
// ============================================================================

describe('mapToolCallsToDecision', () => {
  const fnNameToToolId = new Map([
    ['search_1', 'search-1'],
    ['flow_1', 'flow-1'],
  ]);

  const makeToolCall = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: `call_${name}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  });

  it('maps text-only response (no tool calls) to pause_for_input', () => {
    const { decision } = mapToolCallsToDecision(
      { content: 'Hello user', toolCalls: undefined },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe('Hello user');
  });

  it('strips trailing JSON decision block from text-only responses', () => {
    const textWithJson =
      'Here are the results.\n\n{ "action": "pause_for_input", "message": "Here are the results." }';
    const { decision } = mapToolCallsToDecision(
      { content: textWithJson, toolCalls: undefined },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe('Here are the results.');
    expect((decision as PauseForInputDecision).message).not.toContain('"action"');
  });

  it('strips decision JSON with nested args objects', () => {
    const textWithNestedJson =
      'Checking the run.\n\n{"action":"invoke_step","stepId":"flow-1","args":{"operationId":"memory.store.get","key":"report_123"}}';
    const { decision } = mapToolCallsToDecision(
      { content: textWithNestedJson, toolCalls: undefined },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe('Checking the run.');
    expect((decision as PauseForInputDecision).message).not.toContain('"action"');
  });

  it('strips decision JSON when it is the entire content (returns empty)', () => {
    const jsonOnly = '{"action":"invoke_step","stepId":"flow-1","args":{"key":"val"}}';
    const { decision } = mapToolCallsToDecision(
      { content: jsonOnly, toolCalls: undefined },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe('');
  });

  it('does not strip JSON from text that mentions "action" in a non-decision context', () => {
    const legitimateText =
      'Here is an example API payload: { "action": "create_user", "name": "Alice" }';
    const { decision } = mapToolCallsToDecision(
      { content: legitimateText, toolCalls: undefined },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe(legitimateText);
  });

  it('maps empty text + no tool calls to fallback pause_for_input', () => {
    const { decision } = mapToolCallsToDecision(
      { content: null, toolCalls: undefined },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toContain(
      'The model did not produce a response',
    );
  });

  it('includes finishReason in empty response fallback message', () => {
    const { decision: lengthDecision } = mapToolCallsToDecision(
      { content: null, toolCalls: undefined, finishReason: 'length' },
      fnNameToToolId,
      5,
    );
    expect((lengthDecision as PauseForInputDecision).message).toContain('output tokens');

    const { decision: filterDecision } = mapToolCallsToDecision(
      { content: null, toolCalls: undefined, finishReason: 'content_filter' },
      fnNameToToolId,
      5,
    );
    expect((filterDecision as PauseForInputDecision).message).toContain('content filter');
  });

  it('maps single tool step call to invoke_step', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [makeToolCall('search_1', { query: 'test' })],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).toolId).toBe('search-1');
    expect((decision as InvokeStepDecision).args).toEqual({ query: 'test' });
  });

  it('preserves text content as message alongside tool call', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: 'Searching now...',
        toolCalls: [makeToolCall('search_1', { query: 'test' })],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).message).toBe('Searching now...');
  });

  it('maps single pause_for_input call', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [makeToolCall('pause_for_input', { message: 'What do you need?' })],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe('What do you need?');
  });

  it('coerces text-only responses to complete for non-interactive subagents', () => {
    const { decision } = mapToolCallsToDecision(
      { content: 'All files downloaded and inspected.', toolCalls: undefined },
      fnNameToToolId,
      5,
      {
        allowComplete: true,
        requestInputPolicy: 'never',
      },
    );
    expect(decision.action).toBe('complete');
    expect((decision as CompleteDecision).message).toBe('All files downloaded and inspected.');
    expect((decision as CompleteDecision).result).toBe('All files downloaded and inspected.');
  });

  const signalBlockedToolSpec: AgentToolSpec = {
    toolId: 'signal_blocked',
    operationId: 'agent.control.signal_blocked',
    stepType: 'agent',
    name: 'Signal Blocked',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
        category: { type: 'string', enum: ['missing_input', 'external_dependency', 'other'] },
      },
      required: ['reason', 'category'],
    },
  };

  it('routes text-only through the blocked-signal tool when never policy forbids completing', () => {
    const { decision } = mapToolCallsToDecision(
      { content: 'I am stuck without credentials.', toolCalls: undefined },
      fnNameToToolId,
      5,
      {
        allowComplete: false,
        requestInputPolicy: 'never',
        availableTools: [signalBlockedToolSpec],
      },
    );
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).toolId).toBe('signal_blocked');
    expect((decision as InvokeStepDecision).args).toEqual({
      reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}I am stuck without credentials.`,
      category: 'missing_input',
    });
  });

  it('coerces explicit pause_for_input meta-calls into the blocked-signal call when never policy forbids completing', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [makeToolCall('pause_for_input', { message: 'Need the target branch.' })],
      },
      fnNameToToolId,
      5,
      {
        allowComplete: false,
        requestInputPolicy: 'never',
        availableTools: [signalBlockedToolSpec],
      },
    );
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).toolId).toBe('signal_blocked');
    expect((decision as InvokeStepDecision).args).toEqual({
      reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}Need the target branch.`,
      category: 'missing_input',
    });
  });

  it('blocked_only text-only keeps pause with blocking metadata even when the blocked-signal tool is present', () => {
    const { decision } = mapToolCallsToDecision(
      { content: 'I need the API endpoint URL to proceed.', toolCalls: undefined },
      fnNameToToolId,
      5,
      {
        allowComplete: true,
        requestInputPolicy: 'blocked_only',
        availableTools: [signalBlockedToolSpec],
      },
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).blockingReason).toBeTruthy();
    expect((decision as PauseForInputDecision).blockingCategory).toBe('missing_input');
  });

  it('coerces present_options meta-calls into the blocked-signal call when never policy forbids completing', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [
          makeToolCall('present_options', {
            message: 'Which dataset should I use?',
            options: [{ value: 'train' }, { value: 'test' }],
          }),
        ],
      },
      fnNameToToolId,
      5,
      {
        allowComplete: false,
        requestInputPolicy: 'never',
        availableTools: [signalBlockedToolSpec],
      },
    );
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).toolId).toBe('signal_blocked');
    expect((decision as InvokeStepDecision).args).toEqual({
      reason: `${BLOCKED_REASON_AUTO_CONVERT_PREFIX}Which dataset should I use?`,
      category: 'missing_input',
    });
  });

  it('keeps present_options pauses intact under the allowed policy', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [
          makeToolCall('present_options', {
            message: 'Pick a color',
            options: [{ value: 'red' }, { value: 'blue' }],
          }),
        ],
      },
      fnNameToToolId,
      5,
      { allowComplete: true, requestInputPolicy: 'allowed' },
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).responseOptions?.options).toEqual([
      { value: 'red' },
      { value: 'blue' },
    ]);
  });

  it('coerces pause_for_input meta-calls to complete for non-interactive subagents', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [makeToolCall('pause_for_input', { message: 'Here is the final summary.' })],
      },
      fnNameToToolId,
      5,
      {
        allowComplete: true,
        requestInputPolicy: 'never',
      },
    );
    expect(decision.action).toBe('complete');
    expect((decision as CompleteDecision).message).toBe('Here is the final summary.');
    expect((decision as CompleteDecision).result).toBe('Here is the final summary.');
  });

  it('maps single pause_for_input call with reasoning', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [
          makeToolCall('pause_for_input', {
            message: 'Question',
            reasoning: 'Need more info',
          }),
        ],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).reasoning).toBe('Need more info');
  });

  it('maps single complete call', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [
          makeToolCall('complete', {
            result: 'done',
            message: 'All done',
            reasoning: 'Task finished',
          }),
        ],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('complete');
    expect((decision as CompleteDecision).result).toBe('done');
    expect((decision as CompleteDecision).message).toBe('All done');
    expect((decision as CompleteDecision).reasoning).toBe('Task finished');
  });

  it('maps multiple tool step calls to invoke_steps', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: 'Running parallel searches',
        toolCalls: [
          makeToolCall('search_1', { query: 'a' }),
          makeToolCall('flow_1', { operationId: 'memory.store.get', key: 'x' }),
        ],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('invoke_steps');
    const invSteps = decision as InvokeStepsDecision;
    expect(invSteps.calls).toHaveLength(2);
    expect(invSteps.calls[0]!.toolId).toBe('search-1');
    expect(invSteps.calls[1]!.toolId).toBe('flow-1');
    expect(invSteps.message).toBe('Running parallel searches');
  });

  it('truncates with warning when tool call count exceeds maxToolCallsPerTurn', () => {
    const { decision, warnings } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [
          makeToolCall('search_1', { query: 'a' }),
          makeToolCall('flow_1', { operationId: 'b' }),
        ],
      },
      fnNameToToolId,
      1, // max 1
    );
    expect(decision.action).toBe('invoke_steps');
    const invSteps = decision as InvokeStepsDecision;
    expect(invSteps.calls).toHaveLength(1);
    expect(invSteps.calls[0]!.toolId).toBe('search-1');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('tool calls but max is');
  });

  it('throws for unknown function name', () => {
    expect(() =>
      mapToolCallsToDecision(
        {
          content: null,
          toolCalls: [makeToolCall('nonexistent', {})],
        },
        fnNameToToolId,
        5,
      ),
    ).toThrow('Unknown function name');
  });

  it('maps dot-style function names from Gemini to sanitized declaration keys', () => {
    const apiGetTool: AgentToolSpec = {
      toolId: 'api.definition.get',
      operationId: 'api.definition.get',
      stepType: 'api',
      name: 'Get definition',
      description: 'get',
      inputSchema: { type: 'object', properties: {} },
    };
    const { fnNameToToolId } = buildFunctionDeclarations(
      [apiGetTool],
      { allowComplete: false, allowParallel: false },
      'google',
    );
    const { decision } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'api.definition.get', arguments: '{}' },
          },
        ],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).toolId).toBe('api.definition.get');
  });

  it('prefers tool calls over meta-function in mixed calls (tool + meta)', () => {
    const { decision, warnings } = mapToolCallsToDecision(
      {
        content: null,
        toolCalls: [
          makeToolCall('search_1', { query: 'test' }),
          makeToolCall('pause_for_input', { message: 'Stopping' }),
        ],
      },
      fnNameToToolId,
      5,
    );
    // Should execute the tool call, not pause
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).toolId).toBe('search-1');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('ignoring meta-function');
  });

  it('returns warning for unparseable tool call arguments and defaults to {}', () => {
    const tc: ToolCall = {
      id: 'call_bad',
      type: 'function',
      function: { name: 'search_1', arguments: 'not-json{{{' },
    };
    const { decision, warnings } = mapToolCallsToDecision(
      { content: null, toolCalls: [tc] },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('invoke_step');
    expect((decision as InvokeStepDecision).args).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Malformed arguments');
    expect(warnings[0]).toContain('search_1');
  });

  it('handles empty toolCalls array as text-only', () => {
    const { decision } = mapToolCallsToDecision(
      { content: 'Just text', toolCalls: [] as ToolCall[] },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe('Just text');
  });

  it('merges streamed narration with pause_for_input message arg', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: 'Here is a long explanation of the options.',
        toolCalls: [
          makeToolCall('pause_for_input', {
            message: 'Which would you like?',
            responseOptions: { type: 'single', options: [{ value: 'a' }, { value: 'b' }] },
          }),
        ],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('pause_for_input');
    expect((decision as PauseForInputDecision).message).toBe(
      'Here is a long explanation of the options.\n\nWhich would you like?',
    );
  });

  it('does not duplicate when narration already ends with the message arg', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: 'Considering both, I recommend X. Which would you like?',
        toolCalls: [makeToolCall('pause_for_input', { message: 'Which would you like?' })],
      },
      fnNameToToolId,
      5,
    );
    expect((decision as PauseForInputDecision).message).toBe(
      'Considering both, I recommend X. Which would you like?',
    );
  });

  it('uses message arg alone when narration matches it exactly', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: 'Pick one.',
        toolCalls: [makeToolCall('pause_for_input', { message: 'Pick one.' })],
      },
      fnNameToToolId,
      5,
    );
    expect((decision as PauseForInputDecision).message).toBe('Pick one.');
  });

  it('merges narration with complete message arg', () => {
    const { decision } = mapToolCallsToDecision(
      {
        content: 'Here is the full report on the analysis.',
        toolCalls: [makeToolCall('complete', { result: 'done', message: 'Task complete.' })],
      },
      fnNameToToolId,
      5,
    );
    expect(decision.action).toBe('complete');
    expect((decision as CompleteDecision).message).toBe(
      'Here is the full report on the analysis.\n\nTask complete.',
    );
  });
});

// ============================================================================
// buildNativeFCSystemPrompt
// ============================================================================

describe('buildNativeFCSystemPrompt', () => {
  const defaultParams = {
    turnNumber: 1,
    totalToolCallsSoFar: 3,
    policy: {
      maxToolCallsPerTurn: 5,
      allowComplete: true,
      allowParallel: true,
    },
    agentRole: 'assistant' as const,
    completionPrompt: undefined,
  };

  it('should NOT contain "## Available Tools"', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).not.toContain('## Available Tools');
  });

  it('should NOT contain "## Decision Format"', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).not.toContain('## Decision Format');
  });

  it('should contain "## Platform Policies"', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).toContain('## Platform Policies');
  });

  it('should contain "## Status"', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).toContain('## Status');
    expect(prompt).toContain('Agent role: assistant');
    expect(prompt).toContain('Max tool calls per turn: 5');
  });

  it('should contain behavioral guidance', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).toContain('## Behavior Guidelines');
    expect(prompt).toContain('call the corresponding function');
    // Assistant role: no mention of pause_for_input, text-only = auto-pause
    expect(prompt).toContain('just output text with no function calls');
  });

  it('includes parallel guidance when allowParallel=true', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).toContain('multiple tool functions in one turn');
  });

  it('excludes parallel guidance when allowParallel=false', () => {
    const prompt = buildNativeFCSystemPrompt({
      ...defaultParams,
      policy: { ...defaultParams.policy, allowParallel: false },
    });
    expect(prompt).not.toContain('multiple tool functions in one turn');
  });

  it('includes complete guidance when allowComplete=true', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).toContain('call complete with a summary');
  });

  it('excludes complete guidance when allowComplete=false', () => {
    const prompt = buildNativeFCSystemPrompt({
      ...defaultParams,
      policy: { ...defaultParams.policy, allowComplete: false },
    });
    expect(prompt).not.toContain('call complete with a summary');
  });

  it('uses custom system prompt when provided', () => {
    const prompt = buildNativeFCSystemPrompt({
      ...defaultParams,
      systemPrompt: 'You are a helpful cooking assistant.',
    });
    expect(prompt).toContain('You are a helpful cooking assistant.');
  });

  it('uses default system prompt when none provided', () => {
    const prompt = buildNativeFCSystemPrompt(defaultParams);
    expect(prompt).toContain('You are a capable agent');
  });

  it('includes flow name and description in status', () => {
    const prompt = buildNativeFCSystemPrompt({
      ...defaultParams,
      flowName: 'Research Agent',
      flowDescription: 'Searches and summarizes',
    });
    expect(prompt).toContain('Flow: Research Agent — Searches and summarizes');
  });
});

// ============================================================================
// sanitizeSchemaForGeminiFunctionCalling
// ============================================================================

describe('sanitizeSchemaForGeminiFunctionCalling', () => {
  it('strips additionalProperties (true)', () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: true,
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    expect(result).not.toHaveProperty('additionalProperties');
    expect(result).toHaveProperty('type', 'object');
    expect(result).toHaveProperty('properties');
  });

  it('strips additionalProperties (false)', () => {
    const schema = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    expect(result).not.toHaveProperty('additionalProperties');
  });

  it('strips additionalProperties recursively in nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: { x: { type: 'number' } },
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    expect(result).not.toHaveProperty('additionalProperties');
    const props = (result as Record<string, unknown>)['properties'] as
      Record<string, unknown> | undefined;
    const inner = props?.['inner'] as Record<string, unknown> | undefined;
    expect(inner).not.toHaveProperty('additionalProperties');
  });

  it('strips $ref, $defs, $schema, $id, definitions, $comment', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'test',
      $defs: { Foo: { type: 'string' } },
      $comment: 'a comment',
      definitions: { Bar: { type: 'number' } },
      type: 'object',
      properties: {
        foo: { $ref: '#/$defs/Foo' },
      },
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('$id');
    expect(result).not.toHaveProperty('$defs');
    expect(result).not.toHaveProperty('$comment');
    expect(result).not.toHaveProperty('definitions');
    const props = (result as Record<string, unknown>)['properties'] as
      Record<string, unknown> | undefined;
    const foo = props?.['foo'] as Record<string, unknown> | undefined;
    expect(foo?.$ref).toBeUndefined();
  });

  it('converts type array ["string", "null"] to anyOf', () => {
    const schema = {
      type: ['string', 'null'] as unknown,
      description: 'Optional string',
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema as Record<string, unknown>);
    expect(result).not.toHaveProperty('type');
    expect(result).toHaveProperty('anyOf');
    expect((result as Record<string, unknown>)['anyOf']).toEqual([
      { type: 'string' },
      { type: 'null' },
    ]);
    expect(result).toHaveProperty('description', 'Optional string');
  });

  it('unwraps single-element type array', () => {
    const schema = { type: ['string'] as unknown };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema as Record<string, unknown>);
    expect(result).toHaveProperty('type', 'string');
  });

  it('handles arrays in schema values', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['tags'],
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    const props = (result as Record<string, unknown>)['properties'] as
      Record<string, unknown> | undefined;
    expect((props?.['tags'] as Record<string, unknown>)?.type).toBe('array');
    expect((result as Record<string, unknown>)['required']).toEqual(['tags']);
  });

  it('preserves a clean schema unchanged', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'User name' },
      },
      required: ['name'],
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    expect(result).toEqual(schema);
  });

  it('normalizes a property-level oneOf to anyOf (Gemini FC has no oneOf)', () => {
    const schema = {
      type: 'object',
      properties: {
        instructions: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
          description: 'string or array',
        },
      },
      required: ['instructions'],
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    const props = (result as Record<string, unknown>)['properties'] as Record<string, unknown>;
    const instr = props['instructions'] as Record<string, unknown>;
    expect(instr).not.toHaveProperty('oneOf');
    expect(instr['anyOf']).toEqual([
      { type: 'string' },
      { type: 'array', items: { type: 'object' } },
    ]);
    expect(instr).toHaveProperty('description', 'string or array');
  });

  it('merges oneOf into an existing anyOf rather than dropping either', () => {
    const schema = {
      anyOf: [{ type: 'string' }],
      oneOf: [{ type: 'number' }],
    };
    const result = sanitizeSchemaForGeminiFunctionCalling(schema);
    expect(result).not.toHaveProperty('oneOf');
    expect(result['anyOf']).toEqual([{ type: 'string' }, { type: 'number' }]);
  });
});

// ============================================================================
// convertOrphanToolMessages (shared — all providers)
// ============================================================================

describe('convertOrphanToolMessages', () => {
  it('converts orphan tool messages to user role (never system)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an agent.' },
      {
        role: 'tool',
        toolCallId: 'ctx:get_schema:0',
        name: 'catalog.tool.list',
        content: '{"operations":[]}',
      },
      { role: 'user', content: 'Search for cats' },
    ];
    const result = convertOrphanToolMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[1]!.role).toBe('user');
    expect((result[1] as { role: 'user'; content: string }).content).toContain(
      '[Context result from catalog.tool.list]',
    );
    expect((result[1] as { role: 'user'; content: string }).content).toContain('{"operations":[]}');
  });

  it('keeps matched tool messages as tool role', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Search for cats' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search-1', arguments: '{"query":"cats"}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'search-1',
        content: 'Found 5 results',
      },
    ];
    const result = convertOrphanToolMessages(messages);
    expect(result[3]!.role).toBe('tool');
  });

  it('preserves system and user messages unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Instructions' },
      { role: 'user', content: 'Hello' },
    ];
    const result = convertOrphanToolMessages(messages);
    expect(result).toEqual(messages);
  });

  it('handles multiple orphan tool messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'orphan_1',
        name: 'context_step_a',
        content: 'data_a',
      },
      {
        role: 'tool',
        toolCallId: 'orphan_2',
        name: 'context_step_b',
        content: 'data_b',
      },
      { role: 'user', content: 'Do something' },
    ];
    const result = convertOrphanToolMessages(messages);
    expect(result[0]!.role).toBe('user');
    expect(result[1]!.role).toBe('user');
    expect(result[2]!.role).toBe('user');
  });

  it('uses toolCallId as fallback name for orphan tool without name', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'orphan_id_123',
        content: 'some data',
      },
    ];
    const result = convertOrphanToolMessages(messages);
    expect(result[0]!.role).toBe('user');
    expect((result[0] as { content: string }).content).toContain('orphan_id_123');
  });

  it('handles mixed orphan and matched tool messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'orphan_ctx',
        name: 'get_schema',
        content: '{"ops":[]}',
      },
      { role: 'user', content: 'Search' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search-1', arguments: '{"q":"x"}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'search-1',
        content: 'results',
      },
    ];
    const result = convertOrphanToolMessages(messages);
    expect(result[0]!.role).toBe('user');
    expect(result[3]!.role).toBe('tool');
  });

  it('reconciles tool result with mismatched ID but matching name', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'List eval suites' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'compact_id_0',
            type: 'function',
            function: { name: 'flow-1', arguments: '{"operationId":"eval.list"}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name: 'flow-1',
        content: '{"suites":[]}',
      },
    ];
    const result = convertOrphanToolMessages(messages);
    expect(result[2]!.role).toBe('tool');
    expect((result[2] as { toolCallId: string }).toolCallId).toBe('compact_id_0');
  });

  it('converts tool result orphaned by windowing even if same tool name exists later', () => {
    // Simulates windowing: the assistant message with tool_use for turn 1 was
    // trimmed, leaving a dangling tool_result at the start. A later assistant
    // message calls the same tool. The orphan must NOT be remapped to the later
    // tool_use — it must be converted to a user message. Otherwise Anthropic
    // rejects the request because tool_result precedes the tool_use.
    const messages: ChatMessage[] = [
      // Turn 1 assistant was windowed away — only its tool result survives
      {
        role: 'tool',
        toolCallId: 'uuid-step-1',
        name: 'search',
        content: 'old results',
      },
      { role: 'user', content: 'Now search again' },
      // Turn 2 assistant + tool result
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'compact_turn2_0',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"new"}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'uuid-step-2',
        name: 'search',
        content: 'new results',
      },
    ];
    const result = convertOrphanToolMessages(messages);
    // Orphaned tool result at index 0 must become a user message
    expect(result[0]!.role).toBe('user');
    expect((result[0] as { content: string }).content).toContain('[Context result from search]');
    expect((result[0] as { content: string }).content).toContain('old results');
    // Turn 2 tool result should be name-matched to the turn 2 assistant call
    expect(result[3]!.role).toBe('tool');
    expect((result[3] as { toolCallId: string }).toolCallId).toBe('compact_turn2_0');
  });

  it('correctly maps multiple calls to the same tool across turns (FIFO)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Check suites then runs' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'turn1_compact_0',
            type: 'function',
            function: { name: 'flow-1', arguments: '{"op":"list_suites"}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'uuid-tool-step-1',
        name: 'flow-1',
        content: '{"suites":["a"]}',
      },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'turn2_compact_0',
            type: 'function',
            function: { name: 'flow-1', arguments: '{"op":"list_runs"}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'uuid-tool-step-2',
        name: 'flow-1',
        content: '{"runs":["r1"]}',
      },
    ];
    const result = convertOrphanToolMessages(messages);
    // Turn 1 tool result → turn 1 assistant call ID
    expect(result[2]!.role).toBe('tool');
    expect((result[2] as { toolCallId: string }).toolCallId).toBe('turn1_compact_0');
    // Turn 2 tool result → turn 2 assistant call ID
    expect(result[4]!.role).toBe('tool');
    expect((result[4] as { toolCallId: string }).toolCallId).toBe('turn2_compact_0');
  });
});

// ============================================================================
// remapFunctionNamesForNativeFC
// ============================================================================

describe('remapFunctionNamesForNativeFC', () => {
  const toolIdToFnNameMap = new Map([
    ['search-1', 'search_1'],
    ['flow-1', 'flow_1'],
  ]);

  it('remaps assistant toolCall names to sanitized function names', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search-1', arguments: '{"q":"test"}' },
          },
        ],
      },
    ];
    const result = remapFunctionNamesForNativeFC(messages, toolIdToFnNameMap);
    const assistant = result[0] as {
      role: 'assistant';
      toolCalls?: Array<{ function: { name: string } }>;
    };
    expect(assistant.toolCalls?.[0]?.function.name).toBe('search_1');
  });

  it('remaps tool message names to sanitized function names', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search-1', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'search-1',
        content: 'result',
      },
    ];
    const result = remapFunctionNamesForNativeFC(messages, toolIdToFnNameMap);
    const tool = result[1] as { role: 'tool'; name?: string };
    expect(tool.name).toBe('search_1');
  });

  it('keeps unknown function names unchanged', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'unknown_step', arguments: '{}' },
          },
        ],
      },
    ];
    const result = remapFunctionNamesForNativeFC(messages, toolIdToFnNameMap);
    const assistant = result[0] as {
      role: 'assistant';
      toolCalls?: Array<{ function: { name: string } }>;
    };
    expect(assistant.toolCalls?.[0]?.function.name).toBe('unknown_step');
  });

  it('preserves system and user messages unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Instructions' },
      { role: 'user', content: 'Hello' },
    ];
    const result = remapFunctionNamesForNativeFC(messages, toolIdToFnNameMap);
    expect(result).toEqual(messages);
  });
});

// ============================================================================
// buildRawContentFromResponse
// ============================================================================

describe('buildRawContentFromResponse', () => {
  it('returns text content when present', () => {
    const result = buildRawContentFromResponse({
      content: 'Hello',
      toolCalls: undefined,
    });
    expect(result).toBe('Hello');
  });

  it('returns tool call descriptions when no text content', () => {
    const result = buildRawContentFromResponse({
      content: null,
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"test"}' },
        },
      ],
    });
    expect(result).toBe('search({"q":"test"})');
  });

  it('returns [no content] when neither text nor tool calls', () => {
    const result = buildRawContentFromResponse({
      content: null,
      toolCalls: undefined,
    });
    expect(result).toBe('[no content]');
  });

  it('joins multiple tool calls with semicolons', () => {
    const result = buildRawContentFromResponse({
      content: null,
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    });
    expect(result).toBe('a({}); b({})');
  });
});
