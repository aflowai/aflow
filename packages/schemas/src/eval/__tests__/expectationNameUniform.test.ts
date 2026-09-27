import { describe, expect, it } from 'vitest';
import { CaseExpectationSchema } from '../goldenCase.js';
import { toJsonSchemaSync } from '../../utils/jsonSchema.js';

/**
 * A field present on some expectation kinds and absent on others reads as a
 * slip in the author's own output rather than a rule, and an author who met the
 * first kind generalises from it. `name` is a label for a person reading the
 * case; every kind takes one.
 */
describe('every expectation kind takes a name', () => {
  const byKind: Record<string, Record<string, unknown>> = {
    simulation: { check: { op: 'mutated', collection: 'handover_cases', expect: 'none' } },
    reply: { check: { op: 'not_contains', pattern: 'arrives on' } },
    terminal: { runStatus: 'completed' },
    task_status: { taskId: 'answer', status: 'succeeded' },
  };

  for (const [kind, rest] of Object.entries(byKind)) {
    it(`${kind} accepts a name`, () => {
      const res = CaseExpectationSchema.safeParse({ kind, name: 'a label', ...rest });
      if (!res.success) {
        throw new Error(JSON.stringify(res.error.issues.slice(0, 3), null, 2));
      }
      expect(res.success).toBe(true);
    });
  }

  it('offers the label in one place in the schema an author is shown', () => {
    // The author reads the derived JSON Schema, where additionalProperties is
    // closed — a label on both the expectation and its check is two ways to say
    // one thing, and the one they pick is a coin toss.
    const warn = console.warn;
    console.warn = () => {};
    const json = toJsonSchemaSync(CaseExpectationSchema) as Record<string, unknown>;
    console.warn = warn;
    type Branch = { properties?: { kind?: { const?: string }; check?: unknown } };
    const replyBranch = (json['anyOf'] as Branch[]).find(
      (b) => b.properties?.kind?.const === 'reply',
    );
    expect(replyBranch).toBeDefined();
    expect(JSON.stringify(replyBranch?.properties?.check)).not.toContain('"name"');
    // …and the label IS offered on the expectation itself.
    expect(Object.keys((replyBranch as unknown as { properties: object }).properties)).toContain(
      'name',
    );
  });
});
