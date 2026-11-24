import { describe, expect, it } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import { SKILL_CATALOG } from '../skillCatalog.js';

/**
 * Every date in the catalog that a model or a caller supplies where the
 * exchange clock or calendar could (Plan 346). The list is the open work:
 * a skill that reads its date from the clock leaves it, and a new entry fails
 * here until it is read from the clock or added on purpose.
 */
const SUPPLIED_DATES = [
  'daily-trading-cycle clock_value_from_model resolve-theses.tradingDay',
  'performance-review clock_value_from_caller read-campaign.periodEnd',
  'performance-review clock_value_from_caller read-campaign.periodStart',
  'strategy-desk clock_value_from_caller read-campaign.tradingDay',
];

describe('dates the catalog takes from a model or a caller', () => {
  it('are the known ones, and no new one', () => {
    const found = SKILL_CATALOG.flatMap((entry) => {
      const wf = entry.bundle.workflow;
      const { validity } = materializeAndValidateSkillConfig({
        tasks: wf.tasks,
        runInputs: wf.runInputs,
      });
      return validity.advisories
        .filter((d) => d.code.startsWith('clock_value_from_'))
        .map((d) => `${entry.catalogId} ${d.code} ${d.taskId ?? ''}.${d.field ?? ''}`);
    }).sort();
    expect(found).toEqual(SUPPLIED_DATES);
  });
});
