import { resolveAppletLimits, type AppletStatePatchOp } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';
import { AppletPatchBoundsError } from '../errors.js';
import { boundAppletStatePatch } from '../patchBounds.js';

function replaceOp(path: string, value: unknown): AppletStatePatchOp {
  return { op: 'replace', path, value };
}

function expectBoundsError(fn: () => void, code: AppletPatchBoundsError['code']): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppletPatchBoundsError);
    expect((err as AppletPatchBoundsError).code).toBe(code);
    return;
  }
  expect.fail(`expected AppletPatchBoundsError '${code}'`);
}

describe('boundAppletStatePatch', () => {
  it('accepts a bounded /state patch, including the /state root', () => {
    expect(() =>
      boundAppletStatePatch([
        replaceOp('/state/budget', 40000),
        { op: 'move', path: '/state/a', from: '/state/b' },
        { op: 'remove', path: '/state/old' },
        replaceOp('/state', { fresh: true }),
      ]),
    ).not.toThrow();
  });

  it('refuses an empty patch', () => {
    expectBoundsError(() => boundAppletStatePatch([]), 'patch_empty');
  });

  it('refuses more ops than the limit', () => {
    const limits = { ...resolveAppletLimits(), maxPatchOps: 2 };
    const patch = [replaceOp('/state/a', 1), replaceOp('/state/b', 2), replaceOp('/state/c', 3)];
    expectBoundsError(() => boundAppletStatePatch(patch, limits), 'patch_too_many_ops');
  });

  it('refuses paths outside /state', () => {
    expectBoundsError(
      () => boundAppletStatePatch([replaceOp('/meta/x', 1)]),
      'patch_outside_state',
    );
    expectBoundsError(() => boundAppletStatePatch([replaceOp('', 1)]), 'patch_outside_state');
    expectBoundsError(
      () => boundAppletStatePatch([replaceOp('/statement', 1)]),
      'patch_outside_state',
    );
  });

  it('refuses a from pointer outside /state and reports the op index', () => {
    try {
      boundAppletStatePatch([
        replaceOp('/state/a', 1),
        { op: 'copy', path: '/state/b', from: '/meta/secret' },
      ]);
      expect.fail('expected AppletPatchBoundsError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppletPatchBoundsError);
      expect((err as AppletPatchBoundsError).code).toBe('patch_outside_state');
      expect((err as AppletPatchBoundsError).opIndex).toBe(1);
      expect((err as AppletPatchBoundsError).path).toBe('/meta/secret');
    }
  });

  it('refuses an oversized pointer', () => {
    const path = `/state/${'a'.repeat(600)}`;
    expectBoundsError(() => boundAppletStatePatch([replaceOp(path, 1)]), 'pointer_too_long');
  });

  it('bounds value depth', () => {
    const limits = { ...resolveAppletLimits(), maxJsonDepth: 3 };
    const atLimit = { a: { b: { c: 1 } } };
    const beyond = { a: { b: { c: { d: 1 } } } };
    expect(() => boundAppletStatePatch([replaceOp('/state/x', atLimit)], limits)).not.toThrow();
    expectBoundsError(
      () => boundAppletStatePatch([replaceOp('/state/x', beyond)], limits),
      'patch_value_too_deep',
    );
  });

  it('bounds serialized patch size', () => {
    const limits = { ...resolveAppletLimits(), maxStateBytes: 64 };
    expectBoundsError(
      () => boundAppletStatePatch([replaceOp('/state/x', 'y'.repeat(200))], limits),
      'patch_too_large',
    );
  });
});
