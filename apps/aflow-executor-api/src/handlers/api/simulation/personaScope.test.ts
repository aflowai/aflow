/**
 * Persona ownership is a property of the STORE, and it has two halves.
 *
 * `scopeToPersona` narrows what a run can SEE. `enforcePersonaOwnership`
 * decides what it may WRITE. Reads alone are not isolation: a run that cannot
 * read another persona's rows but can create one still leaks, because the next
 * run acting as that persona reads it as their own data — and nothing in the
 * transcript looks wrong.
 *
 * Both are exercised here as the production functions the store calls, not as
 * a restatement of their logic.
 */
import { describe, expect, it } from 'vitest';
import { entityMatchesQuery } from '@aflow/integration-simulator';
import type { WorldEntity, WorldMutation, WorldReadQuery } from '@aflow/integration-simulator';
import { scopeToPersona, stampOwnership } from './worldStore.js';

/** `purchases` is owned; `merchants` is reference data belonging to nobody. */
const personaFields = new Map([['purchases', 'customerId']]);

const purchases: WorldEntity[] = [
  { id: 'pur_1', body: { purchaseId: 'pur_1', customerId: 'cus_77', amount: 320 } },
  { id: 'pur_2', body: { purchaseId: 'pur_2', customerId: 'cus_99', amount: 90 } },
];

/** What an agent asking for "all purchases" sends: no filter at all. */
const listAll: WorldReadQuery = { collection: 'purchases', match: [] };

function read(query: WorldReadQuery, personaId: string | null): string[] {
  const scoped = scopeToPersona(personaFields, personaId, query);
  if (scoped === null) return [];
  return purchases.filter((row) => entityMatchesQuery(row, scoped)).map((row) => row.id);
}

function write(mutation: WorldMutation, personaId: string | null): WorldMutation[] {
  return stampOwnership(personaFields, personaId, [mutation]);
}

describe('reading an owned collection', () => {
  it('returns only the acting persona’s rows to an unfiltered read', () => {
    expect(read(listAll, 'cus_77')).toEqual(['pur_1']);
  });

  it('cannot be widened by an effect that names another persona', () => {
    const askForSomeoneElse: WorldReadQuery = {
      collection: 'purchases',
      match: [{ path: '/customerId', value: 'cus_99' }],
    };
    expect(read(askForSomeoneElse, 'cus_77')).toEqual([]);
  });

  it('reads empty for a run acting as nobody, which is the unauthenticated caller', () => {
    expect(read(listAll, null)).toEqual([]);
  });

  it('leaves an unscoped collection shared, because reference data belongs to no one', () => {
    const shared: WorldReadQuery = { collection: 'merchants', match: [] };
    expect(scopeToPersona(personaFields, 'cus_77', shared)).toBe(shared);
    expect(scopeToPersona(personaFields, null, shared)).toBe(shared);
  });
});

describe('stamping a write, before its schema is checked', () => {
  it('stamps a create with the acting persona, whatever the request said', () => {
    // The generated rung invents bodies and a declared create can be built
    // `from: '/body'`, so the owner in the payload is the caller's word.
    const [stamped] = write(
      {
        collection: 'purchases',
        op: 'create',
        entityId: 'pur_9',
        body: { purchaseId: 'pur_9', customerId: 'cus_99' },
      },
      'cus_77',
    );
    expect(stamped?.body?.['customerId']).toBe('cus_77');
  });

  it('stamps a create that names no owner at all, which is the point', () => {
    // A scoped collection normally declares its owner field REQUIRED. If the
    // schema were checked before this ran, an effect omitting the field — the
    // faithful thing, since a real client never sends its own id — would be
    // rejected on a field the store was about to fill in.
    const [stamped] = write(
      { collection: 'purchases', op: 'create', entityId: 'pur_9', body: { purchaseId: 'pur_9' } },
      'cus_77',
    );
    expect(stamped?.body).toEqual({ purchaseId: 'pur_9', customerId: 'cus_77' });
  });

  it('refuses every write to an owned collection while acting as nobody', () => {
    // Including a DELETE: a caller with no rows there has nothing to remove,
    // and exempting deletes let a run acting as nobody remove anyone's data.
    for (const op of ['create', 'update', 'delete'] as const) {
      expect(() =>
        write({ collection: 'purchases', op, entityId: 'pur_1', body: {} }, null),
      ).toThrow(/acts as nobody/);
    }
  });

  it('leaves an unscoped collection alone in both directions', () => {
    const mutation: WorldMutation = {
      collection: 'merchants',
      op: 'create',
      entityId: 'mer_1',
      body: { name: 'Lumen' },
    };
    expect(write(mutation, 'cus_77')).toEqual([mutation]);
    expect(write(mutation, null)).toEqual([mutation]);
  });

  it('does not touch an update, which the commit boundary judges instead', () => {
    // Stamping an update would silently move somebody else's row to this
    // caller. Whether the target is theirs at all needs the existing entity,
    // which only `commit` can see.
    const mutation: WorldMutation = {
      collection: 'purchases',
      op: 'update',
      entityId: 'pur_1',
      body: { amount: 400 },
    };
    expect(write(mutation, 'cus_77')).toEqual([mutation]);
  });
});
