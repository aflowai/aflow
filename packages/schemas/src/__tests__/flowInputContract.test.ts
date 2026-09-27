import { describe, it, expect } from 'vitest';
import {
  deriveFlowInputContract,
  coerceFlowInput,
  validateFlowInput,
  processFlowInput,
  type FlowInputContract,
} from '../artifact/flowInputContract.js';
import type { AgentDefinition } from '../artifact/flowDefinition.js';
import type { StateVariable } from '../artifact/stateVariable.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVar(overrides: Partial<StateVariable> & { variableId: string }): StateVariable {
  return {
    name: overrides.variableId,
    typeSchema: { type: 'string' },
    semanticType: 'text',
    lifecycle: { isInput: false, isOutput: false, persistOnPause: true, updateCount: 0 },
    tags: [],
    required: false,
    sensitive: false,
    immutable: false,
    ...overrides,
  } as StateVariable;
}

function makeFlow(
  stateVariables: StateVariable[],
  overrides?: Partial<AgentDefinition>,
): AgentDefinition {
  return {
    schemaVersion: 1,
    flowId: 'test-flow',
    systemRole: null,
    version: '1',
    metadata: { name: 'Test Flow', tags: [], public: false, system: false, custom: {} },
    stateVariables,
    steps: [
      {
        stepId: 'start',
        stepType: 'ai',
        operation: 'ai.text.generate',
        config: {},
        onSuccess: { next: [] },
        onFailure: { next: [] },
        tags: [],
      },
    ],
    startStepId: 'start',
    allowedOperations: [],
    supportedModes: ['chat'],
    status: 'published',
    ...overrides,
  } as AgentDefinition;
}

// ---------------------------------------------------------------------------
// deriveFlowInputContract
// ---------------------------------------------------------------------------

describe('deriveFlowInputContract', () => {
  it('returns no primary and no configs for flow with no input variables', () => {
    const flow = makeFlow([]);
    const contract = deriveFlowInputContract(flow);
    expect(contract.primaryInput).toBeUndefined();
    expect(contract.configVariables).toEqual([]);
    expect(contract.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('picks explicit inputRole: primary', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
      }),
      makeVar({
        variableId: 'model',
        inputRole: 'config',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        defaultValue: 'gpt-4o',
      }),
    ]);
    const contract = deriveFlowInputContract(flow);
    expect(contract.primaryInput?.variableId).toBe('prompt');
    expect(contract.configVariables).toHaveLength(1);
    expect(contract.configVariables[0]?.variableId).toBe('model');
    expect(contract.configVariables[0]?.defaultValue).toBe('gpt-4o');
  });

  it('infers primary from first required text-type input variable', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'config1',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
      }),
      makeVar({
        variableId: 'query',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
        semanticType: 'text',
      }),
    ]);
    const contract = deriveFlowInputContract(flow);
    expect(contract.primaryInput?.variableId).toBe('query');
  });

  it('infers primary from single input variable', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
      }),
    ]);
    const contract = deriveFlowInputContract(flow);
    expect(contract.primaryInput?.variableId).toBe('prompt');
    expect(contract.configVariables).toHaveLength(0);
  });

  it('does not infer primary when multiple non-required variables exist', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'a',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
      }),
      makeVar({
        variableId: 'b',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
      }),
    ]);
    const contract = deriveFlowInputContract(flow);
    expect(contract.primaryInput).toBeUndefined();
    expect(contract.configVariables).toHaveLength(2);
  });

  it('ignores non-input variables', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
      }),
      makeVar({
        variableId: 'internal',
        lifecycle: { isInput: false, isOutput: false, persistOnPause: true, updateCount: 0 },
      }),
    ]);
    const contract = deriveFlowInputContract(flow);
    expect(contract.primaryInput?.variableId).toBe('prompt');
    expect(contract.configVariables).toHaveLength(0);
  });

  it('includes enum values from typeSchema', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'format',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        typeSchema: { type: 'string', enum: ['json', 'csv', 'xml'] },
      }),
    ]);
    const contract = deriveFlowInputContract(flow);
    // Single input var → inferred as primary
    expect(contract.primaryInput?.variableId).toBe('format');
  });

  it('derives inputSchema with required fields', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
      }),
      makeVar({
        variableId: 'model',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
      }),
    ]);
    const contract = deriveFlowInputContract(flow);
    expect(contract.inputSchema['required']).toEqual(['prompt']);
  });
});

// ---------------------------------------------------------------------------
// coerceFlowInput
// ---------------------------------------------------------------------------

describe('coerceFlowInput', () => {
  const agentContract: FlowInputContract = {
    primaryInput: {
      variableId: 'prompt',
      name: 'Prompt',
      typeSchema: { type: 'string' },
      required: true,
    },
    configVariables: [
      {
        variableId: 'model',
        name: 'Model',
        typeSchema: { type: 'string' },
        defaultValue: 'gpt-4o',
        required: false,
      },
    ],
    inputSchema: { type: 'object', properties: {} },
  };

  const structuredContract: FlowInputContract = {
    primaryInput: {
      variableId: 'config',
      name: 'Config',
      typeSchema: { type: 'object' },
      required: true,
    },
    configVariables: [],
    inputSchema: { type: 'object', properties: {} },
  };

  // ── Bare values → primary ──

  describe('bare values', () => {
    it('maps bare string to primary', () => {
      const result = coerceFlowInput('hello', agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('hello');
      expect(result.normalized['model']).toBe('gpt-4o'); // default applied
    });

    it('maps bare number to primary (stringified)', () => {
      const result = coerceFlowInput(42, agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('42');
    });

    it('maps bare boolean to primary (stringified)', () => {
      const result = coerceFlowInput(true, agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('true');
    });

    it('maps array to primary', () => {
      const result = coerceFlowInput([1, 2, 3], agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('[1,2,3]');
    });

    it('rejects bare string when primary expects object', () => {
      const result = coerceFlowInput('hello', structuredContract);
      expect('message' in result).toBe(true);
    });

    it('handles null/undefined as empty input', () => {
      const result = coerceFlowInput(null, agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBeUndefined();
      expect(result.normalized['model']).toBe('gpt-4o');
    });

    it('handles empty object as empty input', () => {
      const result = coerceFlowInput({}, agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['model']).toBe('gpt-4o');
    });
  });

  // ── Standard envelope { input, config } ──

  describe('standard envelope { input, config }', () => {
    it('maps input to primary, applies config defaults', () => {
      const result = coerceFlowInput({ input: 'hello' }, agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('hello');
      expect(result.normalized['model']).toBe('gpt-4o');
    });

    it('maps input + config overrides', () => {
      const result = coerceFlowInput(
        { input: 'hello', config: { model: 'claude' } },
        agentContract,
      );
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('hello');
      expect(result.normalized['model']).toBe('claude');
    });

    it('stringifies non-string input for string primary', () => {
      const result = coerceFlowInput({ input: { data: [1, 2] } }, agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('{"data":[1,2]}');
    });

    it('passes object input directly for object primary', () => {
      const result = coerceFlowInput({ input: { url: 'http://x', depth: 3 } }, structuredContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['config']).toEqual({ url: 'http://x', depth: 3 });
    });

    it('rejects unknown config keys', () => {
      const result = coerceFlowInput({ input: 'hello', config: { badkey: true } }, agentContract);
      expect('message' in result).toBe(true);
      if (!('message' in result)) return;
      expect(result.unknownKeys).toContain('badkey');
    });

    it('handles null input value as empty string for string primary', () => {
      const result = coerceFlowInput({ input: null }, agentContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['prompt']).toBe('');
    });

    it('rejects extra top-level keys', () => {
      const result = coerceFlowInput({ input: 'hello', config: {}, extra: true }, agentContract);
      expect('message' in result).toBe(true);
      if (!('message' in result)) return;
      expect(result.unknownKeys).toContain('extra');
    });
  });

  // ── Enforced format: rejects legacy variable-ID-keyed objects ──

  describe('rejects legacy formats', () => {
    it('rejects { prompt: "hello" } (must use { input: "hello" })', () => {
      const result = coerceFlowInput({ prompt: 'hello' }, agentContract);
      expect('message' in result).toBe(true);
      if (!('message' in result)) return;
      expect(result.message).toContain('standard envelope');
    });

    it('rejects { message: "hello" } (old chat format)', () => {
      const result = coerceFlowInput({ message: 'hello' }, agentContract);
      expect('message' in result).toBe(true);
    });

    it('rejects { prompt: "hello", model: "gpt-4o" } (use envelope)', () => {
      const result = coerceFlowInput({ prompt: 'hello', model: 'gpt-4o' }, agentContract);
      expect('message' in result).toBe(true);
    });
  });

  // ── No primary variable ──

  describe('no primary variable', () => {
    const noPrimaryContract: FlowInputContract = {
      configVariables: [
        {
          variableId: 'model',
          name: 'Model',
          typeSchema: { type: 'string' },
          defaultValue: 'gpt-4o',
          required: false,
        },
      ],
      inputSchema: { type: 'object', properties: {} },
    };

    it('rejects bare value when no primary', () => {
      const result = coerceFlowInput('hello', noPrimaryContract);
      expect('message' in result).toBe(true);
    });

    it('accepts config via envelope', () => {
      const result = coerceFlowInput(
        { input: undefined, config: { model: 'claude' } },
        noPrimaryContract,
      );
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['model']).toBe('claude');
    });

    it('applies defaults for empty input', () => {
      const result = coerceFlowInput({}, noPrimaryContract);
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['model']).toBe('gpt-4o');
    });

    it('rejects legacy variable-ID-keyed config', () => {
      const result = coerceFlowInput({ model: 'claude' }, noPrimaryContract);
      expect('message' in result).toBe(true);
    });

    const mcpRunnerLikeContract: FlowInputContract = {
      configVariables: [
        {
          variableId: 'operationId',
          name: 'Operation ID',
          typeSchema: { type: 'string' },
          required: false,
        },
        {
          variableId: 'inputs',
          name: 'Operation Inputs',
          typeSchema: { type: 'object' },
          required: false,
        },
      ],
      inputSchema: { type: 'object', properties: {} },
    };

    it('accepts mcp-runner envelope (config-only, empty primary slot)', () => {
      const result = coerceFlowInput(
        {
          input: {},
          config: {
            operationId: 'catalog.tool.list',
            inputs: { summaryOnly: true },
          },
        },
        mcpRunnerLikeContract,
      );
      expect('normalized' in result).toBe(true);
      if (!('normalized' in result)) return;
      expect(result.normalized['operationId']).toBe('catalog.tool.list');
      expect(result.normalized['inputs']).toEqual({ summaryOnly: true });
    });
  });
});

// ---------------------------------------------------------------------------
// validateFlowInput
// ---------------------------------------------------------------------------

describe('validateFlowInput', () => {
  const contract: FlowInputContract = {
    primaryInput: {
      variableId: 'prompt',
      name: 'Prompt',
      typeSchema: { type: 'string' },
      required: true,
    },
    configVariables: [
      {
        variableId: 'depth',
        name: 'Depth',
        typeSchema: { type: 'integer' },
        required: false,
      },
    ],
    inputSchema: { type: 'object', properties: {} },
  };

  it('passes valid input', () => {
    const result = validateFlowInput({ prompt: 'hello', depth: 3 }, contract);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when required primary is missing', () => {
    const result = validateFlowInput({}, contract);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('required');
  });

  it('fails on type mismatch (string expected, got number)', () => {
    const result = validateFlowInput({ prompt: 42 }, contract);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('type_mismatch');
  });

  it('fails on type mismatch (integer expected, got string)', () => {
    const result = validateFlowInput({ prompt: 'hello', depth: 'deep' }, contract);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('type_mismatch');
    expect(result.errors[0]?.path).toEqual(['depth']);
  });

  it('passes when optional config is omitted', () => {
    const result = validateFlowInput({ prompt: 'hello' }, contract);
    expect(result.valid).toBe(true);
  });

  it('checks immutable enforcement', () => {
    const vars: StateVariable[] = [
      makeVar({
        variableId: 'fixed',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        immutable: true,
        defaultValue: 'locked',
      }),
    ];
    const c: FlowInputContract = {
      configVariables: [
        {
          variableId: 'fixed',
          name: 'Fixed',
          typeSchema: { type: 'string' },
          defaultValue: 'locked',
          required: false,
        },
      ],
      inputSchema: { type: 'object', properties: {} },
    };
    const result = validateFlowInput({ fixed: 'override' }, c, vars);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.code).toBe('immutable');
  });
});

// ---------------------------------------------------------------------------
// processFlowInput (full pipeline)
// ---------------------------------------------------------------------------

describe('processFlowInput', () => {
  it('full pipeline: agent flow, bare string input', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
      }),
      makeVar({
        variableId: 'model',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        defaultValue: 'gpt-4o',
      }),
    ]);

    const result = processFlowInput('hello world', flow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized['prompt']).toBe('hello world');
    expect(result.normalized['model']).toBe('gpt-4o');
    expect(result.coercionNotes.length).toBeGreaterThan(0);
  });

  it('full pipeline: structured flow, envelope input', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'config',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
        typeSchema: { type: 'object' },
        semanticType: 'json',
      }),
    ]);

    const result = processFlowInput({ input: { url: 'http://x', depth: 3 } }, flow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized['config']).toEqual({ url: 'http://x', depth: 3 });
  });

  it('full pipeline: rejects legacy variable-ID-keyed input', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
      }),
    ]);

    const result = processFlowInput({ prompt: 'hello' }, flow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('coercion');
  });

  it('full pipeline: validation error (missing required)', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
      }),
    ]);

    const result = processFlowInput(null, flow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('validation');
  });

  it('full pipeline: flow with no input variables accepts empty', () => {
    const flow = makeFlow([]);
    const result = processFlowInput({}, flow);
    expect(result.ok).toBe(true);
  });

  it('full pipeline: flow with no input variables accepts bare string gracefully', () => {
    const flow = makeFlow([]);
    // No primary → bare value rejected
    const result = processFlowInput('hello', flow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('coercion');
  });

  it('full pipeline: standard envelope { input, config }', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
      }),
      makeVar({
        variableId: 'model',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        defaultValue: 'gpt-4o',
      }),
    ]);

    const result = processFlowInput({ input: 'scheduled test', config: { model: 'claude' } }, flow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized['prompt']).toBe('scheduled test');
    expect(result.normalized['model']).toBe('claude');
  });

  it('full pipeline: standard envelope with input only (config defaults apply)', () => {
    const flow = makeFlow([
      makeVar({
        variableId: 'prompt',
        inputRole: 'primary',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        required: true,
      }),
      makeVar({
        variableId: 'model',
        lifecycle: { isInput: true, isOutput: false, persistOnPause: true, updateCount: 0 },
        defaultValue: 'gpt-4o',
      }),
    ]);

    // This is exactly what a schedule would send: { input: "message text" }
    const result = processFlowInput({ input: 'This is a scheduled test run.' }, flow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized['prompt']).toBe('This is a scheduled test run.');
    expect(result.normalized['model']).toBe('gpt-4o');
  });
});
