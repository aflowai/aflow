import { describe, expect, it } from 'vitest';
import { AppletPatchApplyError } from '../errors.js';
import { applyAppletStatePatch } from '../applyStatePatch.js';

describe('applyAppletStatePatch', () => {
  it('applies /state-rooted ops to the state body without mutating the input', () => {
    const state = { budget: 1, tasks: [{ owner: 'karim' }] };
    const next = applyAppletStatePatch(state, [
      { op: 'replace', path: '/state/budget', value: 2 },
      { op: 'add', path: '/state/tasks/-', value: { owner: 'sara' } },
    ]);
    expect(next).toEqual({ budget: 2, tasks: [{ owner: 'karim' }, { owner: 'sara' }] });
    expect(state).toEqual({ budget: 1, tasks: [{ owner: 'karim' }] });
  });

  it('supports remove, move, copy and passing test ops', () => {
    const next = applyAppletStatePatch({ a: 1, b: 2 }, [
      { op: 'test', path: '/state/a', value: 1 },
      { op: 'move', path: '/state/c', from: '/state/b' },
      { op: 'copy', path: '/state/d', from: '/state/a' },
      { op: 'remove', path: '/state/a' },
    ]);
    expect(next).toEqual({ c: 2, d: 1 });
  });

  it('replaces the whole state via the /state root', () => {
    const next = applyAppletStatePatch({ old: true }, [
      { op: 'replace', path: '/state', value: { fresh: true } },
    ]);
    expect(next).toEqual({ fresh: true });
  });

  it('wraps a failing op with its path', () => {
    try {
      applyAppletStatePatch({}, [
        { op: 'add', path: '/state/ok', value: 1 },
        { op: 'replace', path: '/state/missing/deep', value: 2 },
      ]);
      expect.fail('expected AppletPatchApplyError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppletPatchApplyError);
      expect((err as AppletPatchApplyError).code).toBe('apply_failed');
      expect((err as AppletPatchApplyError).path).toBe('/state/missing/deep');
    }
  });

  it('fails a false test op', () => {
    expect(() =>
      applyAppletStatePatch({ a: 1 }, [{ op: 'test', path: '/state/a', value: 2 }]),
    ).toThrowError(AppletPatchApplyError);
  });

  it('refuses a patch that removes the state subtree', () => {
    try {
      applyAppletStatePatch({ a: 1 }, [{ op: 'remove', path: '/state' }]);
      expect.fail('expected AppletPatchApplyError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppletPatchApplyError);
      expect((err as AppletPatchApplyError).code).toBe('state_shape_lost');
    }
  });

  it('refuses a patch that replaces state with a non-object', () => {
    try {
      applyAppletStatePatch({ a: 1 }, [{ op: 'replace', path: '/state', value: 42 }]);
      expect.fail('expected AppletPatchApplyError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppletPatchApplyError);
      expect((err as AppletPatchApplyError).code).toBe('state_shape_lost');
    }
  });
});
