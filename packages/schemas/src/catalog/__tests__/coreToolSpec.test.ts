import { describe, expect, it } from 'vitest';
import { buildCoreToolSpec, compactToolDescription } from '../coreToolSpec.js';
import { getAllOperationIds, getOperation } from '../registry.js';

describe('compact core tool specs', () => {
  it('carry the first whenToUse of every operation that declares one', () => {
    const missing: string[] = [];
    for (const id of getAllOperationIds()) {
      const spec = buildCoreToolSpec(id);
      const first = getOperation(id)?.usage.whenToUse[0]?.trim();
      if (!spec || !first) continue;
      if (!spec.description?.includes(`Use when: ${first}`)) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it('fold only the first whenToUse, on one line after the semantic description', () => {
    expect(compactToolDescription('Does a thing.', ['First reason', 'Second reason'])).toBe(
      'Does a thing.\nUse when: First reason',
    );
    expect(compactToolDescription('Does a thing.', [])).toBe('Does a thing.');
  });

  it('steer a change meant to land from host.harness.run to Commission Change', () => {
    expect(buildCoreToolSpec('host.harness.run')?.description).toMatch(
      /Use when: [^\n]*a change meant to land goes through the Commission Change skill/,
    );
  });

  it('show the pinned steering operations when to use them', () => {
    for (const id of ['plan.node.create', 'plan.node.next', 'workflow.run.start']) {
      expect(buildCoreToolSpec(id)?.description, id).toContain('\nUse when: ');
    }
  });
});
