/**
 * Proposal op diff: the operator card must show
 * before→after, not new-values-only.
 */
import { describe, expect, it } from 'vitest';
import { buildProposalOpDiffs } from '../proposalOpDiff.js';

const workflow = {
  tasks: [
    {
      taskId: 'render-card',
      type: 'operation',
      operation: 'ui.artifact.render',
      goal: 'Render the bundle-shipped card.',
      dependsOn: ['synthesize-briefing'],
    },
  ],
  // Real OutcomeSchema shape: the threshold lives on the evaluator.
  outcomes: [
    {
      id: 'briefing-written',
      name: 'Briefing written',
      evaluator: { type: 'threshold', metric: 'goalScore', operator: 'gte', target: 0.8 },
    },
  ],
  iteration: { maxConsecutiveRuns: 3 },
  activation: { triggerPatterns: [], activationHint: 'Run each morning.' },
} as never;

describe('buildProposalOpDiffs', () => {
  it('update_task_goal carries the current goal as before', () => {
    const diffs = buildProposalOpDiffs(workflow, [
      { op: 'update_task_goal', taskId: 'render-card', newGoal: 'Render with cardData.' },
    ] as never);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.entries[0]).toMatchObject({
      field: 'goal',
      before: 'Render the bundle-shipped card.',
      after: 'Render with cardData.',
    });
  });

  it('threshold + activation-hint + iteration befores resolve from the workflow', () => {
    const diffs = buildProposalOpDiffs(workflow, [
      { op: 'update_outcome_threshold', outcomeId: 'briefing-written', newTarget: 0.9 },
      { op: 'update_activation_hint', newHint: 'Run at open.' },
      { op: 'update_iteration_policy', maxConsecutiveRuns: 5 },
    ] as never);
    expect(diffs[0]?.entries[0]).toMatchObject({ before: '0.8', after: '0.9' });
    expect(diffs[1]?.entries[0]).toMatchObject({
      before: 'Run each morning.',
      after: 'Run at open.',
    });
    expect(diffs[2]?.entries[0]).toMatchObject({
      field: 'maxConsecutiveRuns',
      before: '3',
      after: '5',
    });
  });

  it('update_task_dependencies shows current vs proposed dependsOn', () => {
    const diffs = buildProposalOpDiffs(workflow, [
      { op: 'update_task_dependencies', taskId: 'render-card', dependsOn: ['hydrate-state'] },
    ] as never);
    expect(diffs[0]?.entries[0]).toMatchObject({
      field: 'dependsOn',
      before: '["synthesize-briefing"]',
      after: '["hydrate-state"]',
    });
  });

  it('null workflow degrades to after-only; unknown ops omitted', () => {
    const diffs = buildProposalOpDiffs(null, [
      { op: 'update_task_goal', taskId: 'x', newGoal: 'New.' },
      { op: 'platform_issue', subject: 'runtime' },
    ] as never);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.entries[0]?.before).toBeUndefined();
    expect(diffs[0]?.entries[0]?.after).toBe('New.');
  });

  const manifest = {
    goal: { type: 'subjective', rubric: ['Old rubric'] },
    campaign: {
      fields: {
        targetScore: { schema: { type: 'number' }, label: 'Target score' },
      },
    },
  } as never;

  it('update_goal carries the manifest goal as before', () => {
    const diffs = buildProposalOpDiffs(
      null,
      [
        { op: 'update_goal', goal: { type: 'subjective', rubric: ['New rubric'] }, rationale: 'x' },
      ] as never,
      manifest,
    );
    expect(diffs[0]?.entries[0]?.field).toBe('goal');
    expect(diffs[0]?.entries[0]?.before).toContain('Old rubric');
    expect(diffs[0]?.entries[0]?.after).toContain('New rubric');
  });

  it('campaign.field.update carries the current field as before; add has no before', () => {
    const updateDiffs = buildProposalOpDiffs(
      null,
      [
        {
          op: 'campaign.field.update',
          fieldKey: 'targetScore',
          field: { schema: { type: 'integer' }, label: 'Target' },
          rationale: 'x',
        },
      ] as never,
      manifest,
    );
    expect(updateDiffs[0]?.entries[0]?.field).toBe('campaign field targetScore');
    expect(updateDiffs[0]?.entries[0]?.before).toContain('number');
    expect(updateDiffs[0]?.entries[0]?.after).toContain('integer');

    const addDiffs = buildProposalOpDiffs(
      null,
      [
        {
          op: 'campaign.field.add',
          fieldKey: 'brandNew',
          field: { schema: { type: 'string' }, label: 'Brand new' },
          rationale: 'x',
        },
      ] as never,
      manifest,
    );
    expect(addDiffs[0]?.entries[0]?.before).toBeUndefined();
    expect(addDiffs[0]?.entries[0]?.after).toContain('Brand new');
  });
});
