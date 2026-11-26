import { describe, expect, it } from 'vitest';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import type { WorkflowRunInput, WorkflowTask } from '@aflow/schemas';
import { SKILL_CATALOG } from '../skillCatalog.js';

/**
 * Every date or market state in the catalog that a model or a caller supplies
 * where the exchange clock or calendar could (Plan 346). The list is the open
 * work: a skill that reads its value from the clock leaves it, and a new
 * entry fails here until it is read from the clock or added on purpose. Each
 * entry that stays names why.
 */
const SUPPLIED_CLOCK_VALUES = [
  // An operator may name a past period, so the review takes it from its caller (D5).
  'performance-review clock_value_from_caller read-campaign.periodEnd',
  'performance-review clock_value_from_caller read-campaign.periodStart',
  // A schedule passes { "$now": "date" }, and a cycle that starts the desk passes its clock-derived day.
  'strategy-desk clock_value_from_caller read-campaign.tradingDay',
];

const clockValues = (
  catalogId: string,
  tasks: readonly WorkflowTask[],
  runInputs: readonly WorkflowRunInput[] | undefined,
): string[] => {
  const { validity } = materializeAndValidateSkillConfig({
    tasks: [...tasks],
    ...(runInputs ? { runInputs: [...runInputs] } : {}),
  });
  return validity.advisories
    .filter((d) => d.code.startsWith('clock_value_from_'))
    .map((d) => `${catalogId} ${d.code} ${d.taskId ?? ''}.${d.field ?? ''}`);
};

const cycle = () => {
  const entry = SKILL_CATALOG.find((e) => e.catalogId === 'daily-trading-cycle');
  if (!entry) throw new Error('daily-trading-cycle is not in the catalog');
  return entry.bundle.workflow;
};

describe('dates and market states the catalog takes from a model or a caller', () => {
  it('are the known ones, and no new one', () => {
    const found = SKILL_CATALOG.flatMap((entry) =>
      clockValues(entry.catalogId, entry.bundle.workflow.tasks, entry.bundle.workflow.runInputs),
    ).sort();
    expect(found).toEqual(SUPPLIED_CLOCK_VALUES);
  });

  it('leave the cycle’s trading day alone, because the clock derives it and the contract pins it', () => {
    const resolve = cycle().tasks.find((t) => t.taskId === 'resolve-theses');
    expect(resolve?.dependsOn).toContain('derive-trading-day');
    expect(resolve?.outputContract?.derivedFrom).toContainEqual(
      expect.objectContaining({
        from: 'derive-trading-day',
        binding: 'value:$.tradingDay',
        target: '$.tradingDay.const',
      }),
    );
    const unpinned = cycle().tasks.map((t) =>
      t.taskId === 'resolve-theses'
        ? {
            ...t,
            outputContract: {
              ...t.outputContract,
              derivedFrom: (t.outputContract?.derivedFrom ?? []).filter(
                (b) => b.from !== 'derive-trading-day',
              ),
            },
          }
        : t,
    ) as WorkflowTask[];
    expect(clockValues('daily-trading-cycle', unpinned, cycle().runInputs)).toEqual([
      'daily-trading-cycle clock_value_from_model resolve-theses.tradingDay',
    ]);
  });

  it('flag a market state the cycle would take from its model, as marketIsOpen from resolve-theses', () => {
    const tasks = cycle().tasks.map((t) => {
      if (t.taskId === 'resolve-theses') {
        const schema = t.outputContract?.schema as { properties: Record<string, unknown> };
        return {
          ...t,
          outputContract: {
            ...t.outputContract,
            schema: {
              ...schema,
              properties: { ...schema.properties, marketIsOpen: { type: 'boolean' } },
            },
          },
        };
      }
      const open = t.inputBindings?.['marketIsOpen'];
      if (open?.kind !== 'task_output') return t;
      return {
        ...t,
        inputBindings: {
          ...t.inputBindings,
          marketIsOpen: { ...open, taskId: 'resolve-theses', path: 'marketIsOpen' },
        },
      };
    }) as WorkflowTask[];
    expect(clockValues('daily-trading-cycle', tasks, cycle().runInputs)).toEqual([
      'daily-trading-cycle clock_value_from_model resolve-theses.marketIsOpen',
    ]);
  });

  it('flag a market state a caller must supply, as a required marketIsOpen run input', () => {
    const runInputs = [
      ...(cycle().runInputs ?? []),
      { id: 'marketIsOpen', required: true, schema: { type: 'boolean' } },
    ] as WorkflowRunInput[];
    expect(clockValues('daily-trading-cycle', cycle().tasks, runInputs)).toEqual([
      'daily-trading-cycle clock_value_from_caller ingest-clock.marketIsOpen',
    ]);
  });
});
