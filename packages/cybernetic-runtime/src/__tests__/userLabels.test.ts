import { describe, it, expect } from 'vitest';
import { pickUserLabel, resolveUserLabels } from '../userLabels.js';

describe('pickUserLabel', () => {
  it('prefers displayName, then email, then the raw id', () => {
    expect(pickUserLabel({ id: 'u1', displayName: 'Karim', email: 'k@aflow.ai' })).toBe('Karim');
    expect(pickUserLabel({ id: 'u1', displayName: null, email: 'k@aflow.ai' })).toBe('k@aflow.ai');
    expect(pickUserLabel({ id: 'u1', displayName: '', email: '' })).toBe('u1');
    expect(pickUserLabel({ id: 'u1' })).toBe('u1');
  });
});

describe('resolveUserLabels', () => {
  it('returns an empty map for empty input without touching the database', async () => {
    // Passing a db that would throw if queried proves the short-circuit.
    const db = {
      select() {
        throw new Error('db should not be queried for empty input');
      },
    } as never;
    expect((await resolveUserLabels(db, [])).size).toBe(0);
    expect((await resolveUserLabels(db, ['', '  '.trim()])).size).toBe(0);
  });
});
