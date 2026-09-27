import { describe, expect, it } from 'vitest';
import { compactSkipReason } from './workflowRunSurfaceHelpers.js';

describe('compactSkipReason', () => {
  it('strips tasks. prefix and evaluated-to-false suffix', () => {
    expect(
      compactSkipReason(
        "Skipped: tasks.elicit-target.output.scope == 'store_install' evaluated to false",
      ),
    ).toBe("elicit-target.output.scope == 'store_install'");
  });

  it('compacts anyOf ledger reasons', () => {
    expect(
      compactSkipReason(
        "anyOf [tasks.a.status == 'succeeded'; tasks.b.status == 'succeeded'] evaluated to false",
      ),
    ).toBe("a.status == 'succeeded' or b.status == 'succeeded'");
  });
});
