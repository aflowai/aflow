import { describe, expect, it } from 'vitest';
import type { Workflow } from '@aflow/schemas';
import {
  validateAgentOutput,
  annotateWithConsumers,
  type AjvErrorObject,
} from '../agentOutputValidator.js';

// ── Schemas used across tests ────────────────────────────────────────────────

const CARD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['reportPath', 'cardData'],
  properties: {
    reportPath: { type: 'string' },
    cardData: {
      type: 'object',
      required: ['account', 'positions'],
      properties: {
        account: { type: 'string' },
        positions: { type: 'array' },
      },
    },
  },
  additionalProperties: false,
};

// ── validateAgentOutput ──────────────────────────────────────────────────────

describe('validateAgentOutput', () => {
  it('returns ok for a well-formed payload', () => {
    const result = validateAgentOutput(
      { reportPath: '/r.html', cardData: { account: 'a1', positions: [] } },
      CARD_SCHEMA,
    );
    expect(result.ok).toBe(true);
  });

  it('flags missing top-level required field', () => {
    const result = validateAgentOutput(
      { reportPath: '/r.html' /* cardData missing */ },
      CARD_SCHEMA,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.formatted.join(' | ')).toContain('cardData');
    expect(result.actualDesc).toContain('reportPath');
  });

  it('flags missing nested required field', () => {
    const result = validateAgentOutput(
      { reportPath: '/r.html', cardData: { account: 'a1' /* positions missing */ } },
      CARD_SCHEMA,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.formatted.join(' | ')).toContain('positions');
  });

  it('flags type mismatch', () => {
    const result = validateAgentOutput(
      { reportPath: 42, cardData: { account: 'a1', positions: [] } },
      CARD_SCHEMA,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const blob = result.formatted.join(' | ');
    expect(blob).toContain('reportPath');
  });

  it('flags extra field when additionalProperties is false', () => {
    const result = validateAgentOutput(
      {
        reportPath: '/r.html',
        cardData: { account: 'a1', positions: [] },
        extra: 'oops',
      },
      CARD_SCHEMA,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.formatted.join(' | ')).toContain('extra');
  });

  it('returns a non-object actualDesc for scalar payloads', () => {
    const result = validateAgentOutput('not-an-object', CARD_SCHEMA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.actualDesc).toContain('Actual type: string');
  });

  it('throws on a malformed schema (compile-time error surfaces to caller)', () => {
    // Ajv with strict:false is permissive, but a circular reference or a
    // truly invalid keyword still throws. Using an invalid `type` value.
    const bad: Record<string, unknown> = { type: 'not-a-valid-type' };
    expect(() => validateAgentOutput({}, bad)).toThrow();
  });

  it('caps formatted errors at maxErrors', () => {
    const wide: Record<string, unknown> = {
      type: 'object',
      required: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string' },
        d: { type: 'string' },
        e: { type: 'string' },
        f: { type: 'string' },
        g: { type: 'string' },
      },
    };
    const result = validateAgentOutput({}, wide, { maxErrors: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.formatted.length).toBe(2);
    // rawErrors holds the full (filtered) list so callers like
    // annotateWithConsumers can still see all failures.
    expect(result.rawErrors.length).toBeGreaterThan(2);
  });
});

// ── annotateWithConsumers ────────────────────────────────────────────────────

function makeWorkflow(tasks: Workflow['tasks']): Workflow {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    slug: 'test-workflow',
    name: 'Test Workflow',
    description: '',
    outcomes: [{ id: 'done', name: 'Done', description: '' }] as Workflow['outcomes'],
    mode: { kind: 'sequence' } as Workflow['mode'],
    tasks,
    stateVariables: [],
    iteration: { maxIterations: 1, terminationConditions: [] } as Workflow['iteration'],
    revision: 1,
    status: 'published' as Workflow['status'],
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
  } as Workflow;
}

function requiredErr(instancePath: string, missing: string): AjvErrorObject {
  return {
    instancePath,
    schemaPath: '#/required',
    keyword: 'required',
    message: `must have required property '${missing}'`,
    params: { missingProperty: missing },
  };
}

describe('annotateWithConsumers', () => {
  it('suffixes when a consumer binds the failing field via task_output', () => {
    const workflow = makeWorkflow([
      {
        taskId: 'synthesize-report',
        name: 'Synthesize',
        goal: 'go',
      } as Workflow['tasks'][number],
      {
        taskId: 'render-card',
        name: 'Render',
        goal: 'render',
        operation: 'ui.artifact.render',
        inputBindings: {
          data: { kind: 'task_output', taskId: 'synthesize-report', path: 'cardData' },
        },
      } as unknown as Workflow['tasks'][number],
    ]);

    const errs = [requiredErr('', 'cardData')];
    const annotated = annotateWithConsumers(errs, workflow, 'synthesize-report');
    expect(annotated[0]).toContain('cardData');
    expect(annotated[0]).toContain('(consumed by: render-card.data)');
  });

  it('suffixes with multiple consumers comma-separated', () => {
    const workflow = makeWorkflow([
      { taskId: 'producer', name: 'P', goal: 'g' } as Workflow['tasks'][number],
      {
        taskId: 'c1',
        name: 'C1',
        goal: 'g',
        operation: 'ui.artifact.render',
        inputBindings: {
          data: { kind: 'task_output', taskId: 'producer', path: 'cardData' },
        },
      } as unknown as Workflow['tasks'][number],
      {
        taskId: 'c2',
        name: 'C2',
        goal: 'g',
        operation: 'ui.artifact.render',
        inputBindings: {
          d2: { kind: 'task_output', taskId: 'producer', path: 'cardData' },
        },
      } as unknown as Workflow['tasks'][number],
    ]);

    const errs = [requiredErr('', 'cardData')];
    const annotated = annotateWithConsumers(errs, workflow, 'producer');
    expect(annotated[0]).toMatch(/consumed by: c1\.data, c2\.d2|consumed by: c2\.d2, c1\.data/);
  });

  it('does not fabricate when no consumer binds the path', () => {
    const workflow = makeWorkflow([
      { taskId: 'producer', name: 'P', goal: 'g' } as Workflow['tasks'][number],
      {
        taskId: 'unrelated',
        name: 'U',
        goal: 'g',
        operation: 'ui.artifact.render',
        inputBindings: {
          data: { kind: 'task_output', taskId: 'producer', path: 'otherField' },
        },
      } as unknown as Workflow['tasks'][number],
    ]);

    const errs = [requiredErr('', 'cardData')];
    const annotated = annotateWithConsumers(errs, workflow, 'producer');
    expect(annotated[0]).not.toContain('consumed by:');
  });

  it('matches when consumer binds a parent of the failing path', () => {
    const workflow = makeWorkflow([
      { taskId: 'producer', name: 'P', goal: 'g' } as Workflow['tasks'][number],
      {
        taskId: 'render-card',
        name: 'R',
        goal: 'g',
        operation: 'ui.artifact.render',
        inputBindings: {
          data: { kind: 'task_output', taskId: 'producer', path: 'cardData' },
        },
      } as unknown as Workflow['tasks'][number],
    ]);

    // Failing nested field; the binding path 'cardData' is a prefix of
    // '/cardData/positions/3/symbol' so the consumer is matched.
    const errs: AjvErrorObject[] = [
      {
        instancePath: '/cardData/positions/3/symbol',
        schemaPath: '#/properties/cardData/properties/positions/items/properties/symbol/type',
        keyword: 'type',
        message: 'must be string',
        params: { type: 'string' },
      },
    ];
    const annotated = annotateWithConsumers(errs, workflow, 'producer');
    expect(annotated[0]).toContain('consumed by: render-card.data');
  });

  it('matches whole-output consumer (no path) for any failing field', () => {
    const workflow = makeWorkflow([
      { taskId: 'producer', name: 'P', goal: 'g' } as Workflow['tasks'][number],
      {
        taskId: 'wholeReader',
        name: 'W',
        goal: 'g',
        operation: 'ui.artifact.render',
        inputBindings: {
          everything: { kind: 'task_output', taskId: 'producer' },
        },
      } as unknown as Workflow['tasks'][number],
    ]);

    const errs = [requiredErr('', 'cardData')];
    const annotated = annotateWithConsumers(errs, workflow, 'producer');
    expect(annotated[0]).toContain('consumed by: wholeReader.everything');
  });

  it('matches a [n]-indexed binding path against the Ajv slash-path (shared dialect)', () => {
    const workflow = makeWorkflow([
      { taskId: 'producer', name: 'P', goal: 'g' } as Workflow['tasks'][number],
      {
        taskId: 'consumer',
        name: 'C',
        goal: 'g',
        operation: 'ui.artifact.render',
        inputBindings: {
          text: { kind: 'task_output', taskId: 'producer', path: 'content[0].text' },
        },
      } as unknown as Workflow['tasks'][number],
    ]);

    const errs: AjvErrorObject[] = [
      {
        instancePath: '/content/0/text',
        schemaPath: '#/properties/content/items/properties/text/type',
        keyword: 'type',
        message: 'must be string',
        params: { type: 'string' },
      },
    ];
    const annotated = annotateWithConsumers(errs, workflow, 'producer');
    expect(annotated[0]).toContain('consumed by: consumer.text');
  });

  it('does NOT match when a binding path looks like a prefix but breaks at a non-segment boundary', () => {
    const workflow = makeWorkflow([
      { taskId: 'producer', name: 'P', goal: 'g' } as Workflow['tasks'][number],
      {
        taskId: 'consumer',
        name: 'C',
        goal: 'g',
        operation: 'ui.artifact.render',
        inputBindings: {
          data: { kind: 'task_output', taskId: 'producer', path: 'card' },
        },
      } as unknown as Workflow['tasks'][number],
    ]);

    // Binding path 'card' should NOT match field '/cardData' — segment
    // boundary required.
    const errs = [requiredErr('', 'cardData')];
    const annotated = annotateWithConsumers(errs, workflow, 'producer');
    expect(annotated[0]).not.toContain('consumed by:');
  });
});
