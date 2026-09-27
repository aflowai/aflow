import { describe, expect, it } from 'vitest';
import * as publicSchema from '../schema/public.js';
import {
  deriveUserReferenceColumns,
  USER_REFERENCE_POLICY,
  type DerivedUserColumn,
} from './userReferencePolicy.js';

/**
 * The guard that makes account erasure a standing property rather than a
 * point-in-time sweep: the column universe comes from the drizzle schema at
 * runtime, so a newly added user reference fails the build instead of silently
 * surviving a GDPR Art. 17 erasure.
 */
function allDerivedColumns(): DerivedUserColumn[] {
  return [
    ...deriveUserReferenceColumns(),
    ...deriveUserReferenceColumns(publicSchema as unknown as Record<string, unknown>),
  ];
}

describe('account cascade — user-reference policy', () => {
  it('assigns a policy to every user-referencing column the schema declares', () => {
    const unclassified = allDerivedColumns()
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !(key in USER_REFERENCE_POLICY));

    expect(
      [...new Set(unclassified)].sort(),
      'A column that can hold a user id has no erasure policy. Classify it in ' +
        'userReferencePolicy.ts: `scoped` when the column narrows a row to that user ' +
        '(the row must be DELETED — NULLing would widen a private row to space-wide ' +
        'visibility), `provenance` when it only records authorship on a nullable column, ' +
        '`reassign` when it records authorship but is NOT NULL, `jsonb-actor` when the id ' +
        'is inside a JSON document, or `global` when the public-schema phase handles it. ' +
        'If it never holds a user id, add it to NOT_A_USER_REFERENCE.',
    ).toEqual([]);
  });

  it('never marks a NOT NULL column as `provenance`', () => {
    // `provenance` issues `SET <col> = NULL`; on a NOT NULL column that raises
    // 23502 and rolls back the whole erasure, so the policy must be `reassign`.
    const wrong = allDerivedColumns()
      .filter((c) => c.notNull)
      .filter((c) => USER_REFERENCE_POLICY[`${c.table}.${c.column}`]?.kind === 'provenance')
      .map((c) => `${c.table}.${c.column}`);

    expect(wrong.sort(), 'NOT NULL columns cannot be NULLed — use `reassign`.').toEqual([]);
  });

  it('never marks a nullable column as `reassign`', () => {
    const wrong = allDerivedColumns()
      .filter((c) => !c.notNull)
      .filter((c) => USER_REFERENCE_POLICY[`${c.table}.${c.column}`]?.kind === 'reassign')
      .map((c) => `${c.table}.${c.column}`);

    expect(
      wrong.sort(),
      'A nullable authorship column should be `provenance` so no identifier survives.',
    ).toEqual([]);
  });
});
