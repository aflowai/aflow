/**
 * Tests for the unified flow validation pipeline.
 */
import { describe, it, expect } from 'vitest';
import {
  validateAgentDefinition,
  getStepIssues,
  type CatalogEntryForValidation,
} from '../artifact/flowValidation.js';
import { buildDefinitionSchemaBundle } from '../catalog/definitionSchemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalFlow(overrides: Record<string, unknown> = {}) {
  return {
    flowId: 'test-flow',
    metadata: { name: 'Test Flow' },
    startStepId: 'start',
    steps: [
      {
        stepId: 'start',
        stepType: 'ai',
        operation: 'ai.text.generate',
        config: {},
        onSuccess: { next: [] },
        onFailure: { next: [] },
      },
    ],
    stateVariables: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Layer 1: Shape
// ---------------------------------------------------------------------------

describe('Shape validation', () => {
  it('passes for a minimal valid flow', () => {
    const result = validateAgentDefinition(minimalFlow());
    expect(result.valid).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.stepCount).toBe(1);
    expect(result.stateVariableCount).toBe(0);
  });

  it('reports missing flowId', () => {
    const result = validateAgentDefinition(minimalFlow({ flowId: '' }));
    expect(result.issues.some((i) => i.code === 'MISSING_FLOW_ID')).toBe(true);
  });

  it('reports missing flow name', () => {
    const result = validateAgentDefinition(minimalFlow({ metadata: {} }));
    expect(result.issues.some((i) => i.code === 'MISSING_FLOW_NAME')).toBe(true);
  });

  it('reports missing steps', () => {
    const result = validateAgentDefinition(minimalFlow({ steps: [] }));
    expect(result.issues.some((i) => i.code === 'NO_STEPS')).toBe(true);
  });

  it('reports missing startStepId', () => {
    const result = validateAgentDefinition(minimalFlow({ startStepId: '' }));
    expect(result.issues.some((i) => i.code === 'MISSING_START_STEP')).toBe(true);
  });

  it('reports duplicate step IDs', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'dup',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
        {
          stepId: 'dup',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
      startStepId: 'dup',
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.some((i) => i.code === 'DUPLICATE_STEP_ID')).toBe(true);
  });

  it('reports duplicate variable IDs', () => {
    const flow = minimalFlow({
      stateVariables: [
        { variableId: 'v', name: 'V' },
        { variableId: 'v', name: 'V2' },
      ],
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.some((i) => i.code === 'DUPLICATE_VARIABLE_ID')).toBe(true);
  });

  it('reports missing step fields', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: '',
          stepType: '',
          operation: '',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
      startStepId: 'start',
    });
    const result = validateAgentDefinition(flow);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_STEP_ID');
    expect(codes).toContain('MISSING_STEP_TYPE');
    expect(codes).toContain('MISSING_OPERATION');
  });
});

// ---------------------------------------------------------------------------
// Layer 2: Consistency
// ---------------------------------------------------------------------------

describe('Consistency validation', () => {
  it('reports invalid start step', () => {
    const result = validateAgentDefinition(minimalFlow({ startStepId: 'nonexistent' }));
    expect(result.issues.some((i) => i.code === 'INVALID_START_STEP')).toBe(true);
  });

  it('reports invalid transition targets', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [{ stepId: 'ghost', priority: 50 }] },
          onFailure: { next: [{ stepId: 'phantom', priority: 50 }] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    const targets = result.issues.filter((i) => i.code === 'INVALID_TRANSITION_TARGET');
    expect(targets.length).toBe(2);
  });

  it('reports invalid resume target', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
          onResume: { continueToStepId: 'missing' },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.some((i) => i.code === 'INVALID_RESUME_TARGET')).toBe(true);
  });

  it('reports unreachable steps', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
        {
          stepId: 'orphan',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    const unreachable = result.issues.filter((i) => i.code === 'UNREACHABLE_STEP');
    expect(unreachable.length).toBe(1);
    expect(unreachable[0]!.stepId).toBe('orphan');
  });

  it('does not flag reachable steps', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [{ stepId: 'next', priority: 50 }] },
          onFailure: { next: [] },
        },
        {
          stepId: 'next',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.filter((i) => i.code === 'UNREACHABLE_STEP').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 3: Binding validation
// ---------------------------------------------------------------------------

describe('Binding validation', () => {
  const catalog: CatalogEntryForValidation[] = [
    {
      operationId: 'ai.text.generate',
      stepType: 'ai',
      name: 'Generate Text',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: ['gpt-4', 'haiku'] },
        },
        required: ['prompt'],
      },
      internalFields: { input: ['historyRef'] },
    },
  ];

  it('reports unknown operation', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.nonexistent',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow, catalog);
    expect(result.issues.some((i) => i.code === 'UNKNOWN_OPERATION')).toBe(true);
  });

  it('reports step type mismatch', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'api',
          operation: 'ai.text.generate',
          config: { prompt: 'hello' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow, catalog);
    expect(result.issues.some((i) => i.code === 'STEP_TYPE_MISMATCH')).toBe(true);
  });

  it('reports unmapped required input', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow, catalog);
    expect(result.issues.some((i) => i.code === 'UNMAPPED_REQUIRED_INPUT')).toBe(true);
  });

  it('does not flag internal fields as unmapped', () => {
    const catalogWithInternal: CatalogEntryForValidation[] = [
      {
        operationId: 'ai.text.generate',
        stepType: 'ai',
        name: 'Generate Text',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            historyRef: { type: 'string' },
          },
          required: ['prompt', 'historyRef'],
        },
        internalFields: { input: ['historyRef'] },
      },
    ];
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: { prompt: 'hello' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow, catalogWithInternal);
    expect(result.issues.filter((i) => i.code === 'UNMAPPED_REQUIRED_INPUT').length).toBe(0);
  });

  it('reports invalid strict enum value', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: { prompt: 'hello', model: 'invalid-model' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow, catalog);
    expect(result.issues.some((i) => i.code === 'INVALID_ENUM_VALUE')).toBe(true);
  });

  it('skips enum validation for variable references', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: { prompt: 'hello', model: '${state.selectedModel}' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
      stateVariables: [{ variableId: 'selectedModel' }],
    });
    const result = validateAgentDefinition(flow, catalog);
    expect(result.issues.filter((i) => i.code === 'INVALID_ENUM_VALUE').length).toBe(0);
  });

  it('reports output mapping to undeclared variable', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: { prompt: 'hello' },
          outputMapping: { content: 'state.result' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow, catalog);
    expect(result.issues.some((i) => i.code === 'UNDECLARED_OUTPUT_VARIABLE')).toBe(true);
  });

  it('skips input coverage for agent tool steps', () => {
    const agentCatalog: CatalogEntryForValidation[] = [
      ...catalog,
      {
        operationId: 'ai.agent.turn',
        stepType: 'ai',
        name: 'Agent Turn',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
    ];
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'agent',
          stepType: 'ai',
          operation: 'ai.agent.turn',
          config: { prompt: 'hello' },
          onSuccess: { next: [{ stepId: 'tool', priority: 50 }] },
          onFailure: { next: [] },
        },
        {
          stepId: 'tool',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
      startStepId: 'agent',
    });
    const result = validateAgentDefinition(flow, agentCatalog);
    // tool step should NOT have UNMAPPED_REQUIRED_INPUT since it's an agent tool
    const toolIssues = getStepIssues(result, 'tool');
    expect(toolIssues.filter((i) => i.code === 'UNMAPPED_REQUIRED_INPUT').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 4: Expression validation
// ---------------------------------------------------------------------------

describe('Expression validation', () => {
  it('reports unknown variable references in config', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: { prompt: '${state.nonexistent}' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.some((i) => i.code === 'UNKNOWN_VARIABLE_REF')).toBe(true);
  });

  it('does not flag valid variable references', () => {
    const flow = minimalFlow({
      stateVariables: [{ variableId: 'name' }],
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: { prompt: 'Hello ${state.name}' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.filter((i) => i.code === 'UNKNOWN_VARIABLE_REF').length).toBe(0);
  });

  it('validates output mapping expressions', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          outputMapping: { content: 'state.missing' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    // UNDECLARED_OUTPUT_VARIABLE requires catalog, but UNKNOWN_VARIABLE_REF
    // fires from expression validation regardless
    // Note: extractVariableKey only matches `state.X` so it will be caught
    // by expression validation as well
    const refs = result.issues.filter((i) => i.code === 'UNKNOWN_VARIABLE_REF');
    expect(refs.length).toBeGreaterThan(0);
  });

  it('validates condition expressions', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          condition: 'state.flag',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.some((i) => i.code === 'UNKNOWN_VARIABLE_REF')).toBe(true);
  });

  it('accepts static values in expressions', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          condition: '"always"',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    expect(result.issues.filter((i) => i.code === 'UNKNOWN_VARIABLE_REF').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getStepIssues
// ---------------------------------------------------------------------------

describe('getStepIssues', () => {
  it('filters issues by stepId', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
        {
          stepId: 'orphan',
          stepType: 'ai',
          operation: 'ai.text.generate',
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    const orphanIssues = getStepIssues(result, 'orphan');
    expect(orphanIssues.length).toBeGreaterThan(0);
    expect(orphanIssues.every((i) => i.stepId === 'orphan')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flat array onSuccess/onFailure normalization
// ---------------------------------------------------------------------------

describe('Flat array transition normalization', () => {
  it('accepts flat array form for onSuccess/onFailure', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          // Flat array form (no { next: [...] } wrapper)
          onSuccess: [{ stepId: 'end', priority: 50 }],
          onFailure: [],
        },
        {
          stepId: 'end',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          onSuccess: [],
          onFailure: [],
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    // Should NOT have unreachable step errors — the flat array form is valid
    const unreachable = result.issues.filter((i) => i.code === 'UNREACHABLE_STEP');
    expect(unreachable).toHaveLength(0);
  });

  it('accepts mixed flat/wrapped forms in the same flow', () => {
    const flow = minimalFlow({
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          onSuccess: [{ stepId: 'end' }], // flat
          onFailure: { next: [] }, // wrapped
        },
        {
          stepId: 'end',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: {},
          onSuccess: { next: [] }, // wrapped
          onFailure: [], // flat
        },
      ],
    });
    const result = validateAgentDefinition(flow);
    const unreachable = result.issues.filter((i) => i.code === 'UNREACHABLE_STEP');
    expect(unreachable).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('DefinitionSchemaBundle validation rule drift guard', () => {
  /**
   * Collects all distinct validation codes that validateAgentDefinition() can
   * actually emit by running it against a set of deliberately broken flows.
   * If a new code is added to flowValidation.ts but not to the bundle's
   * FLOW_VALIDATION_RULES, this test will fail.
   */
  it('bundle rule IDs cover all codes emitted by validateAgentDefinition()', () => {
    const bundle = buildDefinitionSchemaBundle('flow_definition');
    const bundleRuleIds = new Set(bundle.validationRules.map((r) => r.ruleId));

    // Construct flows that trigger every known validation code
    const emittedCodes = new Set<string>();

    // Layer 1: Shape
    collect(validateAgentDefinition({}), emittedCodes); // MISSING_FLOW_ID, MISSING_FLOW_NAME, NO_STEPS, MISSING_START_STEP
    collect(validateAgentDefinition({ flowId: '123Invalid' }), emittedCodes); // INVALID_FLOW_ID
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'a',
        steps: [
          { stepId: 'a', operation: 'x' },
          { stepId: '', stepType: '', operation: '' },
        ],
      }),
      emittedCodes,
    ); // MISSING_STEP_ID, MISSING_STEP_TYPE, MISSING_OPERATION
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'a',
        steps: [
          { stepId: 'a', stepType: 'ai', operation: 'ai.text.generate' },
          { stepId: 'a', stepType: 'ai', operation: 'ai.text.generate' },
        ],
      }),
      emittedCodes,
    ); // DUPLICATE_STEP_ID
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'a',
        steps: [{ stepId: 'a', stepType: 'ai', operation: 'ai.text.generate' }],
        stateVariables: [{ variableId: 'x' }, { variableId: 'x' }],
      }),
      emittedCodes,
    ); // DUPLICATE_VARIABLE_ID

    // Layer 2: Consistency
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'missing',
        steps: [{ stepId: 'a', stepType: 'ai', operation: 'ai.text.generate' }],
      }),
      emittedCodes,
    ); // INVALID_START_STEP, UNREACHABLE_STEP
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'a',
        steps: [
          {
            stepId: 'a',
            stepType: 'ai',
            operation: 'ai.text.generate',
            onSuccess: { next: [{ stepId: 'ghost' }] },
            onFailure: { next: [{ stepId: 'ghost2' }] },
          },
        ],
      }),
      emittedCodes,
    ); // INVALID_TRANSITION_TARGET
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'a',
        steps: [
          {
            stepId: 'a',
            stepType: 'ai',
            operation: 'ai.text.generate',
            onResume: { continueToStepId: 'ghost' },
          },
        ],
      }),
      emittedCodes,
    ); // INVALID_RESUME_TARGET

    // Layer 3: Binding (requires catalog)
    const catalog: CatalogEntryForValidation[] = [
      {
        operationId: 'ai.text.generate',
        stepType: 'ai',
        name: 'Generate',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            model: { type: 'string', enum: ['gpt-4o', 'gemini'] },
          },
          required: ['prompt'],
        },
      },
    ];
    collect(
      validateAgentDefinition(
        {
          flowId: 'ok',
          metadata: { name: 'OK' },
          startStepId: 'a',
          steps: [
            {
              stepId: 'a',
              stepType: 'ai',
              operation: 'unknown.op',
              config: {},
            },
          ],
        },
        catalog,
      ),
      emittedCodes,
    ); // UNKNOWN_OPERATION
    collect(
      validateAgentDefinition(
        {
          flowId: 'ok',
          metadata: { name: 'OK' },
          startStepId: 'a',
          steps: [
            {
              stepId: 'a',
              stepType: 'wrong',
              operation: 'ai.text.generate',
              config: { prompt: 'hi' },
            },
          ],
        },
        catalog,
      ),
      emittedCodes,
    ); // STEP_TYPE_MISMATCH
    collect(
      validateAgentDefinition(
        {
          flowId: 'ok',
          metadata: { name: 'OK' },
          startStepId: 'a',
          steps: [
            {
              stepId: 'a',
              stepType: 'ai',
              operation: 'ai.text.generate',
              config: {},
            },
          ],
        },
        catalog,
      ),
      emittedCodes,
    ); // UNMAPPED_REQUIRED_INPUT
    collect(
      validateAgentDefinition(
        {
          flowId: 'ok',
          metadata: { name: 'OK' },
          startStepId: 'a',
          steps: [
            {
              stepId: 'a',
              stepType: 'ai',
              operation: 'ai.text.generate',
              config: { prompt: 'hi', model: 'invalid-model' },
            },
          ],
        },
        catalog,
      ),
      emittedCodes,
    ); // INVALID_ENUM_VALUE
    collect(
      validateAgentDefinition(
        {
          flowId: 'ok',
          metadata: { name: 'OK' },
          startStepId: 'a',
          steps: [
            {
              stepId: 'a',
              stepType: 'ai',
              operation: 'ai.text.generate',
              config: { prompt: 'hi' },
              outputMapping: { content: 'state.undeclared' },
            },
          ],
        },
        catalog,
      ),
      emittedCodes,
    ); // UNDECLARED_OUTPUT_VARIABLE

    // Layer 4: Expression
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'a',
        steps: [
          {
            stepId: 'a',
            stepType: 'ai',
            operation: 'ai.text.generate',
            config: { prompt: '${state.nope}' },
          },
        ],
      }),
      emittedCodes,
    ); // UNKNOWN_VARIABLE_REF

    // Layer 5: Zod input — STEP_INPUT_VALIDATION_ERROR fires when a static
    // config value fails the operation's Zod schema. We trigger it by passing
    // a wrong type (number where string is required).
    collect(
      validateAgentDefinition({
        flowId: 'ok',
        metadata: { name: 'OK' },
        startStepId: 'a',
        steps: [
          {
            stepId: 'a',
            stepType: 'ai',
            operation: 'ai.text.generate',
            config: { prompt: 12345 },
          },
        ],
      }),
      emittedCodes,
    ); // STEP_INPUT_VALIDATION_ERROR

    // Now check: every code actually emitted must appear in the bundle
    for (const code of emittedCodes) {
      expect(
        bundleRuleIds.has(code),
        `Validation code "${code}" is emitted by validateAgentDefinition() but missing from DefinitionSchemaBundle.validationRules`,
      ).toBe(true);
    }

    // And every bundle rule should be triggerable (no stale rules)
    for (const ruleId of bundleRuleIds) {
      expect(
        emittedCodes.has(ruleId),
        `Bundle rule "${ruleId}" is declared but never emitted by validateAgentDefinition() — is it stale?`,
      ).toBe(true);
    }
  });

  it('bundle schema hash is deterministic', () => {
    const a = buildDefinitionSchemaBundle('flow_definition');
    const b = buildDefinitionSchemaBundle('flow_definition');
    expect(a.schemaHash).toBe(b.schemaHash);
  });

  it('bundle compact text includes key field names', () => {
    const bundle = buildDefinitionSchemaBundle('flow_definition');
    expect(bundle.compactText).toContain('flowId');
    expect(bundle.compactText).toContain('startStepId');
    expect(bundle.compactText).toContain('stateVariables');
    expect(bundle.compactText).toContain('onSuccess');
    expect(bundle.compactText).toContain('agentRole');
    expect(bundle.compactText).toContain('outputMapping');
  });
});

function collect(result: { issues: Array<{ code: string }> }, codes: Set<string>): void {
  for (const issue of result.issues) {
    codes.add(issue.code);
  }
}
