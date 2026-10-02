import { describe, it, expect } from 'vitest';
import {
  analyzeInputTemplate,
  isTemplateBindNode,
  substituteTemplateBinds,
  templateContainsBind,
  TemplateSubstitutionError,
  WorkflowTaskSchema,
} from '../workflow.js';

// ---------------------------------------------------------------------------
// Bind-node grammar
// ---------------------------------------------------------------------------

describe('isTemplateBindNode', () => {
  it('accepts exactly { $bind: "<name>" }', () => {
    expect(isTemplateBindNode({ $bind: 'token' })).toBe(true);
  });

  it.each([
    [{ $bind: 'x', extra: 1 }, 'extra keys'],
    [{ $bind: 42 }, 'non-string value'],
    [{ $bind: '' }, 'empty string'],
    [['$bind'], 'array'],
    ['$bind', 'string'],
    [null, 'null'],
    [{}, 'empty object'],
  ])('rejects %j (%s)', (value) => {
    expect(isTemplateBindNode(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

describe('analyzeInputTemplate', () => {
  it('collects nested binds with dotted + indexed paths (Kaggle finalize shape)', () => {
    const template = {
      serverId: 'kaggle',
      toolName: 'submit_to_competition',
      arguments: {
        request: {
          competitionName: { $bind: 'competitionName' },
          blobFileTokens: [{ $bind: 'blobToken' }],
          submissionDescription: { $bind: 'message' },
        },
      },
    };
    const analysis = analyzeInputTemplate(template);
    expect(analysis.malformed).toEqual([]);
    expect(analysis.binds).toEqual([
      { bindAs: 'competitionName', path: 'arguments.request.competitionName' },
      { bindAs: 'blobToken', path: 'arguments.request.blobFileTokens[0]' },
      { bindAs: 'message', path: 'arguments.request.submissionDescription' },
    ]);
  });

  it('flags malformed bind nodes (extra keys / non-string) without descending into them', () => {
    const template = {
      a: { $bind: 'x', extra: { $bind: 'inner' } },
      b: { $bind: 7 },
    };
    const analysis = analyzeInputTemplate(template);
    expect(analysis.binds).toEqual([]); // never descends into a bind-node attempt
    expect(analysis.malformed.map((m) => m.path).sort()).toEqual(['a', 'b']);
  });

  it('a root-level bind node has path ""', () => {
    const analysis = analyzeInputTemplate({ $bind: 'whole' });
    expect(analysis.binds).toEqual([{ bindAs: 'whole', path: '' }]);
  });
});

describe('templateContainsBind', () => {
  it('detects binds at depth, including malformed attempts', () => {
    expect(templateContainsBind({ a: [{ b: { $bind: 'x' } }] })).toBe(true);
    expect(templateContainsBind({ a: [{ b: { $bind: 1, c: 2 } }] })).toBe(true);
    expect(templateContainsBind({ a: [1, 'two', { b: null }] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

describe('substituteTemplateBinds', () => {
  const declared = new Set(['competitionName', 'blobToken', 'message', 'optionalNote']);

  it('deep-substitutes nested objects and arrays (Kaggle finalize shape)', () => {
    const template = {
      serverId: 'kaggle',
      toolName: 'submit_to_competition',
      arguments: {
        request: {
          competitionName: { $bind: 'competitionName' },
          blobFileTokens: [{ $bind: 'blobToken' }],
          submissionDescription: { $bind: 'message' },
        },
      },
    };
    const result = substituteTemplateBinds(
      template,
      { competitionName: 'titanic', blobToken: 'tok-123', message: 'v9 ensemble' },
      declared,
    );
    expect(result).toEqual({
      serverId: 'kaggle',
      toolName: 'submit_to_competition',
      arguments: {
        request: {
          competitionName: 'titanic',
          blobFileTokens: ['tok-123'],
          submissionDescription: 'v9 ensemble',
        },
      },
    });
  });

  it('omits object properties and array elements whose declared binding resolved absent', () => {
    const template = {
      note: { $bind: 'optionalNote' },
      tokens: [{ $bind: 'blobToken' }, { $bind: 'optionalNote' }, 'literal'],
      kept: true,
    };
    const result = substituteTemplateBinds(template, { blobToken: 't' }, declared);
    expect(result).toEqual({ tokens: ['t', 'literal'], kept: true });
    expect('note' in result).toBe(false);
  });

  it('substitutes complex values (objects/arrays) verbatim', () => {
    const result = substituteTemplateBinds(
      { payload: { $bind: 'message' } },
      { message: { nested: [1, 2, { deep: true }] } },
      declared,
    );
    expect(result).toEqual({ payload: { nested: [1, 2, { deep: true }] } });
  });

  it('throws on a $bind naming an undeclared binding', () => {
    expect(() => substituteTemplateBinds({ a: { $bind: 'nope' } }, {}, declared)).toThrowError(
      TemplateSubstitutionError,
    );
    try {
      substituteTemplateBinds({ a: { $bind: 'nope' } }, {}, declared);
    } catch (err) {
      expect((err as TemplateSubstitutionError).bindAs).toBe('nope');
      expect((err as TemplateSubstitutionError).path).toBe('a');
    }
  });

  it('throws on a malformed bind node', () => {
    expect(() =>
      substituteTemplateBinds({ a: { $bind: 'message', extra: 1 } }, { message: 'm' }, declared),
    ).toThrowError(TemplateSubstitutionError);
  });

  it('a root bind node substitutes the whole op input when it resolves to an object', () => {
    const result = substituteTemplateBinds(
      { $bind: 'message' },
      { message: { whole: 'input' } },
      declared,
    );
    expect(result).toEqual({ whole: 'input' });
  });

  it('throws when the root resolves absent or non-object', () => {
    expect(() => substituteTemplateBinds({ $bind: 'optionalNote' }, {}, declared)).toThrowError(
      TemplateSubstitutionError,
    );
    expect(() =>
      substituteTemplateBinds({ $bind: 'message' }, { message: 'a string' }, declared),
    ).toThrowError(TemplateSubstitutionError);
  });

  it('null is a present value, not an absence', () => {
    const result = substituteTemplateBinds(
      { note: { $bind: 'optionalNote' } },
      { optionalNote: null },
      declared,
    );
    expect(result).toEqual({ note: null });
  });
});

// ---------------------------------------------------------------------------
// Operator nodes
// ---------------------------------------------------------------------------

describe('$concat and $firstOf', () => {
  const declared = new Set(['owner', 'branch', 'summary', 'messageBody']);

  it('joins strings, and is absent when any part is', () => {
    const template = { head: { $concat: [{ $bind: 'owner' }, ':', { $bind: 'branch' }] } };
    expect(substituteTemplateBinds(template, { owner: 'aflowai', branch: 'aflow/x' }, declared)).toEqual(
      { head: 'aflowai:aflow/x' },
    );
    expect(substituteTemplateBinds(template, { branch: 'aflow/x' }, declared)).toEqual({});
  });

  it('refuses a part that is not a string, naming the operand', () => {
    const template = { head: { $concat: [{ $bind: 'owner' }, ':', { $bind: 'branch' }] } };
    try {
      substituteTemplateBinds(template, { owner: 7, branch: 'b' }, declared);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateSubstitutionError);
      expect((err as TemplateSubstitutionError).path).toBe('head.$concat[0]');
    }
  });

  it('takes the first alternative that is present, null included, and is absent when none is', () => {
    const template = { body: { $firstOf: [{ $bind: 'summary' }, { $bind: 'messageBody' }] } };
    expect(
      substituteTemplateBinds(template, { summary: 'S', messageBody: 'M' }, declared),
    ).toEqual({ body: 'S' });
    expect(substituteTemplateBinds(template, { messageBody: 'M' }, declared)).toEqual({
      body: 'M',
    });
    expect(substituteTemplateBinds(template, { summary: null, messageBody: 'M' }, declared)).toEqual(
      { body: null },
    );
    expect(substituteTemplateBinds(template, {}, declared)).toEqual({});
  });

  it('nests, each operand substituted by the same rules', () => {
    const template = {
      v: { $concat: ['#', { $firstOf: [{ $bind: 'summary' }, 'none'] }] },
    };
    expect(substituteTemplateBinds(template, {}, declared)).toEqual({ v: '#none' });
  });

  it('collects the binds inside an operator for the analyzer', () => {
    const analysis = analyzeInputTemplate({
      head: { $concat: [{ $bind: 'owner' }, ':', { $bind: 'branch' }] },
    });
    expect(analysis.malformed).toEqual([]);
    expect(analysis.binds).toEqual([
      { bindAs: 'owner', path: 'head.$concat[0]' },
      { bindAs: 'branch', path: 'head.$concat[2]' },
    ]);
  });

  it.each([
    [{ $concat: 'owner' }, 'takes an array of at least two operands'],
    [{ $firstOf: [{ $bind: 'summary' }] }, 'takes an array of at least two operands'],
    [{ $concat: ['a', 'b'], extra: 1 }, 'exactly the single key "$concat"'],
  ])('flags %j as malformed, and substitution refuses it', (node, reason) => {
    const analysis = analyzeInputTemplate({ v: node });
    expect(analysis.malformed).toHaveLength(1);
    expect(analysis.malformed[0]?.reason).toContain(reason);
    expect(() => substituteTemplateBinds({ v: node }, { summary: 's' }, declared)).toThrowError(
      TemplateSubstitutionError,
    );
  });
});

// ---------------------------------------------------------------------------
// WorkflowTaskSchema parse-time teachers
// ---------------------------------------------------------------------------

describe('WorkflowTaskSchema — inputTemplate', () => {
  const baseOp = {
    taskId: 'finalize',
    name: 'Finalize',
    goal: 'Submit the result.',
    type: 'operation' as const,
    operation: 'mcp.tool.call',
  };

  it('parses an operation task with a valid template referencing declared bindings + literal inputs', () => {
    const parsed = WorkflowTaskSchema.safeParse({
      ...baseOp,
      inputs: { competitionName: 'titanic' },
      inputBindings: {
        blobToken: { kind: 'task_output', taskId: 'upload', path: 'token' },
      },
      inputTemplate: {
        serverId: 'kaggle',
        toolName: 'submit_to_competition',
        arguments: {
          request: {
            competitionName: { $bind: 'competitionName' },
            blobFileTokens: [{ $bind: 'blobToken' }],
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects inputTemplate on an agent task', () => {
    const parsed = WorkflowTaskSchema.safeParse({
      taskId: 'a',
      name: 'A',
      goal: 'g',
      type: 'agent',
      inputTemplate: { x: 1 },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain(
      'only valid on operation tasks',
    );
  });

  it('rejects a $bind that names no declared binding or literal inputs key', () => {
    const parsed = WorkflowTaskSchema.safeParse({
      ...baseOp,
      inputTemplate: { a: { $bind: 'ghost' } },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain('ghost');
  });

  it('rejects a malformed bind node', () => {
    const parsed = WorkflowTaskSchema.safeParse({
      ...baseOp,
      inputs: { x: 1 },
      inputTemplate: { a: { $bind: 'x', extra: true } },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain('malformed');
  });
});
