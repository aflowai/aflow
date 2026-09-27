import { describe, expect, it } from 'vitest';
import {
  compileRestrictedPath,
  evaluateEnum,
  evaluateValue,
  evaluateCount,
  RestrictedPathSyntaxError,
  RestrictedPathEvalError,
} from './restrictedJsonpath.js';

describe('compileRestrictedPath — allowed forms', () => {
  it.each([
    '$',
    '$.workflow',
    '$.workflow.tasks',
    '$.workflow.tasks[*]',
    '$.workflow.tasks[*].taskId',
    '$.evalSuite.taskCriteria.propertyNames.enum',
    "$['$ref']",
    '$["additionalProperties"]',
    '$.a.b.c',
    '$._underscore.field0',
  ])('compiles %s', (path) => {
    expect(() => compileRestrictedPath(path)).not.toThrow();
  });
});

describe('compileRestrictedPath — forbidden forms', () => {
  it.each([
    ['', 'empty'],
    ['workflow', 'no $ root'],
    ['$..tasks', 'recursive descent'],
    ['$.tasks[0]', 'numeric index'],
    ['$.tasks[0:5]', 'slice'],
    ['$.tasks[?(@.x)]', 'filter'],
    ['$.tasks[]', 'empty bracket'],
    ['$.tasks[*', 'unterminated wildcard'],
    ['$.tasks["unterminated', 'unterminated quoted member'],
    ['$..', 'recursive at end'],
    ["$['']", 'empty quoted member'],
    ['$.tasks?', 'unexpected character'],
    ['$.123', 'member starting with digit'],
  ])('rejects %s (%s)', (path) => {
    expect(() => compileRestrictedPath(path)).toThrow(RestrictedPathSyntaxError);
  });
});

describe('evaluateEnum', () => {
  const data = {
    workflow: {
      tasks: [
        { taskId: 'design-skill', type: 'agent' },
        { taskId: 'draft-evals', type: 'agent' },
        { taskId: 'validate-and-propose', type: 'operation' },
      ],
    },
  };

  it('collects every match into a deduped sorted array', () => {
    const path = compileRestrictedPath('$.workflow.tasks[*].taskId');
    expect(evaluateEnum(data, path)).toEqual([
      'design-skill',
      'draft-evals',
      'validate-and-propose',
    ]);
  });

  it('dedupes repeated scalar values', () => {
    const dupes = {
      list: [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: 'c' }, { k: 'b' }],
    };
    const path = compileRestrictedPath('$.list[*].k');
    expect(evaluateEnum(dupes, path)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array when no match (caller decides what to do)', () => {
    const path = compileRestrictedPath('$.workflow.nope[*].x');
    expect(evaluateEnum(data, path)).toEqual([]);
  });

  it('throws TYPE_MISMATCH on non-scalar matches', () => {
    const path = compileRestrictedPath('$.workflow.tasks');
    expect(() => evaluateEnum(data, path)).toThrow(
      expect.objectContaining({ code: 'TYPE_MISMATCH' }),
    );
  });

  it('throws EXPECTED_ARRAY when wildcard hits a non-array', () => {
    const path = compileRestrictedPath('$.workflow.tasks[*].taskId[*]');
    expect(() => evaluateEnum(data, path)).toThrow(
      expect.objectContaining({ code: 'EXPECTED_ARRAY' }),
    );
  });
});

describe('evaluateValue', () => {
  const data = { workflow: { slug: 'compose-skill' }, count: 5, deep: { nested: null } };

  it('returns the scalar at a unique match', () => {
    expect(evaluateValue(data, compileRestrictedPath('$.workflow.slug'))).toBe('compose-skill');
    expect(evaluateValue(data, compileRestrictedPath('$.count'))).toBe(5);
    expect(evaluateValue(data, compileRestrictedPath('$.deep.nested'))).toBeNull();
  });

  it('throws PATH_NOT_FOUND on zero matches', () => {
    expect(() => evaluateValue(data, compileRestrictedPath('$.absent'))).toThrow(
      expect.objectContaining({ code: 'PATH_NOT_FOUND' }),
    );
  });

  it('throws AMBIGUOUS_VALUE on multiple matches', () => {
    const dupes = { list: [{ k: 'a' }, { k: 'b' }] };
    expect(() => evaluateValue(dupes, compileRestrictedPath('$.list[*].k'))).toThrow(
      expect.objectContaining({ code: 'AMBIGUOUS_VALUE' }),
    );
  });

  it('throws EXPECTED_SCALAR for object/array values', () => {
    expect(() => evaluateValue(data, compileRestrictedPath('$.workflow'))).toThrow(
      expect.objectContaining({ code: 'EXPECTED_SCALAR' }),
    );
  });
});

describe('evaluateCount', () => {
  const data = { workflow: { tasks: [1, 2, 3] }, empty: [], scalar: 'oops' };

  it('returns array length', () => {
    expect(evaluateCount(data, compileRestrictedPath('$.workflow.tasks'))).toBe(3);
    expect(evaluateCount(data, compileRestrictedPath('$.empty'))).toBe(0);
  });

  it('throws PATH_NOT_FOUND when missing', () => {
    expect(() => evaluateCount(data, compileRestrictedPath('$.nope'))).toThrow(
      expect.objectContaining({ code: 'PATH_NOT_FOUND' }),
    );
  });

  it('throws EXPECTED_ARRAY on non-arrays', () => {
    expect(() => evaluateCount(data, compileRestrictedPath('$.scalar'))).toThrow(
      expect.objectContaining({ code: 'EXPECTED_ARRAY' }),
    );
  });
});

describe('quoted member access', () => {
  const data = { $ref: 'foo', additionalProperties: false, 'with-dash': true };

  it('reads the field name verbatim', () => {
    expect(evaluateValue(data, compileRestrictedPath("$['$ref']"))).toBe('foo');
    expect(evaluateValue(data, compileRestrictedPath('$["additionalProperties"]'))).toBe(false);
  });

  it('rejects empty quoted member at compile time', () => {
    expect(() => compileRestrictedPath("$['']")).toThrow(RestrictedPathSyntaxError);
  });
});
