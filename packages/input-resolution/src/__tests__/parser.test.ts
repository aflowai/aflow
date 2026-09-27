import { describe, it, expect } from 'vitest';
import { parseRef, parseValue, hasRefs, extractRefs } from '../parser.js';

describe('parseRef', () => {
  describe('state references', () => {
    it('parses simple state reference', () => {
      const result = parseRef('state.userId');
      expect(result).toEqual({
        raw: 'state.userId',
        source: 'state',
        path: ['userId'],
      });
    });

    it('parses nested state reference', () => {
      const result = parseRef('state.user.profile.name');
      expect(result).toEqual({
        raw: 'state.user.profile.name',
        source: 'state',
        path: ['user', 'profile', 'name'],
      });
    });

    it('rejects empty state reference', () => {
      const result = parseRef('state');
      expect(result).toHaveProperty('code', 'INPUT_REF_PARSE_ERROR');
    });
  });

  describe('step references', () => {
    it('parses step output reference', () => {
      const result = parseRef('steps.stepA.output.foo');
      expect(result).toEqual({
        raw: 'steps.stepA.output.foo',
        source: 'steps',
        path: ['foo'],
        stepId: 'stepA',
        accessor: 'output',
      });
    });

    it('parses step error reference', () => {
      const result = parseRef('steps.stepA.error.code');
      expect(result).toEqual({
        raw: 'steps.stepA.error.code',
        source: 'steps',
        path: ['code'],
        stepId: 'stepA',
        accessor: 'error',
      });
    });

    it('parses step output without path', () => {
      const result = parseRef('steps.stepA.output');
      expect(result).toEqual({
        raw: 'steps.stepA.output',
        source: 'steps',
        path: [],
        stepId: 'stepA',
        accessor: 'output',
      });
    });

    it('rejects invalid accessor', () => {
      const result = parseRef('steps.stepA.invalid.foo');
      expect(result).toHaveProperty('code', 'INPUT_REF_PARSE_ERROR');
    });

    it('rejects step reference without accessor', () => {
      const result = parseRef('steps.stepA');
      expect(result).toHaveProperty('code', 'INPUT_REF_PARSE_ERROR');
    });
  });

  describe('security', () => {
    it('rejects __proto__ in path', () => {
      const result = parseRef('state.__proto__.foo');
      expect(result).toHaveProperty('code', 'INPUT_REF_PROTOTYPE_POLLUTION');
    });

    it('rejects constructor in path', () => {
      const result = parseRef('state.constructor.name');
      expect(result).toHaveProperty('code', 'INPUT_REF_PROTOTYPE_POLLUTION');
    });

    it('rejects prototype in path', () => {
      const result = parseRef('state.prototype.foo');
      expect(result).toHaveProperty('code', 'INPUT_REF_PROTOTYPE_POLLUTION');
    });
  });

  describe('edge cases', () => {
    it('rejects empty reference', () => {
      const result = parseRef('');
      expect(result).toHaveProperty('code', 'INPUT_REF_PARSE_ERROR');
    });

    it('rejects unknown source', () => {
      const result = parseRef('unknown.foo');
      expect(result).toHaveProperty('code', 'INPUT_REF_PARSE_ERROR');
    });

    it('trims whitespace', () => {
      const result = parseRef('  state.userId  ');
      expect(result).toEqual({
        raw: 'state.userId',
        source: 'state',
        path: ['userId'],
      });
    });
  });
});

describe('parseValue', () => {
  describe('literals', () => {
    it('returns literal for non-string values', () => {
      expect(parseValue(123)).toEqual({ type: 'literal', value: 123 });
      expect(parseValue(true)).toEqual({ type: 'literal', value: true });
      expect(parseValue(null)).toEqual({ type: 'literal', value: null });
      expect(parseValue({ foo: 'bar' })).toEqual({
        type: 'literal',
        value: { foo: 'bar' },
      });
    });

    it('returns literal for string without refs', () => {
      expect(parseValue('hello world')).toEqual({
        type: 'literal',
        value: 'hello world',
      });
    });
  });

  describe('full replacement', () => {
    it('parses full ref when entire string is one ref', () => {
      const result = parseValue('${state.userId}');
      expect(result).toEqual({
        type: 'full_ref',
        ref: {
          raw: 'state.userId',
          source: 'state',
          path: ['userId'],
        },
      });
    });
  });

  describe('string interpolation', () => {
    it('parses mixed literal and refs', () => {
      const result = parseValue('Hello ${state.name}!');
      expect(result).toHaveProperty('type', 'interpolation');
      if ('parts' in result) {
        expect(result.parts).toHaveLength(3);
        expect(result.parts[0]).toEqual({ type: 'literal', value: 'Hello ' });
        expect(result.parts[1]).toHaveProperty('type', 'ref');
        expect(result.parts[2]).toEqual({ type: 'literal', value: '!' });
      }
    });

    it('parses multiple refs in string', () => {
      const result = parseValue('${state.firstName} ${state.lastName}');
      expect(result).toHaveProperty('type', 'interpolation');
      if ('parts' in result) {
        expect(result.parts).toHaveLength(3);
        expect(result.parts[0]).toHaveProperty('type', 'ref');
        expect(result.parts[1]).toEqual({ type: 'literal', value: ' ' });
        expect(result.parts[2]).toHaveProperty('type', 'ref');
      }
    });
  });
});

describe('hasRefs', () => {
  it('returns true for strings with refs', () => {
    expect(hasRefs('${state.foo}')).toBe(true);
    expect(hasRefs('hello ${state.foo}')).toBe(true);
  });

  it('returns false for strings without refs', () => {
    expect(hasRefs('hello world')).toBe(false);
    expect(hasRefs('$notaref')).toBe(false);
  });

  it('returns false for non-strings', () => {
    expect(hasRefs(123)).toBe(false);
    expect(hasRefs({ foo: '${bar}' })).toBe(false);
  });
});

describe('extractRefs', () => {
  it('extracts refs from full replacement', () => {
    const refs = extractRefs('${state.userId}');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      raw: 'state.userId',
      source: 'state',
      path: ['userId'],
    });
  });

  it('extracts multiple refs from interpolation', () => {
    const refs = extractRefs('${state.a} and ${state.b}');
    expect(refs).toHaveLength(2);
  });

  it('returns empty array for literals', () => {
    expect(extractRefs('hello')).toEqual([]);
    expect(extractRefs(123)).toEqual([]);
  });
});
