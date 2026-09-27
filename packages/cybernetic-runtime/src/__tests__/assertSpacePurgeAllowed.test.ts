import { describe, expect, it } from 'vitest';

import {
  assertSpacePurgeAllowed,
  SpaceLifecycleError,
  type SpaceLifecycleErrorCode,
} from '../spaceLifecycle.js';

const ARCHIVED = new Date('2026-06-01T00:00:00.000Z');

function expectRefusal(fn: () => void, code: SpaceLifecycleErrorCode): SpaceLifecycleError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SpaceLifecycleError);
    expect((err as SpaceLifecycleError).code).toBe(code);
    return err as SpaceLifecycleError;
  }
  throw new Error(`expected a SpaceLifecycleError(${code}) but none was thrown`);
}

describe('assertSpacePurgeAllowed', () => {
  it('refuses the General space regardless of archive/name state', () => {
    expectRefusal(
      () =>
        assertSpacePurgeAllowed(
          { slug: 'general', name: 'General', archived_at: ARCHIVED },
          { confirmName: 'General' },
        ),
      'SPACE_GENERAL_PROTECTED',
    );
  });

  it('checks General protection before archive-first (active General still refuses as General)', () => {
    // archived_at null AND slug general — General protection must win.
    expectRefusal(
      () =>
        assertSpacePurgeAllowed(
          { slug: 'general', name: 'General', archived_at: null },
          { confirmName: 'General' },
        ),
      'SPACE_GENERAL_PROTECTED',
    );
  });

  it('refuses an active (non-archived) space — archive is required first', () => {
    expectRefusal(
      () =>
        assertSpacePurgeAllowed(
          { slug: 'shop', name: 'Shop', archived_at: null },
          { confirmName: 'Shop' },
        ),
      'SPACE_NOT_ARCHIVED',
    );
  });

  it('refuses when the confirmation name does not match, surfacing the expected name', () => {
    const err = expectRefusal(
      () =>
        assertSpacePurgeAllowed(
          { slug: 'shop', name: 'Shop', archived_at: ARCHIVED },
          { confirmName: 'shop' },
        ),
      'SPACE_NAME_MISMATCH',
    );
    expect(err.details).toEqual({ expected: 'Shop' });
  });

  it('passes when archived, non-General, and the name matches exactly', () => {
    expect(() =>
      assertSpacePurgeAllowed(
        { slug: 'shop', name: 'Shop', archived_at: ARCHIVED },
        { confirmName: 'Shop' },
      ),
    ).not.toThrow();
  });
});
