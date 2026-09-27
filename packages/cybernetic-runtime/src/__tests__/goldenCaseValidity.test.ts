import { describe, it, expect } from 'vitest';
import type { GoldenCase, WorkflowTask } from '@aflow/schemas';
import { GoldenCaseSchema, getOperation } from '@aflow/schemas';
import { validateGoldenCase } from '../goldenCaseValidity.js';

function agent(taskId: string, partial?: Partial<WorkflowTask>): WorkflowTask {
  return { taskId, name: taskId, goal: 'g', type: 'agent', ...partial };
}

/** An agent task with a CLOSED outputContract declaring exactly `fields`. */
function closedAgent(taskId: string, fields: string[]): WorkflowTask {
  return agent(taskId, {
    outputContract: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: fields,
        properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])),
      },
    },
  });
}

const KNOWN_OP = 'workflow.learn';

function goldenCase(overrides?: Record<string, unknown>): GoldenCase {
  return GoldenCaseSchema.parse({
    caseId: '11111111-1111-4111-8111-111111111111',
    datasetId: '22222222-2222-4222-8222-222222222222',
    title: 't',
    stratum: { scenario: 's', direction: 'should_succeed', tier: 'regression' },
    trigger: { inputs: {} },
    fixture: { tier: 'seeded' },
    expectations: [{ kind: 'terminal', runStatus: 'completed' }],
    rubrics: [],
    provenance: { source: 'curated', workflowRevision: 1, referenceOutputRef: 'inline:ok' },
    ...overrides,
  });
}

const codesOf = (diags: ReturnType<typeof validateGoldenCase>) => diags.map((d) => d.code).sort();

describe('validateGoldenCase — decidability + solvability (Plan 269 D1)', () => {
  it('sanity: the known-op fixture is actually registered', () => {
    expect(getOperation(KNOWN_OP)).toBeDefined();
  });

  it('passes a coherent case with zero diagnostics', () => {
    const diags = validateGoldenCase(goldenCase(), { tasks: [agent('triage')] });
    expect(diags).toEqual([]);
  });

  it('flags a case with no expectations and no rubrics as ungradeable', () => {
    const diags = validateGoldenCase(goldenCase({ expectations: [] }), { tasks: [agent('t')] });
    expect(codesOf(diags)).toContain('case_no_checks');
    expect(diags.find((d) => d.code === 'case_no_checks')?.severity).toBe('error');
  });

  // A rubric-only case used to be accepted here as "judge-decidable", which
  // the runtime cannot honour: `gradeCaseTrial` returns `error` when there
  // are no expectations, and the engine skips the judge stage on `error`, so
  // every trial paid for a full run and produced nothing gradable forever.
  it('accepts a rubric-only case — a judge decides as a check decides', () => {
    // The two measure different things: whether the world changed, and whether
    // what was said to a person was honest. A case measuring only the second is
    // a real case, and refusing it was refusing the more important half.
    const diags = validateGoldenCase(
      goldenCase({
        expectations: [],
        rubrics: [{ kind: 'suite_criterion', criterionId: 'clarity' }],
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(diags)).not.toContain('case_no_checks');
  });

  it('rejects a case carrying neither, which nothing can grade', () => {
    const diags = validateGoldenCase(goldenCase({ expectations: [], rubrics: [] }), {
      tasks: [agent('t')],
    });
    expect(codesOf(diags)).toContain('case_no_checks');
    expect(diags.find((d) => d.code === 'case_no_checks')?.severity).toBe('error');
  });

  it('accepts a case whose rubrics ride alongside a deterministic expectation', () => {
    const diags = validateGoldenCase(
      goldenCase({ rubrics: [{ kind: 'suite_criterion', criterionId: 'clarity' }] }),
      { tasks: [agent('triage')] },
    );
    expect(codesOf(diags)).not.toContain('case_no_checks');
  });

  it('flags unknown taskIds across terminal, task_status, and output expectations', () => {
    const diags = validateGoldenCase(
      goldenCase({
        stratum: { scenario: 's', direction: 'should_pause', tier: 'regression' },
        expectations: [
          { kind: 'terminal', runStatus: 'paused', pausedTaskId: 'ghost-pause' },
          { kind: 'task_status', taskId: 'ghost-status', status: 'succeeded' },
          {
            kind: 'output',
            scope: { taskId: 'ghost-output' },
            check: { op: 'equals', path: 'x', value: 1 },
          },
        ],
      }),
      { tasks: [agent('real')] },
    );
    const unknown = diags.filter((d) => d.code === 'case_unknown_task');
    expect(unknown.map((d) => d.taskId).sort()).toEqual([
      'ghost-output',
      'ghost-pause',
      'ghost-status',
    ]);
    expect(unknown.every((d) => d.severity === 'error')).toBe(true);
    expect(unknown.map((d) => d.expectationIndex).sort()).toEqual([0, 1, 2]);
  });

  it('flags an unknown taskId on a reply expectation, and allows an omitted one', () => {
    const diags = validateGoldenCase(
      goldenCase({
        expectations: [
          {
            kind: 'reply',
            taskId: 'ghost-reply',
            name: 'names the merchant',
            check: { op: 'contains', pattern: 'Extra' },
          },
          // Omitted taskId means whichever task the run paused on, so there is
          // nothing to resolve and nothing to flag.
          { kind: 'reply', check: { op: 'not_contains', pattern: 'ord_' } },
        ],
      }),
      { tasks: [agent('real')] },
    );
    const unknown = diags.filter((d) => d.code === 'case_unknown_task');
    expect(unknown.map((d) => d.taskId)).toEqual(['ghost-reply']);
    expect(unknown[0]?.severity).toBe('error');
    expect(unknown[0]?.expectationIndex).toBe(0);
  });

  it('flags an output check bound to a field a closed contract never produces', () => {
    const diags = validateGoldenCase(
      goldenCase({
        expectations: [
          { kind: 'terminal', runStatus: 'completed' },
          {
            kind: 'output',
            scope: { taskId: 'poll' },
            check: { type: 'threshold', name: 'ok', metric: 'lbValue', operator: 'gt', target: 0 },
          },
          {
            kind: 'output',
            scope: { taskId: 'poll' },
            check: { type: 'contains', name: 'dead', pattern: 'x', inField: 'ghostField' },
          },
        ],
      }),
      { tasks: [closedAgent('poll', ['lbValue'])] },
    );
    const flagged = diags.filter((d) => d.code === 'case_field_not_produced');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.field).toBe('ghostField');
    expect(flagged[0]?.expectationIndex).toBe(2);
  });

  it('never flags fields on an open/undeclared output, reserved fields, or run scope', () => {
    const diags = validateGoldenCase(
      goldenCase({
        expectations: [
          { kind: 'terminal', runStatus: 'completed' },
          {
            kind: 'output',
            scope: { taskId: 'open' },
            check: { op: 'not_contains', pattern: 'x', inField: 'anything' },
          },
          {
            kind: 'output',
            scope: { taskId: 'closed' },
            check: { type: 'contains', name: 'r', pattern: 'x', inField: 'summary' },
          },
          {
            kind: 'output',
            scope: 'run',
            check: { op: 'equals', path: 'anyField.sub', value: true },
          },
        ],
      }),
      { tasks: [agent('open'), closedAgent('closed', ['onlyField'])] },
    );
    expect(codesOf(diags)).not.toContain('case_field_not_produced');
  });

  it('checks the head segment of an equals path against the closed contract', () => {
    const diags = validateGoldenCase(
      goldenCase({
        expectations: [
          { kind: 'terminal', runStatus: 'completed' },
          {
            kind: 'output',
            scope: { taskId: 'closed' },
            check: { op: 'equals', path: 'ghost.sub.key', value: 'x' },
          },
        ],
      }),
      { tasks: [closedAgent('closed', ['real'])] },
    );
    expect(diags.find((d) => d.code === 'case_field_not_produced')?.field).toBe('ghost');
  });

  it('flags unknown operations — error in required_ops, advisory in forbidden_ops', () => {
    const diags = validateGoldenCase(
      goldenCase({
        expectations: [
          { kind: 'terminal', runStatus: 'completed' },
          {
            kind: 'trajectory',
            check: { op: 'required_ops', operationIds: [KNOWN_OP, 'ghost.ops.call'] },
          },
          {
            kind: 'trajectory',
            check: { op: 'forbidden_ops', operationIds: ['ghost.ops.call'] },
          },
        ],
      }),
      { tasks: [agent('t')] },
    );
    const unknown = diags.filter((d) => d.code === 'case_unknown_operation');
    expect(unknown).toHaveLength(2);
    expect(unknown.find((d) => d.expectationIndex === 1)?.severity).toBe('error');
    expect(unknown.find((d) => d.expectationIndex === 2)?.severity).toBe('advisory');
    expect(unknown.every((d) => d.operationId === 'ghost.ops.call')).toBe(true);
  });

  it('requires solvability evidence on regression-tier cases only', () => {
    const noEvidence = {
      provenance: { source: 'curated', workflowRevision: 1 },
    };
    const regression = validateGoldenCase(goldenCase(noEvidence), { tasks: [agent('t')] });
    expect(codesOf(regression)).toContain('case_missing_solvability_evidence');

    const capability = validateGoldenCase(
      goldenCase({
        ...noEvidence,
        stratum: { scenario: 's', direction: 'should_succeed', tier: 'capability' },
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(capability)).not.toContain('case_missing_solvability_evidence');

    const viaCompletedRun = validateGoldenCase(
      goldenCase({
        provenance: {
          source: 'promoted_from_run',
          runId: 'run-1',
          runStatus: 'completed',
          workflowRevision: 1,
        },
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(viaCompletedRun)).not.toContain('case_missing_solvability_evidence');
  });

  it('a failed originating run is the counterexample, never solvability evidence', () => {
    const viaFailedRun = validateGoldenCase(
      goldenCase({
        provenance: {
          source: 'promoted_from_run',
          runId: 'run-1',
          runStatus: 'failed',
          workflowRevision: 1,
        },
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(viaFailedRun)).toContain('case_missing_solvability_evidence');

    // A runId with no recorded terminal status is unverifiable — not evidence.
    const viaUnknownStatusRun = validateGoldenCase(
      goldenCase({
        provenance: { source: 'promoted_from_run', runId: 'run-1', workflowRevision: 1 },
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(viaUnknownStatusRun)).toContain('case_missing_solvability_evidence');
  });

  it('a paused originating run is solvability evidence exactly for should_pause cases', () => {
    const pausedProvenance = {
      source: 'promoted_from_run',
      runId: 'run-1',
      runStatus: 'paused',
      workflowRevision: 1,
    };
    const shouldPause = validateGoldenCase(
      goldenCase({
        stratum: { scenario: 's', direction: 'should_pause', tier: 'regression' },
        expectations: [{ kind: 'terminal', runStatus: 'paused' }],
        provenance: pausedProvenance,
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(shouldPause)).not.toContain('case_missing_solvability_evidence');

    const shouldSucceed = validateGoldenCase(goldenCase({ provenance: pausedProvenance }), {
      tasks: [agent('t')],
    });
    expect(codesOf(shouldSucceed)).toContain('case_missing_solvability_evidence');
  });

  it('rejects a live fixture on a regression-tier case', () => {
    const diags = validateGoldenCase(goldenCase({ fixture: { tier: 'live' } }), {
      tasks: [agent('t')],
    });
    expect(diags.find((d) => d.code === 'case_live_fixture_regression_tier')?.severity).toBe(
      'error',
    );

    const capability = validateGoldenCase(
      goldenCase({
        fixture: { tier: 'live' },
        stratum: { scenario: 's', direction: 'should_succeed', tier: 'capability' },
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(capability)).not.toContain('case_live_fixture_regression_tier');
  });

  it('advises when direction and terminal expectations disagree', () => {
    const shouldPause = validateGoldenCase(
      goldenCase({
        stratum: { scenario: 's', direction: 'should_pause', tier: 'regression' },
        expectations: [{ kind: 'terminal', runStatus: 'completed' }],
      }),
      { tasks: [agent('t')] },
    );
    const mismatch = shouldPause.find((d) => d.code === 'case_direction_terminal_mismatch');
    expect(mismatch?.severity).toBe('advisory');

    const coherent = validateGoldenCase(
      goldenCase({
        stratum: { scenario: 's', direction: 'should_pause', tier: 'regression' },
        expectations: [{ kind: 'terminal', runStatus: 'paused', pausedReason: 'needs_decision' }],
      }),
      { tasks: [agent('t')] },
    );
    expect(codesOf(coherent)).not.toContain('case_direction_terminal_mismatch');
  });
});
