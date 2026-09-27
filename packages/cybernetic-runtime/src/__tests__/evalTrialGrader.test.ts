/**
 * Deterministic trial grader (Plan 269 D3/D6): every expectation kind must
 * pass and fail on the right facts, partial credit is the fraction of
 * binary expectations, a failed run fails its terminal expectation with the
 * failure attached, rubric slots are pending (never graded) in P2, and —
 * the load-bearing property — grading the same persisted record twice
 * yields byte-identical verdicts.
 */
import { describe, expect, it } from 'vitest';
import type { CaseExpectation, CaseRubric } from '@aflow/schemas';
import {
  collectGradingPayloadRefs,
  gradeCaseTrial,
  type GradableRunRecord,
} from '../evalTrialGrader.js';

function completedRun(overrides?: Partial<GradableRunRecord>): GradableRunRecord {
  return {
    status: 'completed',
    pausedReason: null,
    tasks: [
      {
        taskId: 'fetch',
        status: 'succeeded',
        operationId: 'api.http.call',
        outputRef: 'ref:fetch-out',
        summary: 'fetched 3 rows',
        metrics: { rowCount: 3 },
        durationMs: 1200,
        costCents: 2,
        completedAtMs: 1000,
      },
      {
        taskId: 'analyze',
        status: 'succeeded',
        operationId: 'ai.text.generate',
        outputRef: 'ref:analyze-out',
        summary: 'analysis done',
        metrics: { validationScore: 0.9 },
        durationMs: 3000,
        costCents: 10,
        completedAtMs: 2000,
      },
    ],
    ...overrides,
  };
}

const PAYLOADS = new Map<string, unknown>([
  ['ref:fetch-out', { rows: 3, note: 'clean import' }],
  ['ref:analyze-out', { validationScore: 0.9, label: 'good', nested: { grade: 'A' } }],
  ['ref:schema', { type: 'object', required: ['validationScore'] }],
]);

function grade(
  expectations: CaseExpectation[],
  run: GradableRunRecord = completedRun(),
  rubrics: CaseRubric[] = [],
) {
  return gradeCaseTrial({
    expectations,
    rubrics,
    fixtureTier: 'seeded',
    run,
    payloads: PAYLOADS,
  });
}

describe('terminal expectations', () => {
  it('passes on matching status', () => {
    const { verdict } = grade([{ kind: 'terminal', runStatus: 'completed' }]);
    expect(verdict).toBe('pass');
  });

  it('fails a run that FAILED when the case expected completion, attaching the failure', () => {
    const run = completedRun({ status: 'failed', failureReason: 'step exploded' });
    const { verdict, results } = grade([{ kind: 'terminal', runStatus: 'completed' }], run);
    expect(verdict).toBe('fail');
    expect(results.expectationResults[0]?.detail).toContain('step exploded');
    expect(results.runFailure).toEqual({ runStatus: 'failed', failureReason: 'step exploded' });
  });

  it('checks pausedReason and pausedTaskId for should_pause cases', () => {
    const run = completedRun({
      status: 'paused',
      pausedReason: 'needs_decision',
      tasks: [
        {
          taskId: 'approve',
          status: 'paused',
          operationId: 'user.interaction.approve',
          outputRef: null,
        },
      ],
    });
    const pass = grade(
      [
        {
          kind: 'terminal',
          runStatus: 'paused',
          pausedReason: 'needs_decision',
          pausedTaskId: 'approve',
        },
      ],
      run,
    );
    expect(pass.verdict).toBe('pass');
    const wrongReason = grade(
      [{ kind: 'terminal', runStatus: 'paused', pausedReason: 'needs_credentials' }],
      run,
    );
    expect(wrongReason.verdict).toBe('fail');
    const wrongTask = grade(
      [{ kind: 'terminal', runStatus: 'paused', pausedTaskId: 'fetch' }],
      run,
    );
    expect(wrongTask.verdict).toBe('fail');
  });
});

describe('task_status expectations', () => {
  it('passes and fails on the task row status', () => {
    expect(grade([{ kind: 'task_status', taskId: 'fetch', status: 'succeeded' }]).verdict).toBe(
      'pass',
    );
    expect(grade([{ kind: 'task_status', taskId: 'fetch', status: 'failed' }]).verdict).toBe(
      'fail',
    );
  });

  it('fails on a task with no record', () => {
    const { verdict, results } = grade([
      { kind: 'task_status', taskId: 'ghost', status: 'succeeded' },
    ]);
    expect(verdict).toBe('fail');
    expect(results.expectationResults[0]?.detail).toContain('no record');
  });
});

describe('output expectations', () => {
  it('threshold: passes and fails against the task output payload', () => {
    const pass = grade([
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: {
          type: 'threshold',
          name: 'score-bar',
          metric: 'validationScore',
          operator: 'gte',
          target: 0.8,
        },
      },
    ]);
    expect(pass.verdict).toBe('pass');
    const fail = grade([
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: {
          type: 'threshold',
          name: 'score-bar',
          metric: 'validationScore',
          operator: 'gte',
          target: 0.95,
        },
      },
    ]);
    expect(fail.verdict).toBe('fail');
  });

  it('threshold: an unresolved $campaign parameter fails legibly', () => {
    const { verdict, results } = grade([
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: {
          type: 'threshold',
          name: 'bar',
          metric: 'validationScore',
          operator: 'gte',
          target: { $campaign: 'target_bar' },
        },
      },
    ]);
    expect(verdict).toBe('fail');
    expect(results.expectationResults[0]?.detail).toContain('$campaign');
  });

  it('threshold: resolves $campaign params from the case campaignConfig', () => {
    const run = completedRun({ campaignConfig: { target_bar: 0.8 } });
    const { verdict } = grade(
      [
        {
          kind: 'output',
          scope: { taskId: 'analyze' },
          check: {
            type: 'threshold',
            name: 'bar',
            metric: 'validationScore',
            operator: 'gte',
            target: { $campaign: 'target_bar' },
          },
        },
      ],
      run,
    );
    expect(verdict).toBe('pass');
  });

  it('contains: passes and fails on pattern match', () => {
    const pass = grade([
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: { type: 'contains', name: 'label-check', pattern: 'good', inField: 'label' },
      },
    ]);
    expect(pass.verdict).toBe('pass');
    const fail = grade([
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: { type: 'contains', name: 'label-check', pattern: 'terrible', inField: 'label' },
      },
    ]);
    expect(fail.verdict).toBe('fail');
  });

  it('not_contains: fails when the forbidden pattern appears, passes when absent', () => {
    const fail = grade([
      {
        kind: 'output',
        scope: { taskId: 'fetch' },
        check: { op: 'not_contains', pattern: 'clean', inField: 'note' },
      },
    ]);
    expect(fail.verdict).toBe('fail');
    const pass = grade([
      {
        kind: 'output',
        scope: { taskId: 'fetch' },
        check: { op: 'not_contains', pattern: 'dirty', inField: 'note' },
      },
    ]);
    expect(pass.verdict).toBe('pass');
  });

  // Vacuous truth is not evidence. A `not_contains` that scored because nothing
  // was produced would rank a silent subject ABOVE one that answered, since only
  // an answer can contain the forbidden thing — and a case whose content checks
  // are all negative could take full marks off a run that did nothing.
  it('not_contains: an absent field fails rather than passing on nothing', () => {
    const { verdict, results } = grade([
      {
        kind: 'output',
        scope: { taskId: 'fetch' },
        check: { op: 'not_contains', pattern: 'x', inField: 'missingField' },
      },
    ]);
    expect(verdict).toBe('fail');
    expect(results.expectationResults[0]?.detail).toContain('nothing was produced');
  });

  it('contains and not_contains agree on an absent field', () => {
    const absent = { taskId: 'fetch' } as const;
    const notContains = grade([
      {
        kind: 'output',
        scope: absent,
        check: { op: 'not_contains', pattern: 'x', inField: 'missingField' },
      },
    ]);
    const contains = grade([
      {
        kind: 'output',
        scope: absent,
        check: { type: 'contains', name: 'says x', pattern: 'x', inField: 'missingField' },
      },
    ]);
    expect(notContains.verdict).toBe('fail');
    expect(contains.verdict).toBe('fail');
  });

  it('json_schema: validates the output payload with Ajv', () => {
    const pass = grade([
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: { op: 'json_schema', schemaRef: 'ref:schema' },
      },
    ]);
    expect(pass.verdict).toBe('pass');
    const fail = grade([
      {
        kind: 'output',
        scope: { taskId: 'fetch' },
        check: { op: 'json_schema', schemaRef: 'ref:schema' },
      },
    ]);
    expect(fail.verdict).toBe('fail');
    expect(fail.results.expectationResults[0]?.detail).toContain('validationScore');
  });

  it('json_schema: an unavailable schema payload fails', () => {
    const { verdict } = grade([
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: { op: 'json_schema', schemaRef: 'ref:never-fetched' },
      },
    ]);
    expect(verdict).toBe('fail');
  });

  it('equals: dot-path deep equality, run scope resolves the last output task', () => {
    const pass = grade([
      {
        kind: 'output',
        scope: 'run',
        check: { op: 'equals', path: 'nested.grade', value: 'A' },
      },
    ]);
    expect(pass.verdict).toBe('pass');
    const fail = grade([
      { kind: 'output', scope: 'run', check: { op: 'equals', path: 'nested.grade', value: 'B' } },
    ]);
    expect(fail.verdict).toBe('fail');
    const missing = grade([
      { kind: 'output', scope: 'run', check: { op: 'equals', path: 'nested.nope', value: 1 } },
    ]);
    expect(missing.verdict).toBe('fail');
  });

  it('an output payload missing from the map grades failed, never skipped', () => {
    const run = completedRun({
      tasks: [{ taskId: 'fetch', status: 'succeeded', operationId: null, outputRef: 'ref:gone' }],
    });
    const { verdict, results } = grade(
      [
        {
          kind: 'output',
          scope: { taskId: 'fetch' },
          check: { op: 'equals', path: 'x', value: 1 },
        },
      ],
      run,
    );
    expect(verdict).toBe('fail');
    expect(results.expectationResults[0]?.detail).toContain('unavailable');
  });
});

describe('trajectory expectations', () => {
  it('required_ops: superset invariant over the observed operation set', () => {
    const pass = grade([
      { kind: 'trajectory', check: { op: 'required_ops', operationIds: ['api.http.call'] } },
    ]);
    expect(pass.verdict).toBe('pass');
    const fail = grade([
      { kind: 'trajectory', check: { op: 'required_ops', operationIds: ['memory.store.get'] } },
    ]);
    expect(fail.verdict).toBe('fail');
    expect(fail.results.expectationResults[0]?.detail).toContain('memory.store.get');
  });

  it('forbidden_ops: subset invariant — any hit fails', () => {
    const pass = grade([
      {
        kind: 'trajectory',
        check: { op: 'forbidden_ops', operationIds: ['compute.sandbox.exec'] },
      },
    ]);
    expect(pass.verdict).toBe('pass');
    const fail = grade([
      { kind: 'trajectory', check: { op: 'forbidden_ops', operationIds: ['api.http.call'] } },
    ]);
    expect(fail.verdict).toBe('fail');
  });

  it('trace_bound: aggregates step count / duration / cost over the task rows', () => {
    const pass = grade([
      {
        kind: 'trajectory',
        check: { type: 'trace_bound', name: 'cheap', metric: 'cost_cents', maxValue: 20 },
      },
    ]);
    expect(pass.verdict).toBe('pass');
    const fail = grade([
      {
        kind: 'trajectory',
        check: { type: 'trace_bound', name: 'cheap', metric: 'cost_cents', maxValue: 5 },
      },
    ]);
    expect(fail.verdict).toBe('fail');
  });
});

describe('partial credit + rubrics', () => {
  it('fractionPassed is the fraction of binary expectations; verdict needs all', () => {
    const { verdict, results } = grade([
      { kind: 'terminal', runStatus: 'completed' },
      { kind: 'task_status', taskId: 'fetch', status: 'failed' },
      { kind: 'task_status', taskId: 'analyze', status: 'succeeded' },
      { kind: 'trajectory', check: { op: 'required_ops', operationIds: ['memory.store.get'] } },
    ]);
    expect(verdict).toBe('fail');
    expect(results.fractionPassed).toBe(0.5);
  });

  it('rubric slots are recorded pending and never graded in P2', () => {
    const rubrics: CaseRubric[] = [
      { kind: 'suite_criterion', criterionId: 'clarity' },
      {
        kind: 'case_local',
        criterion: {
          type: 'judge',
          name: 'tone',
          rubric: [{ criterion: 'polite tone', scale: 'binary', description: 'stays courteous' }],
        },
      },
    ];
    const { verdict, results } = grade(
      [{ kind: 'terminal', runStatus: 'completed' }],
      completedRun(),
      rubrics,
    );
    expect(verdict).toBe('pass');
    expect(results.pendingRubrics).toEqual(['clarity', 'tone']);
  });

  // The authoring gate now refuses a rubric-only case outright, so this is
  // the defensive path for one stored before that rule. It stays `error`:
  // judges are advisory and cannot supply the verdict the case lacks.
  it('a rubric-only case is gradable — its slots go to the judge, not to an error', () => {
    // The deterministic pass is only half of grading here. It reports no
    // grading error and leaves the slot pending for the judge stage, which is
    // what decides the case.
    const rubrics: CaseRubric[] = [{ kind: 'suite_criterion', criterionId: 'clarity' }];
    const { results } = grade([], completedRun(), rubrics);
    expect(results.gradingError).toBeUndefined();
    expect(results.pendingRubrics).toEqual(['clarity']);
  });

  it('refuses a case carrying neither a check nor a rubric', () => {
    const { verdict, results } = grade([], completedRun(), []);
    expect(verdict).toBe('error');
    expect(results.gradingError).toContain('neither');
  });
});

describe('determinism (the P2 metric)', () => {
  it('double-grading the same persisted record yields byte-identical results', () => {
    const expectations: CaseExpectation[] = [
      { kind: 'terminal', runStatus: 'completed' },
      { kind: 'task_status', taskId: 'analyze', status: 'succeeded' },
      {
        kind: 'output',
        scope: { taskId: 'analyze' },
        check: {
          type: 'threshold',
          name: 'bar',
          metric: 'validationScore',
          operator: 'gte',
          target: 0.8,
        },
      },
      {
        kind: 'output',
        scope: 'run',
        check: { op: 'equals', path: 'nested.grade', value: 'A' },
      },
      {
        kind: 'trajectory',
        check: { op: 'forbidden_ops', operationIds: ['compute.sandbox.exec'] },
      },
      {
        kind: 'trajectory',
        check: { type: 'trace_bound', name: 'cheap', metric: 'duration_ms', maxValue: 10_000 },
      },
    ];
    const rubrics: CaseRubric[] = [{ kind: 'suite_criterion', criterionId: 'clarity' }];
    const first = gradeCaseTrial({
      expectations,
      rubrics,
      fixtureTier: 'seeded',
      run: completedRun(),
      payloads: PAYLOADS,
    });
    const second = gradeCaseTrial({
      expectations,
      rubrics,
      fixtureTier: 'seeded',
      run: completedRun(),
      payloads: PAYLOADS,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('collectGradingPayloadRefs', () => {
  it('collects output refs for scoped checks plus schema refs, deduplicated', () => {
    const refs = collectGradingPayloadRefs(
      [
        {
          kind: 'output',
          scope: { taskId: 'analyze' },
          check: { op: 'json_schema', schemaRef: 'ref:schema' },
        },
        {
          kind: 'output',
          scope: 'run',
          check: { op: 'equals', path: 'x', value: 1 },
        },
        { kind: 'terminal', runStatus: 'completed' },
      ],
      completedRun(),
    );
    expect([...refs].sort()).toEqual(['ref:analyze-out', 'ref:schema']);
  });
});

/**
 * A conversational subject answers and waits for the person, so its answer is
 * in the pause contract rather than a task output. These pin that the reply is
 * reachable, and that silence never scores.
 */
describe('reply expectations (Plan 293 §9.5)', () => {
  const REPLY = 'طلبك من إكسترا متأخر — المتبقي 625 ريال';

  function pausedRun(overrides?: Partial<GradableRunRecord>): GradableRunRecord {
    return {
      status: 'paused',
      pausedReason: 'task_paused',
      pausedPayloadRef: 'ref:pause',
      tasks: [
        {
          taskId: 'ask-the-desk',
          status: 'paused',
          operationId: 'ai.agent.turn',
          outputRef: null,
          completedAtMs: 1000,
        },
      ],
      ...overrides,
    };
  }

  const PAUSE_PAYLOADS = new Map<string, unknown>([
    ['ref:pause', { reason: 'input_required', prompt: REPLY }],
  ]);

  function grade(
    expectation: CaseExpectation,
    run: GradableRunRecord,
    payloads: ReadonlyMap<string, unknown> = PAUSE_PAYLOADS,
  ) {
    return gradeCaseTrial({
      expectations: [expectation],
      rubrics: [] as CaseRubric[],
      fixtureTier: 'sealed',
      run,
      payloads,
    });
  }

  const contains: CaseExpectation = {
    kind: 'reply',
    name: 'names the merchant',
    check: { op: 'contains', pattern: 'إكسترا' },
  };
  const notContains: CaseExpectation = {
    kind: 'reply',
    name: 'leaks no internal id',
    check: { op: 'not_contains', pattern: 'ord_' },
  };

  it('reads the answer out of the pause contract', () => {
    expect(grade(contains, pausedRun()).verdict).toBe('pass');
    expect(grade(notContains, pausedRun()).verdict).toBe('pass');
  });

  it('fails a contains the reply does not satisfy', () => {
    const missing: CaseExpectation = {
      kind: 'reply',
      name: 'names a refund',
      check: { op: 'contains', pattern: 'استرجاع' },
    };
    expect(grade(missing, pausedRun()).verdict).toBe('fail');
  });

  // The defect this kind exists to avoid: a negative assertion over text that
  // was never produced would otherwise credit a subject for saying nothing.
  it('fails BOTH directions when the subject said nothing', () => {
    const silent = new Map<string, unknown>([['ref:pause', { reason: 'input_required' }]]);
    expect(grade(contains, pausedRun(), silent).verdict).toBe('fail');
    expect(grade(notContains, pausedRun(), silent).verdict).toBe('fail');
  });

  it('fails when the run stopped on no pause at all', () => {
    const run = pausedRun({ status: 'completed', pausedReason: null });
    delete (run as { pausedPayloadRef?: string | null }).pausedPayloadRef;
    expect(grade(notContains, run).verdict).toBe('fail');
  });

  it('fails when the named task is not the one that paused', () => {
    const expectation: CaseExpectation = {
      kind: 'reply',
      taskId: 'some-other-task',
      name: 'names the merchant',
      check: { op: 'contains', pattern: 'إكسترا' },
    };
    expect(grade(expectation, pausedRun()).verdict).toBe('fail');
  });

  it('collects the pause contract so the worker fetches it', () => {
    expect(collectGradingPayloadRefs([contains], pausedRun())).toEqual(['ref:pause']);
  });
});

/**
 * State and trajectory, the two instruments a conversational subject could not
 * be graded through before: every desk tool is `api.http.call`, so an ops check
 * cannot name an endpoint, and a task that pauses produces no run output. What
 * is left is reply text, which is brittle in the direction that matters — a
 * paraphrase walks through a `not_contains` and scores as good behaviour.
 */
describe('simulation expectations', () => {
  const CALLS = [
    {
      simulationId: 'cs-desk',
      endpointId: 'payments_search',
      responseStatus: 200,
      responseRef: 'ref:search',
      deltaRef: null,
      ordinal: 0,
    },
    {
      simulationId: 'cs-desk',
      endpointId: 'handover_start',
      responseStatus: 200,
      responseRef: 'ref:handover',
      deltaRef: 'ref:handover-delta',
      ordinal: 1,
    },
  ];
  const SIM_PAYLOADS = new Map<string, unknown>([
    ['ref:search', { status: 'no_match' }],
    ['ref:handover', { status: 'started' }],
    ['ref:handover-delta', { mutations: [{ collection: 'handover_cases', op: 'create' }] }],
  ]);

  function simRun(calls = CALLS): GradableRunRecord {
    return completedRun({ simulationCalls: calls });
  }

  function gradeSim(expectations: CaseExpectation[], run: GradableRunRecord = simRun()) {
    return gradeCaseTrial({
      expectations,
      rubrics: [],
      fixtureTier: 'sealed',
      run,
      payloads: new Map([...PAYLOADS, ...SIM_PAYLOADS]),
    });
  }

  it('sees which endpoint was reached', () => {
    const hit = gradeSim([
      { kind: 'simulation', check: { op: 'called', endpointId: 'payments_search', expect: 'any' } },
    ]);
    expect(hit.verdict).toBe('pass');

    const miss = gradeSim([
      { kind: 'simulation', check: { op: 'called', endpointId: 'order_inspect', expect: 'any' } },
    ]);
    expect(miss.verdict).toBe('fail');
  });

  it('distinguishes the outcome a call returned, not merely that it happened', () => {
    const right = gradeSim([
      {
        kind: 'simulation',
        check: { op: 'called', endpointId: 'payments_search', status: 'no_match', expect: 'any' },
      },
    ]);
    expect(right.verdict).toBe('pass');

    // Same endpoint, different outcome: reaching it is not the assertion.
    const wrong = gradeSim([
      {
        kind: 'simulation',
        check: { op: 'called', endpointId: 'payments_search', status: 'matches', expect: 'any' },
      },
    ]);
    expect(wrong.verdict).toBe('fail');
  });

  it('grades what the run left behind, which a reply cannot be trusted about', () => {
    const opened = gradeSim([
      {
        kind: 'simulation',
        check: { op: 'mutated', collection: 'handover_cases', expect: 'any' },
      },
    ]);
    expect(opened.verdict).toBe('pass');

    // The load-bearing direction: "it did not actually open a case" is
    // unfakeable here and merely unsaid in the reply.
    const mustNot = gradeSim([
      {
        kind: 'simulation',
        check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
      },
    ]);
    expect(mustNot.verdict).toBe('fail');

    const readOnly = gradeSim(
      [
        {
          kind: 'simulation',
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ],
      simRun([CALLS[0]!]),
    );
    expect(readOnly.verdict).toBe('pass');
  });

  it('narrows to one kind of change', () => {
    const updated = gradeSim([
      {
        kind: 'simulation',
        check: { op: 'mutated', collection: 'handover_cases', change: 'update', expect: 'any' },
      },
    ]);
    expect(updated.verdict).toBe('fail');
  });

  it('refuses a negative assertion over an empty journal', () => {
    // The failure this guards shipped and was caught on its first run: the
    // journal was queried by the wrong identifier, came back empty, and six
    // `expect: 'none'` checks passed on no evidence at all.
    const answer = gradeCaseTrial({
      expectations: [
        {
          kind: 'simulation',
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ],
      rubrics: [],
      fixtureTier: 'sealed',
      run: completedRun({ simulationCalls: [] }),
      payloads: PAYLOADS,
    });
    expect(answer.verdict).toBe('fail');
    expect(answer.results.expectationResults[0]?.detail).toContain('journalled no simulated calls');
  });

  it('fails rather than skips when the run faced no simulation', () => {
    // A case asserting on a world the run never had is measuring nothing, and
    // scoring it as a pass would credit the subject for the absence.
    const answer = gradeCaseTrial({
      expectations: [
        {
          kind: 'simulation',
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ],
      rubrics: [],
      fixtureTier: 'live',
      run: completedRun(),
      payloads: PAYLOADS,
    });
    expect(answer.verdict).toBe('fail');
    expect(answer.results.expectationResults[0]?.detail).toContain('journalled no simulated calls');
  });

  it('prefetches the payloads its checks read', () => {
    const refs = collectGradingPayloadRefs(
      [
        {
          kind: 'simulation',
          check: { op: 'called', endpointId: 'payments_search', status: 'no_match', expect: 'any' },
        },
        {
          kind: 'simulation',
          check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
        },
      ],
      simRun(),
    );
    expect(refs).toContain('ref:search');
    expect(refs).toContain('ref:handover-delta');
  });
});
