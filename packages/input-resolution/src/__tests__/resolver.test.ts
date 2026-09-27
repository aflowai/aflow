import { describe, it, expect } from 'vitest';
import { resolveRef, resolveValue, resolveTemplateObject, InputResolver } from '../resolver.js';
import type { ResolutionContext, ParsedRef } from '../types.js';

const mockContext: ResolutionContext = {
  state: {
    userId: 'user-123',
    count: 42,
    nested: {
      value: 'deep',
    },
    user: {
      name: 'Alice',
      profile: {
        age: 30,
      },
    },
  },
  steps: {
    stepA: {
      output: {
        result: 'success',
        data: { foo: 'bar' },
      },
    },
    stepB: {
      error: {
        code: 'ERROR_CODE',
        message: 'Something went wrong',
      },
    },
  },
  metadata: {
    runId: 'run-123',
    stepExecutionId: 'step-456',
    attempt: 1,
    createdAtMs: Date.now(),
    schemaVersion: 1,
  },
};

describe('resolveRef', () => {
  describe('state references', () => {
    it('resolves simple state reference', () => {
      const ref: ParsedRef = {
        raw: 'state.userId',
        source: 'state',
        path: ['userId'],
      };
      const result = resolveRef(ref, mockContext);
      expect(result).toEqual({ success: true, value: 'user-123' });
    });

    it('resolves nested state reference', () => {
      const ref: ParsedRef = {
        raw: 'state.user.profile.age',
        source: 'state',
        path: ['user', 'profile', 'age'],
      };
      const result = resolveRef(ref, mockContext);
      expect(result).toEqual({ success: true, value: 30 });
    });

    it('returns error for missing state variable', () => {
      const ref: ParsedRef = {
        raw: 'state.nonexistent',
        source: 'state',
        path: ['nonexistent'],
      };
      const result = resolveRef(ref, mockContext);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INPUT_REF_NOT_FOUND');
      }
    });
  });

  describe('step references', () => {
    it('resolves step output reference', () => {
      const ref: ParsedRef = {
        raw: 'steps.stepA.output.result',
        source: 'steps',
        path: ['result'],
        stepId: 'stepA' as import('@aflow/schemas').StepId,
        accessor: 'output',
      };
      const result = resolveRef(ref, mockContext);
      expect(result).toEqual({ success: true, value: 'success' });
    });

    it('resolves step error reference', () => {
      const ref: ParsedRef = {
        raw: 'steps.stepB.error.code',
        source: 'steps',
        path: ['code'],
        stepId: 'stepB' as import('@aflow/schemas').StepId,
        accessor: 'error',
      };
      const result = resolveRef(ref, mockContext);
      expect(result).toEqual({ success: true, value: 'ERROR_CODE' });
    });

    it('resolves entire step output', () => {
      const ref: ParsedRef = {
        raw: 'steps.stepA.output',
        source: 'steps',
        path: [],
        stepId: 'stepA' as import('@aflow/schemas').StepId,
        accessor: 'output',
      };
      const result = resolveRef(ref, mockContext);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({
          result: 'success',
          data: { foo: 'bar' },
        });
      }
    });

    it('returns error for missing step', () => {
      const ref: ParsedRef = {
        raw: 'steps.nonexistent.output.foo',
        source: 'steps',
        path: ['foo'],
        stepId: 'nonexistent' as import('@aflow/schemas').StepId,
        accessor: 'output',
      };
      const result = resolveRef(ref, mockContext);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INPUT_REF_NOT_FOUND');
      }
    });
  });
});

describe('resolveValue', () => {
  const config = {
    maxDepth: 10,
    maxRefs: 100,
    maxStringLength: 1_000_000,
  };

  it('resolves full replacement preserving type', () => {
    const result = resolveValue('${state.count}', mockContext, config);
    expect(result).toEqual({ success: true, value: 42 });
  });

  it('resolves string interpolation', () => {
    const result = resolveValue(
      'User ${state.userId} has count ${state.count}',
      mockContext,
      config,
    );
    expect(result).toEqual({
      success: true,
      value: 'User user-123 has count 42',
    });
  });

  it('passes through literals', () => {
    const result = resolveValue('plain string', mockContext, config);
    expect(result).toEqual({ success: true, value: 'plain string' });
  });

  it('passes through non-strings', () => {
    const result = resolveValue(123, mockContext, config);
    expect(result).toEqual({ success: true, value: 123 });
  });
});

describe('resolveTemplateObject', () => {
  it('resolves nested object with refs', () => {
    const template = {
      userId: '${state.userId}',
      stepResult: '${steps.stepA.output.result}',
      literal: 'plain',
    };

    const result = resolveTemplateObject(template, mockContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({
        userId: 'user-123',
        stepResult: 'success',
        literal: 'plain',
      });
    }
  });

  it('resolves arrays with refs', () => {
    const template = ['${state.userId}', '${state.count}', 'literal'];

    const result = resolveTemplateObject(template, mockContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual(['user-123', 42, 'literal']);
    }
  });

  it('respects depth limit', () => {
    const template = {
      a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: '${state.userId}' } } } } } } } } } },
    };

    const result = resolveTemplateObject(template, mockContext, {
      maxDepth: 5,
      maxRefs: 100,
      maxStringLength: 1_000_000,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INPUT_REF_DEPTH_EXCEEDED');
    }
  });
});

describe('InputResolver class', () => {
  it('provides stateful resolution', () => {
    const resolver = new InputResolver(mockContext);

    const result1 = resolver.resolve('${state.userId}');
    expect(result1.success).toBe(true);
    if (result1.success) {
      expect(result1.value).toBe('user-123');
    }

    const result2 = resolver.resolve({
      greeting: 'Hello ${state.user.name}!',
    });
    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.value).toEqual({
        greeting: 'Hello Alice!',
      });
    }
  });
});
