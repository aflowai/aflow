import { describe, it, expect } from 'vitest';
import { EntityDirectivesSchema } from '@aflow/schemas';

import { withHelmsmanOperations } from './HelmsmanDiscoveryEditor.js';

const base = () =>
  EntityDirectivesSchema.parse({
    version: 1,
    responsibility: 'Run the space.',
    priorities: ['ship'],
  });

describe('withHelmsmanOperations', () => {
  it('reset removes the key rather than writing an empty list', () => {
    const custom = withHelmsmanOperations(base(), ['memory.store.get']);
    const reset = withHelmsmanOperations(custom, undefined);

    expect('helmsmanOperations' in reset.capabilityDiscovery).toBe(false);
    // The wire form is what the orchestrator reads: absent = platform preset.
    expect(JSON.parse(JSON.stringify(reset)).capabilityDiscovery).toEqual({});
  });

  it('keeps an empty list as an explicit value — it is discovery off, not a reset', () => {
    const off = withHelmsmanOperations(base(), []);

    expect(off.capabilityDiscovery.helmsmanOperations).toEqual([]);
    expect(JSON.parse(JSON.stringify(off)).capabilityDiscovery).toEqual({
      helmsmanOperations: [],
    });
  });

  it('leaves every other directive subtree untouched', () => {
    const before = base();
    const after = withHelmsmanOperations(before, ['workflow.manage.list']);

    expect(after.responsibility).toBe(before.responsibility);
    expect(after.priorities).toEqual(before.priorities);
    expect(after.modelDefaults).toEqual(before.modelDefaults);
    expect(after.learningPolicy).toEqual(before.learningPolicy);
    expect(before.capabilityDiscovery.helmsmanOperations).toBeUndefined();
  });

  it('produces a value the directives schema accepts', () => {
    const next = withHelmsmanOperations(base(), ['memory.store.query', 'workflow.run.start']);

    expect(EntityDirectivesSchema.safeParse(next).success).toBe(true);
  });
});
