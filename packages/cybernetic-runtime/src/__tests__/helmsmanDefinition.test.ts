import { describe, expect, it } from 'vitest';

import { isCyberneticHelmsman, isHelmsmanDefinition } from '../agentTurnIntegration.js';

const helmsman = { system: true, tags: ['cybernetic', 'helmsman'] };

describe('isHelmsmanDefinition', () => {
  it('recognises the Helmsman from its definition alone, with or without space directives', () => {
    expect(isHelmsmanDefinition(helmsman)).toBe(true);
    expect(isCyberneticHelmsman(helmsman, null)).toBe(false);
    expect(isCyberneticHelmsman(helmsman, {})).toBe(true);
  });

  it('refuses a non-system agent or one without the role tags', () => {
    expect(isHelmsmanDefinition({ system: false, tags: ['cybernetic', 'helmsman'] })).toBe(false);
    expect(isHelmsmanDefinition({ system: true, tags: ['cybernetic', 'runner'] })).toBe(false);
    expect(isHelmsmanDefinition(undefined)).toBe(false);
  });
});
