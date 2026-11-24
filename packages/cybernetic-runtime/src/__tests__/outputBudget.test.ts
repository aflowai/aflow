import { describe, expect, it } from 'vitest';
import type { SkillCampaignContract, WorkflowTask } from '@aflow/schemas';
import {
  agentOutputBudgets,
  estimatePinnedOutputTokens,
  outputBudgetDiagnostics,
} from '../scheduling/outputBudget.js';
import { materializeAndValidateSkillConfig } from '../skillValidity/skillValidity.js';

const bar = {
  type: 'object',
  required: ['t', 'c'],
  properties: { t: { type: 'string', minLength: 10 }, c: { type: 'number' } },
};

/** An agent asked to copy every member's closes: the shape that ran out of output. */
const copier = (extra: Partial<WorkflowTask> = {}): WorkflowTask =>
  ({
    taskId: 'copy-closes',
    name: 'Copy closes',
    goal: 'Copy the closes.',
    type: 'agent',
    outputContract: {
      schema: {
        type: 'object',
        required: ['members'],
        properties: {
          members: {
            type: 'array',
            items: {
              type: 'object',
              required: ['symbol', 'closes'],
              properties: {
                symbol: { type: 'string' },
                closes: { type: 'array', minItems: 20, maxItems: 20, items: bar },
              },
            },
          },
        },
      },
      derivedFrom: [
        {
          bindingId: 'member-floor',
          from: '$campaign',
          binding: 'count:$.universe',
          target: '$.members.minItems',
        },
      ],
    },
    ...extra,
  }) as WorkflowTask;

const contract = (maxItems: number): SkillCampaignContract =>
  ({
    fields: {
      universe: { schema: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems } },
    },
  }) as unknown as SkillCampaignContract;

describe('the static output-budget estimate', () => {
  it('counts a count-bound array at the campaign field’s ceiling', () => {
    const estimate = estimatePinnedOutputTokens(copier(), [copier()], contract(30))!;
    expect(estimate.scaled).toEqual([
      { path: '$.members', count: 30, source: '$campaign.universe' },
    ]);
    const small = estimatePinnedOutputTokens(copier(), [copier()], contract(3))!;
    expect(estimate.tokens).toBeGreaterThan(small.tokens * 9);
  });

  it('without a declared ceiling the array counts at its own minItems', () => {
    expect(estimatePinnedOutputTokens(copier(), [copier()])!.scaled).toEqual([]);
  });

  it('asks nothing of an operation task, or of an agent that pins no output', () => {
    const op = { ...copier(), type: 'operation', operation: 'memory.store.get' } as WorkflowTask;
    expect(estimatePinnedOutputTokens(op, [op])).toBeNull();
    const open = { ...copier(), outputContract: undefined } as WorkflowTask;
    expect(estimatePinnedOutputTokens(open, [open])).toBeNull();
  });

  it('flags the copier at a 30-member universe, and not at three', () => {
    const wide = outputBudgetDiagnostics([copier()], contract(30));
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatchObject({ code: 'output_budget_exceeded', taskId: 'copy-closes' });
    expect(wide[0]!.detail).toContain('$.members at 30 items, from $campaign.universe');
    expect(outputBudgetDiagnostics([copier()], contract(3))).toEqual([]);
  });

  it('is an error where no model a space may assign has the budget, and on a pinned model', () => {
    const largest = Math.max(...agentOutputBudgets().map((b) => b.maxOutputTokens));
    const smallest = Math.min(...agentOutputBudgets().map((b) => b.maxOutputTokens));
    expect(smallest).toBeLessThan(largest);
    // 30 members of 20 closes fit some recommended budgets and not the smallest.
    expect(outputBudgetDiagnostics([copier()], contract(30))[0]!.severity).toBe('advisory');
    const pinned = copier({ model: 'claude-haiku-4-5' });
    expect(outputBudgetDiagnostics([pinned], contract(30))[0]!.severity).toBe('error');
  });

  it('runs inside skill validity, reading the campaign contract at authoring time', () => {
    const { validity } = materializeAndValidateSkillConfig({
      tasks: [copier()],
      campaign: { contract: contract(30) },
    });
    expect(validity.advisories.map((d) => d.code)).toContain('output_budget_exceeded');
  });
});
