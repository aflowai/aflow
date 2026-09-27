/**
 * Guard: the simulated-fulfillment read filters on the index's own predicate.
 *
 * Postgres only matches a partial index when the query's WHERE clause is the
 * same expression the index was built with. Rewriting the filter — inlining the
 * JSON path, reaching for drizzle's jsonb operators, "tidying" the raw SQL —
 * leaves a query that still returns the right bindings while scanning the
 * session's whole history to find them. Nothing fails; the mount just goes back
 * to costing what this index was added to stop it costing.
 *
 * So the reader must take both expressions from the index definition rather
 * than spell either one itself.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import { SIMULATED_BINDING_EXPRESSION, SIMULATED_EVENT_PREDICATE } from '@aflow/database';

const readerPath = join(dirname(fileURLToPath(import.meta.url)), 'readSimulatedBindings.ts');

describe('simulated bindings read (partial-index match guard)', () => {
  it('takes both expressions from the index definition', async () => {
    const src = await readFile(readerPath, 'utf-8');
    expect(src).toContain('SIMULATED_EVENT_PREDICATE');
    expect(src).toContain('SIMULATED_BINDING_EXPRESSION');
  });

  it('spells neither of them itself', async () => {
    const src = await readFile(readerPath, 'utf-8');
    expect(src).not.toMatch(/'simulated'/);
    expect(src).not.toMatch(/'simulatedBindingId'/);
  });

  it('carries the binding id, so the read is answered without the heap', () => {
    expect(SIMULATED_BINDING_EXPRESSION).toContain('simulatedBindingId');
    expect(SIMULATED_EVENT_PREDICATE).toContain('simulated');
  });
});
