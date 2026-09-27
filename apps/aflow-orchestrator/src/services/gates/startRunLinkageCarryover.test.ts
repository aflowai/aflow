import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SessionHotStateSchema } from '@aflow/redis';

const startRunSource = readFileSync(
  fileURLToPath(new URL('../SessionOrchestrator/lifecycle/startRun.ts', import.meta.url)),
  'utf8',
);

/**
 * Starting a run writes its session literal through atomicCreateSession, which
 * DELs the hash first — every field is re-listed by hand, so a linkage field
 * added to the schema does not join the list on its own. The loss is silent:
 * the child runs, finishes, and nothing can route its completion home, because
 * the record of who was waiting was destroyed at start.
 */
describe('startRun linkage carryover', () => {
  const linkageFields = Object.keys(SessionHotStateSchema.shape).filter((key) =>
    key.startsWith('parent'),
  );

  it('declares linkage fields to guard', () => {
    expect(linkageFields.length).toBeGreaterThan(0);
  });

  it.each(linkageFields)('carries %s forward from the existing run', (field) => {
    const carried = startRunSource.split(`existingRun?.${field}`).length - 1;
    expect(
      carried,
      `startRun.ts must carry '${field}' forward at every literal that re-creates session ` +
        `state. Add '...(existingRun?.${field} ? { ${field}: existingRun.${field} } : {})' ` +
        `alongside the other parent* fields.`,
    ).toBeGreaterThanOrEqual(2);
  });
});
