import { describe, expect, it } from 'vitest';
import * as publicSchema from '../schema/public.js';
import {
  derivePayloadRefColumns,
  deriveSessionReferenceColumns,
  PAYLOAD_REF_POLICY,
  SESSION_REFERENCE_POLICY,
  type DerivedSessionColumn,
} from './sessionReferencePolicy.js';

/**
 * The guard that makes the session-granular purge a standing property rather
 * than a point-in-time sweep: the column universe comes from the drizzle
 * schema at runtime, so a newly added session reference fails the build
 * instead of silently surviving a retention purge.
 */
function allDerivedColumns(): DerivedSessionColumn[] {
  return [
    ...deriveSessionReferenceColumns(),
    ...deriveSessionReferenceColumns(publicSchema as unknown as Record<string, unknown>),
  ];
}

describe('session cascade — session-reference policy', () => {
  it('assigns a policy to every session-referencing column the schema declares', () => {
    const unclassified = allDerivedColumns()
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !(key in SESSION_REFERENCE_POLICY));

    expect(
      [...new Set(unclassified)].sort(),
      'A column that can hold a session id has no purge policy. Classify it in ' +
        'sessionReferencePolicy.ts: `cascade` when the row exists because of the session ' +
        '(cascadeDeleteSession must then delete it — add the delete there too), or ' +
        '`preserve` with a reason when the row belongs to a record that outlives the ' +
        'session and the id is only a pointer. If the column holds an id from a ' +
        'different domain (workflow-run or eval-run business keys), add it to ' +
        'NOT_A_SESSION_REFERENCE.',
    ).toEqual([]);
  });

  it('has no stale policy entries for columns the schema no longer declares', () => {
    const derived = new Set(allDerivedColumns().map((c) => `${c.table}.${c.column}`));
    const stale = Object.keys(SESSION_REFERENCE_POLICY).filter((key) => !derived.has(key));

    expect(
      stale.sort(),
      'A policy entry points at a column the drizzle schema no longer declares — ' +
        'remove it from SESSION_REFERENCE_POLICY (and its delete from ' +
        'cascadeDeleteSession if it was `cascade`).',
    ).toEqual([]);
  });

  it('gives every preserved column a reason', () => {
    const missing = Object.entries(SESSION_REFERENCE_POLICY)
      .filter(([, policy]) => policy.kind === 'preserve' && policy.reason.trim().length === 0)
      .map(([key]) => key);

    expect(missing.sort(), 'A `preserve` classification must say why the row survives.').toEqual(
      [],
    );
  });
});

describe('session cascade — payload-ref policy', () => {
  function allDerivedRefColumns(): DerivedSessionColumn[] {
    return [
      ...derivePayloadRefColumns(),
      ...derivePayloadRefColumns(publicSchema as unknown as Record<string, unknown>),
    ];
  }

  it('assigns a policy to every ref column on the tables the cascade deletes from', () => {
    const unclassified = allDerivedRefColumns()
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !(key in PAYLOAD_REF_POLICY));

    expect(
      [...new Set(unclassified)].sort(),
      'A `*_ref` column on a cascade-deleted table has no payload policy. Classify it in ' +
        'sessionReferencePolicy.ts: `collected` when the column can hold a payload-store ' +
        'ref (collectSessionPayloadRefs must then select it, scoped the same way as the ' +
        "cascade's delete — add the query there too), or `not_payload` with a reason when " +
        'it holds something other than a payload-store object.',
    ).toEqual([]);
  });

  it('has no stale policy entries for ref columns the schema no longer declares', () => {
    const derived = new Set(allDerivedRefColumns().map((c) => `${c.table}.${c.column}`));
    const stale = Object.keys(PAYLOAD_REF_POLICY).filter((key) => !derived.has(key));

    expect(
      stale.sort(),
      'A payload policy entry points at a ref column the drizzle schema no longer declares — ' +
        'remove it from PAYLOAD_REF_POLICY (and its query from collectSessionPayloadRefs ' +
        'if it was `collected`).',
    ).toEqual([]);
  });

  it('gives every not_payload column a reason', () => {
    const missing = Object.entries(PAYLOAD_REF_POLICY)
      .filter(([, policy]) => policy.kind === 'not_payload' && policy.reason.trim().length === 0)
      .map(([key]) => key);

    expect(
      missing.sort(),
      'A `not_payload` classification must say what the column holds instead.',
    ).toEqual([]);
  });
});
