import type { CyberneticEvalSuite, JudgeCriterionSelection } from '@aflow/schemas';

export interface JudgeSelectionResult {
  selections: JudgeCriterionSelection[];
  /** Keys (`scope`, `task:<taskId>` scoped by criterion name) selected for dispatch. */
  selected: Set<string>;
}

export function judgeSelectionKey(
  scope: 'goal' | 'trajectory' | 'task',
  criterionName: string,
  taskId?: string,
): string {
  return scope === 'task' ? `task:${taskId ?? ''} ${criterionName}` : `${scope} ${criterionName}`;
}

/**
 * Decide, per judge criterion, whether it is dispatched this run.
 * A failed run is always judged (the cost lever never hides a failure);
 * otherwise each criterion is selected with probability `judgeSamplingRate`
 * (default 1). Sampled-out criteria are recorded `not_selected` — excluded
 * from scoring but visible in the run's evaluation envelope.
 */
export function selectJudgeCriteria(
  suite: Pick<
    CyberneticEvalSuite,
    'goalCriteria' | 'taskCriteria' | 'trajectoryCriteria' | 'judgeSamplingRate'
  >,
  runFailed: boolean,
  random: () => number = Math.random,
): JudgeSelectionResult {
  const rate = suite.judgeSamplingRate ?? 1;
  const selections: JudgeCriterionSelection[] = [];
  const selected = new Set<string>();

  const record = (scope: 'goal' | 'trajectory' | 'task', name: string, taskId?: string): void => {
    const isSelected = runFailed || random() < rate;
    selections.push({
      scope,
      ...(taskId !== undefined ? { taskId } : {}),
      criterionName: name,
      selection: isSelected ? 'evaluated' : 'not_selected',
    });
    if (isSelected) selected.add(judgeSelectionKey(scope, name, taskId));
  };

  for (const c of suite.goalCriteria) {
    if (c.type === 'judge') record('goal', c.name);
  }
  for (const [taskId, criteria] of Object.entries(suite.taskCriteria)) {
    for (const c of criteria) {
      if (c.type === 'judge') record('task', c.name, taskId);
    }
  }
  for (const c of suite.trajectoryCriteria) {
    if (c.type === 'judge') record('trajectory', c.name);
  }

  return { selections, selected };
}
