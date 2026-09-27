import { describe, it, expect } from 'vitest';
import { applyRunTerminalCoverage, computeFailedRequiredTaskIds } from '../evalRunnerCoverage.js';

describe('applyRunTerminalCoverage (pure)', () => {
  it('the market-briefing regression: a failed required task cannot score partial-success', () => {
    // The suite's weighted score came out 0.30 → verdict 'partial' — but the
    // required render-card task failed.
    const result = applyRunTerminalCoverage({
      verdict: 'partial',
      overall: 0.3,
      coverage: { runStatus: 'completed', failedRequiredTaskIds: ['render-card'] },
    });
    expect(result.verdict).toBe('fail');
    expect(result.overall).toBe(0);
    expect(result.syntheticResult?.criterionName).toBe('run-terminal');
    expect(result.syntheticResult?.evidence).toContain('render-card');
  });

  it('a run whose terminal status is failed cannot score pass/partial either', () => {
    const result = applyRunTerminalCoverage({
      verdict: 'pass',
      overall: 1,
      coverage: { runStatus: 'failed', failedRequiredTaskIds: [] },
    });
    expect(result.verdict).toBe('fail');
    expect(result.overall).toBe(0);
    expect(result.syntheticResult?.evidence).toContain("terminal status is 'failed'");
  });

  it('a clean run is untouched (identity)', () => {
    const result = applyRunTerminalCoverage({
      verdict: 'partial',
      overall: 0.55,
      coverage: { runStatus: 'completed', failedRequiredTaskIds: [] },
    });
    expect(result.verdict).toBe('partial');
    expect(result.overall).toBe(0.55);
    expect(result.syntheticResult).toBeUndefined();
  });

  it('an OPTIONAL failed task never trips the rule (the caller filters to required)', () => {
    // The caller (postRunHooks) only passes failed REQUIRED task ids — an
    // optional task's failure simply never appears here.
    const result = applyRunTerminalCoverage({
      verdict: 'pass',
      overall: 0.85,
      coverage: { runStatus: 'completed', failedRequiredTaskIds: [] },
    });
    expect(result.verdict).toBe('pass');
  });
});

describe('computeFailedRequiredTaskIds (pure, shared by every runEvaluation caller)', () => {
  const workflowTasks = [
    { taskId: 'fetch-data' },
    { taskId: 'render-card' },
    { taskId: 'notify', optional: true },
  ];

  it('intersects failed run tasks with required workflow tasks', () => {
    const result = computeFailedRequiredTaskIds(workflowTasks, [
      { taskId: 'fetch-data', status: 'completed' },
      { taskId: 'render-card', status: 'failed' },
      { taskId: 'notify', status: 'failed' },
    ]);
    expect(result).toEqual(['render-card']);
  });

  it('an optional failed task is excluded; a clean run yields empty', () => {
    expect(
      computeFailedRequiredTaskIds(workflowTasks, [
        { taskId: 'fetch-data', status: 'completed' },
        { taskId: 'notify', status: 'failed' },
      ]),
    ).toEqual([]);
  });

  it('null/absent workflow yields empty (run-level status still covers)', () => {
    expect(
      computeFailedRequiredTaskIds(null, [{ taskId: 'render-card', status: 'failed' }]),
    ).toEqual([]);
    expect(
      computeFailedRequiredTaskIds(undefined, [{ taskId: 'render-card', status: 'failed' }]),
    ).toEqual([]);
  });

  it('a failed run with a failed required task feeds the rule', () => {
    // Every runEvaluation entry point routes through postRunHooks — verify
    // end-to-end composition with applyRunTerminalCoverage.
    const failedRequiredTaskIds = computeFailedRequiredTaskIds(workflowTasks, [
      { taskId: 'render-card', status: 'failed' },
    ]);
    const result = applyRunTerminalCoverage({
      verdict: 'partial',
      overall: 0.3,
      coverage: { runStatus: 'failed', failedRequiredTaskIds },
    });
    expect(result.verdict).toBe('fail');
    expect(result.overall).toBe(0);
    expect(result.syntheticResult?.evidence).toContain('render-card');
  });
});
