/**
 * Golden-case authoring checks (Plan 269 D1): a case must be DECIDABLE (every
 * expectation references tasks/fields the pinned revision's contracts actually
 * produce — the eval_field_not_produced machinery, applied to case
 * expectations) and SOLVABLE (regression-tier cases carry evidence a passing
 * run exists). Rules are diagnostics, not parse failures, so draft cases
 * remain storable while incomplete; activation gates on the error set.
 *
 * The workflow argument must be the MATERIALIZED task list (Plan 190 — the
 * executed artifact is always the derived one).
 */
import {
  getOperation,
  type GoldenCaseContent,
  type GoldenCaseDiagnostic,
  type OutputExpectation,
  type WorkflowTask,
} from '@aflow/schemas';
import { taskDeclaredMetrics, taskDeclaredOutput } from './skillValidity/skillValidity.js';
import { deriveCaseCoverage } from '@aflow/schemas';

import { CONTAINS_RESERVED_FIELDS } from './evalRunnerCriterion.js';
import { findPolarityMismatches, runDeterministicGate } from './mutationGate.js';

export interface GoldenCaseWorkflowContext {
  /** Materialized tasks of the workflow revision the case runs against. */
  tasks: WorkflowTask[];
}

/**
 * The mutation gate, coverage and polarity, run where a case is authored.
 *
 * Authoring is the only moment these are cheap to fix and the only moment
 * before a batch pays to run the case. A gate that lived in a library and was
 * called by nothing would prove checks can fail without any case ever having to
 * pass it.
 */
function appendGateDiagnostics(goldenCase: GoldenCaseContent, out: GoldenCaseDiagnostic[]): void {
  for (const id of deriveCaseCoverage({
    requirements: goldenCase.requirements,
    expectations: goldenCase.expectations,
    rubrics: goldenCase.rubrics,
  }).uncovered) {
    const requirement = goldenCase.requirements.find((r) => r.id === id);
    out.push({
      code: 'case_requirement_uncovered',
      // Advisory, not an error: a case may legitimately be authored before its
      // checks, and refusing the write would make the requirement impossible to
      // record first. It is never silence, which is the part that matters.
      severity: 'advisory',
      detail: `Nothing checks '${requirement?.statement ?? id}'. The case states it and no expectation or rubric claims it, so a run violating it would still pass.`,
      fixHint: `Add \`claims: ['${id}']\` to the check that would catch it, or drop the requirement.`,
    });
  }

  for (const mismatch of findPolarityMismatches(goldenCase)) {
    out.push({
      code: 'case_requirement_polarity',
      severity: 'error',
      expectationIndex: mismatch.checkIndex,
      detail: `${mismatch.detail}. The check can fail, but it fails when the requirement is MET.`,
      fixHint:
        'Flip the check to assert the direction the requirement states, or claim a different requirement.',
    });
  }

  const report = runDeterministicGate({ expectations: goldenCase.expectations });

  // The gate marks these unsupported and sets `passed` false; discarding that
  // let a case through the write path with no proof its checks can fail, which
  // is the contract the gate exists to enforce.
  for (const kind of report.unsupported) {
    out.push({
      code: 'case_check_never_fails',
      severity: 'advisory',
      detail: `A '${kind}' check cannot be exercised by the authoring gate — it needs a task graph or a produced output that no synthetic run can invent, so nothing here proves it can fail.`,
      fixHint:
        'Cover the same requirement with a world, reply or terminal check as well, or accept that this one is unproven until a batch runs.',
    });
  }

  if (!report.referencePasses) {
    out.push({
      code: 'case_reference_fails',
      severity: 'error',
      detail: `No run can satisfy these checks together: ${report.referenceFailures.join('; ')}.`,
      fixHint:
        'Two checks are contradicting each other, or one asserts something no run of this case produces.',
    });
    // A rejection means nothing while the reference fails, so the per-check
    // findings below would be noise rather than evidence.
    return;
  }

  for (const witness of report.witnesses.filter((w) => !w.rejected)) {
    out.push({
      code: 'case_check_never_fails',
      severity: 'error',
      expectationIndex: witness.targets,
      detail: `This check accepts ${witness.describes}, so it accepts the defect it exists to catch and can never fail.${witness.attributedElsewhere !== undefined ? ` Another check caught it, which is not evidence this one works — the case would pass with this check deleted.` : ''}`,
      fixHint:
        'Narrow the check — by record, by written value, or by count — until the defect is rejected.',
    });
  }
}

export function validateGoldenCase(
  goldenCase: GoldenCaseContent,
  workflow: GoldenCaseWorkflowContext,
): GoldenCaseDiagnostic[] {
  const out: GoldenCaseDiagnostic[] = [];
  appendGateDiagnostics(goldenCase, out);
  const taskById = new Map(workflow.tasks.map((t) => [t.taskId, t] as const));
  const taskIdList = [...taskById.keys()].join(', ') || '(none)';

  // A case needs something that can grade it — not a deterministic check
  // specifically. A judge decides as a check decides, and the two answer
  // different questions: whether the world changed, and whether what was said
  // to a person was honest. A case measuring only the second is a real case.
  // What cannot be graded is a case carrying neither.
  if (goldenCase.expectations.length === 0 && goldenCase.rubrics.length === 0) {
    out.push({
      code: 'case_no_checks',
      severity: 'error',
      detail:
        'The case carries neither a deterministic expectation nor a rubric, so no trial of it ' +
        'can reach a verdict — it would pay for the full run and measure nothing.',
      fixHint:
        'Add a deterministic expectation (terminal, task_status, output or trajectory), a rubric, ' +
        'or both.',
    });
  }

  if (goldenCase.stratum.tier === 'regression' && goldenCase.fixture.tier === 'live') {
    out.push({
      code: 'case_live_fixture_regression_tier',
      severity: 'error',
      detail:
        'A live-context fixture runs against current space state, so its verdicts are quality ' +
        'signal, not regression signal — live fixtures are allowed only for capability-tier cases.',
      fixHint: "Seed the fixture (tier: 'seeded') or move the case to the capability tier.",
    });
  }

  // Solvability evidence is a run that exhibited the EXPECTED behavior: a
  // completed originating run, or a paused one when pausing IS the expected
  // behavior. A failed originating run is the counterexample the case exists
  // to prevent — never evidence the case is solvable.
  const provenance = goldenCase.provenance;
  const originatingRunIsSolvabilityEvidence =
    provenance.runId !== undefined &&
    (provenance.runStatus === 'completed' ||
      (provenance.runStatus === 'paused' && goldenCase.stratum.direction === 'should_pause'));
  if (
    goldenCase.stratum.tier === 'regression' &&
    provenance.referenceOutputRef === undefined &&
    !originatingRunIsSolvabilityEvidence
  ) {
    out.push({
      code: 'case_missing_solvability_evidence',
      severity: 'error',
      detail:
        'Regression-tier cases must carry evidence the case is solvable: a ' +
        'provenance.referenceOutputRef (known-good output), or an originating run that exhibited ' +
        'the expected behavior (runStatus completed, or paused for a should_pause case). A failed ' +
        'originating run is the counterexample, not solvability evidence.',
      fixHint:
        'Record the passing run the case was promoted from, attach a reference output, or ' +
        'move the case to the capability tier until one exists.',
    });
  }

  goldenCase.expectations.forEach((expectation, expectationIndex) => {
    switch (expectation.kind) {
      case 'terminal': {
        if (expectation.pausedTaskId !== undefined && !taskById.has(expectation.pausedTaskId)) {
          out.push({
            code: 'case_unknown_task',
            severity: 'error',
            expectationIndex,
            taskId: expectation.pausedTaskId,
            detail: `Terminal expectation pauses at unknown taskId '${expectation.pausedTaskId}'. Valid taskIds: ${taskIdList}.`,
          });
        }
        break;
      }
      case 'task_status': {
        if (!taskById.has(expectation.taskId)) {
          out.push({
            code: 'case_unknown_task',
            severity: 'error',
            expectationIndex,
            taskId: expectation.taskId,
            detail: `task_status expectation references unknown taskId '${expectation.taskId}'. Valid taskIds: ${taskIdList}.`,
          });
        }
        break;
      }
      case 'output': {
        appendOutputDiagnostics(expectation, expectationIndex, taskById, taskIdList, out);
        break;
      }
      case 'reply': {
        appendPatternDiagnostics(expectation.check.pattern, expectationIndex, out);
        // taskId is optional — omitted means whichever task the run paused on.
        if (expectation.taskId !== undefined && !taskById.has(expectation.taskId)) {
          out.push({
            code: 'case_unknown_task',
            severity: 'error',
            expectationIndex,
            taskId: expectation.taskId,
            detail: `reply expectation references unknown taskId '${expectation.taskId}'. Valid taskIds: ${taskIdList}.`,
          });
        }
        break;
      }
      case 'trajectory': {
        const check = expectation.check;
        if (!('op' in check)) break; // trace_bound — metric enum, nothing to resolve
        for (const operationId of check.operationIds) {
          if (getOperation(operationId) !== undefined) continue;
          const required = check.op === 'required_ops';
          out.push({
            code: 'case_unknown_operation',
            severity: required ? 'error' : 'advisory',
            expectationIndex,
            operationId,
            detail: required
              ? `required_ops names unknown operation '${operationId}' — no run can ever satisfy it.`
              : `forbidden_ops names unknown operation '${operationId}' — the check can never fire.`,
            fixHint: 'Use a registered operation id (buildOperationId over the catalog).',
          });
        }
        break;
      }
      case 'simulation': {
        // A simulation check names an endpoint or a collection in the world the
        // fixture binds, not a task or an operation in this skill, so there is
        // nothing here to resolve against the graph. It is listed so the switch
        // stays exhaustive and a future expectation kind cannot slip through
        // unexamined.
        break;
      }
    }
  });

  appendDirectionDiagnostics(goldenCase, out);

  // A sealed fixture that does not pin the clock is sealed in the rows only.
  // Advisory rather than error: a world with no relative dates is unaffected,
  // and only its author knows which kind it is.
  if (goldenCase.fixture.tier === 'sealed' && goldenCase.fixture.clockAnchor === undefined) {
    out.push({
      code: 'case_unpinned_clock',
      severity: 'advisory',
      detail:
        'This sealed fixture pins its world but not the instant it is read at, so any seed data authored relative to a clock ages between runs — a refund passes its deadline, "today" moves, and the case starts measuring the calendar rather than the agent. Set fixture.clockAnchor to the instant the case is set at.',
    });
  }

  return out;
}

function appendOutputDiagnostics(
  expectation: OutputExpectation,
  expectationIndex: number,
  taskById: ReadonlyMap<string, WorkflowTask>,
  taskIdList: string,
  out: GoldenCaseDiagnostic[],
): void {
  // Run-scoped outputs have no closed static field set (they are promoted state
  // variables) — absence is unprovable, so only task-scoped checks are checked.
  if (expectation.scope === 'run') return;

  const taskId = expectation.scope.taskId;
  const task = taskById.get(taskId);
  if (!task) {
    out.push({
      code: 'case_unknown_task',
      severity: 'error',
      expectationIndex,
      taskId,
      detail: `Output expectation references unknown taskId '${taskId}'. Valid taskIds: ${taskIdList}.`,
    });
    return;
  }

  const check = expectation.check;
  let field: string;
  if ('type' in check) {
    if (check.type === 'contains') {
      if (CONTAINS_RESERVED_FIELDS.has(check.inField)) return;
      field = check.inField;
    } else {
      field = check.metric;
    }
  } else if (check.op === 'not_contains') {
    if (CONTAINS_RESERVED_FIELDS.has(check.inField)) return;
    field = check.inField;
  } else if (check.op === 'equals') {
    field = check.path.split('.')[0] ?? check.path;
  } else {
    return; // json_schema — validated against the whole payload at grade time
  }

  const declared = taskDeclaredOutput(task);
  // No declared shape, or an OPEN shape — the field may exist at runtime, so
  // absence is unprovable. Skip (don't false-flag).
  if (!declared?.closed) return;
  const metrics = taskDeclaredMetrics(task);
  if (declared.fields.has(field) || metrics.has(field)) return;

  out.push({
    code: 'case_field_not_produced',
    severity: 'error',
    expectationIndex,
    taskId,
    field,
    detail:
      `Output check binds to field '${field}', but task '${taskId}' has a closed declared output ` +
      `producing only: ${[...declared.fields].sort().join(', ') || '(none)'}` +
      `${metrics.size > 0 ? ` (metrics: ${[...metrics].sort().join(', ')})` : ''}. ` +
      `The expectation can never pass against this revision.`,
    fixHint: `Bind the check to a declared output field, or repair the case against the current revision.`,
  });
}

function appendDirectionDiagnostics(
  goldenCase: GoldenCaseContent,
  out: GoldenCaseDiagnostic[],
): void {
  const terminals = goldenCase.expectations.filter((e) => e.kind === 'terminal');
  const direction = goldenCase.stratum.direction;

  if (direction === 'should_pause' && !terminals.some((t) => t.runStatus === 'paused')) {
    out.push({
      code: 'case_direction_terminal_mismatch',
      severity: 'advisory',
      detail:
        "direction is 'should_pause' but no terminal expectation asserts runStatus 'paused' — " +
        'the pause that IS the correct behavior goes ungraded.',
      fixHint: "Add { kind: 'terminal', runStatus: 'paused', pausedReason, pausedTaskId }.",
    });
  }
  if (direction === 'should_succeed' && terminals.some((t) => t.runStatus !== 'completed')) {
    out.push({
      code: 'case_direction_terminal_mismatch',
      severity: 'advisory',
      detail:
        "direction is 'should_succeed' but a terminal expectation asserts a non-completed " +
        'runStatus — the direction and the grading spec disagree.',
      fixHint: 'Align stratum.direction with the asserted terminal state.',
    });
  }
}

/**
 * A pattern that does not compile is refused here rather than at grading.
 *
 * The grader falls back to a literal substring test when a regex will not
 * compile, and that fallback is silent in the direction that scores: a broken
 * `contains` fails forever and a broken `not_contains` PASSES forever, on a
 * comparison that never ran. Both read as measurements. The commonest way in is
 * the inline `(?i)` flag, which several regex dialects take and JavaScript does
 * not — and which is unnecessary here, since reply matching is already
 * case-insensitive.
 */
function appendPatternDiagnostics(
  pattern: string,
  expectationIndex: number,
  out: GoldenCaseDiagnostic[],
): void {
  try {
    new RegExp(pattern, 'i');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    out.push({
      code: 'case_uncompilable_pattern',
      severity: 'error',
      expectationIndex,
      detail:
        `The pattern ${JSON.stringify(pattern)} is not a valid regular expression: ${reason}. ` +
        'Matching is already case-insensitive, so an inline `(?i)` is both unsupported and unnecessary — drop it.',
    });
  }
}
