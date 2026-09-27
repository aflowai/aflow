import { describe, expect, it } from 'vitest';
import { checkAppletConformance, extractAppletActCallSites } from '@aflow/applet-runtime';
import { WORK_BOARD_DEFINITION, WORK_BOARD_VIEW_SOURCE } from '@aflow/platform-artifacts';

describe('work-board fixture conformance', () => {
  it('passes the conformance gate clean', () => {
    const result = checkAppletConformance({
      definition: WORK_BOARD_DEFINITION,
      source: WORK_BOARD_VIEW_SOURCE,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('sees every declared action as a literal call site through the view wrapper', () => {
    const literalNames = new Set(
      extractAppletActCallSites(WORK_BOARD_VIEW_SOURCE)
        .map((site) => site.name)
        .filter((name): name is string => name !== null),
    );
    for (const action of WORK_BOARD_DEFINITION.actions) {
      expect(literalNames.has(action.name)).toBe(true);
    }
  });
});
