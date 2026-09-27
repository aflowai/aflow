import { describe, expect, it } from 'vitest';
import type { CyberneticEvalSuite } from '@aflow/schemas';
import { judgeSelectionKey, selectJudgeCriteria } from '../evalRunnerJudgeSelection.js';

function suite(judgeSamplingRate?: number): Parameters<typeof selectJudgeCriteria>[0] {
  return {
    goalCriteria: [
      { type: 'judge', name: 'goal-judge', rubric: [] },
      { type: 'contains', name: 'goal-det', inField: 'output', pattern: 'ok' },
    ] as unknown as CyberneticEvalSuite['goalCriteria'],
    taskCriteria: {
      t1: [{ type: 'judge', name: 'task-judge', rubric: [] }],
    } as unknown as CyberneticEvalSuite['taskCriteria'],
    trajectoryCriteria: [
      { type: 'judge', name: 'traj-judge', rubric: [] },
    ] as unknown as CyberneticEvalSuite['trajectoryCriteria'],
    ...(judgeSamplingRate !== undefined ? { judgeSamplingRate } : {}),
  };
}

describe('selectJudgeCriteria', () => {
  it('default rate (absent) selects every judge criterion', () => {
    const res = selectJudgeCriteria(suite(), false);
    expect(res.selections).toHaveLength(3);
    expect(res.selections.every((s) => s.selection === 'evaluated')).toBe(true);
    expect(res.selected.has(judgeSelectionKey('task', 'task-judge', 't1'))).toBe(true);
  });

  it('rate 0 on a clean run samples every judge criterion out as not_selected', () => {
    const res = selectJudgeCriteria(suite(0), false);
    expect(res.selections).toHaveLength(3);
    expect(res.selections.every((s) => s.selection === 'not_selected')).toBe(true);
    expect(res.selected.size).toBe(0);
  });

  it('a FAILED run is always judged, even at rate 0', () => {
    const res = selectJudgeCriteria(suite(0), true);
    expect(res.selections.every((s) => s.selection === 'evaluated')).toBe(true);
    expect(res.selected.size).toBe(3);
  });

  it('deterministic criteria are never recorded in the selection', () => {
    const res = selectJudgeCriteria(suite(), false);
    expect(res.selections.find((s) => s.criterionName === 'goal-det')).toBeUndefined();
  });

  it('task-scope selections carry the taskId', () => {
    const res = selectJudgeCriteria(suite(0), false);
    expect(res.selections.find((s) => s.scope === 'task')).toMatchObject({
      taskId: 't1',
      criterionName: 'task-judge',
      selection: 'not_selected',
    });
  });

  it('the injected RNG drives per-criterion selection', () => {
    const rolls = [0.2, 0.8, 0.2];
    const res = selectJudgeCriteria(suite(0.5), false, () => rolls.shift() ?? 0);
    expect(res.selections.map((s) => s.selection)).toEqual([
      'evaluated',
      'not_selected',
      'evaluated',
    ]);
  });
});
