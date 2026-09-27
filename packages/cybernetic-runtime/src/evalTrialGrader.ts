/**
 * Deterministic trial grader (Plan 269 D3/D6): grade(caseExpectations,
 * runRecord) as a pure function — same persisted run in, byte-identical
 * verdicts out. No clock, no randomness, no IO: the worker prefetches every
 * payload the expectations reference (`collectGradingPayloadRefs`) and the
 * grader decides from the snapshot alone. Judge rubrics are NOT executed
 * here — they are recorded as pending slots for the P3 judge pipeline, and
 * a deterministic failure is `fail` regardless of any future judge score.
 */
import AjvModule from 'ajv';
import type {
  CaseExpectation,
  CaseRubric,
  ContextFixtureTier,
  EvalCaseRubricResult,
  EvalCaseTrialResults,
  EvalCaseTrialVerdict,
  EvalCriterion,
  ExpectationResult,
  OutputExpectation,
  ReplyExpectation,
  SimulationExpectation,
  SimulationMutationTimes,
  TerminalExpectation,
  ThresholdCriterion,
  ThresholdOperator,
  TrajectoryExpectation,
  TrialAxes,
  TrialExecutionState,
  TrialOutcome,
  TrialQualityUnverifiedReason,
} from '@aflow/schemas';
import {
  EvalCaseTrialResultsSchema,
  THRESHOLD_OPERATORS,
  isCampaignRef,
  resolveCampaignEnumParam,
  resolveCampaignNumberParam,
  classifyTrialOutcome,
} from '@aflow/schemas';
import { resolveJsonPointer } from '@aflow/applet-runtime';
import { evaluateCriterion } from './evalRunnerCriterion.js';

/** Frozen into each batch's provenance manifest; bump on any grading-behavior change. */
export const EVAL_TRIAL_GRADER_VERSION = 'det-4';

const AjvCtor = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as unknown as new (opts?: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};

// ============================================================================
// Run record — the persisted facts the grader decides from
// ============================================================================

export interface GradableTaskRecord {
  taskId: string;
  status: string;
  operationId: string | null;
  outputRef: string | null;
  summary?: string | null;
  metrics?: Record<string, unknown> | null;
  durationMs?: number | null;
  costCents?: number | null;
  completedAtMs?: number | null;
}

/**
 * One call an agent made against a simulated integration, as the journal
 * recorded it. Refs rather than bodies: the worker prefetches every payload the
 * expectations name, so the grader stays a pure function over a snapshot.
 */
export interface GradableSimulationCall {
  simulationId: string;
  endpointId: string;
  responseStatus: number;
  responseRef: string | null;
  deltaRef: string | null;
  ordinal: number;
}

export interface GradableRunRecord {
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  pausedReason: string | null;
  /**
   * The pause contract the run stopped on. A conversational subject's answer
   * lives here rather than in a task output, and it survives the trial being
   * cancelled, which is how a paused trial gets graded at all.
   */
  pausedPayloadRef?: string | null;
  failureReason?: string | null;
  tasks: readonly GradableTaskRecord[];
  /** Case-declared campaign config for resolving `$campaign` check params. */
  campaignConfig?: Record<string, unknown> | undefined;
  /**
   * Every simulated call this run made, oldest first. Absent for a run against
   * no simulation — which a `simulation` expectation grades as failed rather
   * than skipped, because a case asserting on a world the run never had is a
   * case measuring nothing.
   */
  simulationCalls?: readonly GradableSimulationCall[] | undefined;
  /**
   * What execution observed, stamped at the source. Absent on runs recorded
   * before execution carried it, where `deriveExecutionState` falls back to
   * reading the artifacts — a fallback that cannot see a turn which produced
   * no usable output, and which any placeholder pause prompt defeats.
   */
  executionState?: TrialExecutionState | undefined;
}

/** Run-scope output = the last output-producing task (the miner's convention). */
function selectRunScopeOutputTask(
  tasks: readonly GradableTaskRecord[],
): GradableTaskRecord | undefined {
  return [...tasks]
    .filter((t) => typeof t.outputRef === 'string' && t.outputRef.length > 0)
    .sort((a, b) => (a.completedAtMs ?? 0) - (b.completedAtMs ?? 0))
    .at(-1);
}

function resolveOutputScopeTask(
  expectation: OutputExpectation,
  run: GradableRunRecord,
): GradableTaskRecord | undefined {
  if (expectation.scope === 'run') return selectRunScopeOutputTask(run.tasks);
  const { taskId } = expectation.scope;
  return run.tasks.find((t) => t.taskId === taskId);
}

/**
 * Every payload ref the expectations will need: output payloads for
 * output-scoped checks plus JSON-Schema payloads. The worker fetches these;
 * a ref absent from the map grades its expectation as failed (the run's
 * record is incomplete — D6's run-terminal coverage rule, never a skip).
 */
export function collectGradingPayloadRefs(
  expectations: readonly CaseExpectation[],
  run: GradableRunRecord,
): string[] {
  const refs = new Set<string>();
  // A paused run's answer is fetched whether or not an expectation names it:
  // the rubric judges read the same artifact, and a case may assert on the
  // reply through a rubric alone.
  if (run.pausedPayloadRef) refs.add(run.pausedPayloadRef);
  // Every simulated response, for the same reason one level down: a judge
  // asked whether an answer is ACCURATE cannot decide it from the answer, and
  // a judge given only the answer reads a correct fact it cannot corroborate
  // as an invented one.
  for (const call of run.simulationCalls ?? []) {
    if (call.responseRef) refs.add(call.responseRef);
  }
  for (const expectation of expectations) {
    if (expectation.kind === 'reply') continue;
    if (expectation.kind === 'simulation') {
      // A `called` check with a status reads the response body; a `mutated`
      // check reads the delta. Both ride the same prefetch every other
      // expectation uses, which is what keeps the grader free of IO.
      for (const call of run.simulationCalls ?? []) {
        if (expectation.check.op === 'called' && call.responseRef) refs.add(call.responseRef);
        if (expectation.check.op === 'mutated' && call.deltaRef) refs.add(call.deltaRef);
      }
      continue;
    }
    if (expectation.kind !== 'output') continue;
    const task = resolveOutputScopeTask(expectation, run);
    if (task?.outputRef) refs.add(task.outputRef);
    if ('op' in expectation.check && expectation.check.op === 'json_schema') {
      refs.add(expectation.check.schemaRef);
    }
  }
  return [...refs];
}

// ============================================================================
// Expectation grading
// ============================================================================

function result(
  index: number,
  kind: ExpectationResult['kind'],
  passed: boolean,
  detail?: string,
): ExpectationResult {
  return { expectationIndex: index, kind, passed, ...(detail !== undefined ? { detail } : {}) };
}

function gradeTerminal(
  index: number,
  expectation: TerminalExpectation,
  run: GradableRunRecord,
): ExpectationResult {
  if (run.status !== expectation.runStatus) {
    return result(
      index,
      'terminal',
      false,
      `expected run status '${expectation.runStatus}', observed '${run.status}'` +
        (run.failureReason ? ` (${run.failureReason})` : ''),
    );
  }
  if (expectation.pausedReason !== undefined && run.pausedReason !== expectation.pausedReason) {
    return result(
      index,
      'terminal',
      false,
      `expected pausedReason '${expectation.pausedReason}', observed '${String(run.pausedReason)}'`,
    );
  }
  if (expectation.pausedTaskId !== undefined) {
    const paused = run.tasks.some(
      (t) => t.taskId === expectation.pausedTaskId && t.status === 'paused',
    );
    if (!paused) {
      return result(
        index,
        'terminal',
        false,
        `expected task '${expectation.pausedTaskId}' to be the paused task`,
      );
    }
  }
  return result(index, 'terminal', true);
}

function fieldValueFrom(
  fieldName: string,
  output: Record<string, unknown> | undefined,
  metrics: Record<string, unknown> | undefined,
  summary: string | undefined,
): unknown {
  if (fieldName === 'summary' && summary !== undefined) return summary;
  const fromOutput = output?.[fieldName];
  if (fromOutput !== undefined && fromOutput !== null) return fromOutput;
  return metrics?.[fieldName];
}

function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Patterns are regexes, falling back to substring when one does not compile. */
/**
 * Case-INSENSITIVE by construction, because every text this matches is natural
 * language a model wrote and no author means "only if it capitalised it that
 * way". Authors reached for the inline `(?i)` JavaScript does not support, it
 * threw, and the catch below turned a regex into a literal substring test that
 * could never match — so `contains` always failed and `not_contains` always
 * passed on nothing. A vacuous pass is the failure this whole grader exists to
 * avoid, so the flag is applied here and an uncompilable pattern is refused at
 * authoring (`case_uncompilable_pattern`) rather than reaching this fallback.
 */
function matchesPattern(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/** The envelope outcome a simulated call returned, when it carried one. */
function envelopeStatusOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const status = (payload as { status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
}

/** Collections a call changed, from its committed delta. */
interface JournalledMutation {
  collection: string;
  op: string;
  entityId?: string;
  body?: Record<string, unknown>;
}

/**
 * The journal records which record changed and what it now holds. Reducing a
 * mutation to its collection and op discarded exactly the fields that separate
 * the right write from the wrong one.
 */
function mutationsOf(payload: unknown): JournalledMutation[] {
  const source = Array.isArray(payload)
    ? payload
    : (payload as { mutations?: unknown } | null)?.mutations;
  if (!Array.isArray(source)) return [];
  const out: JournalledMutation[] = [];
  for (const entry of source) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { collection, op, entityId, body } = entry as {
      collection?: unknown;
      op?: unknown;
      entityId?: unknown;
      body?: unknown;
    };
    if (typeof collection !== 'string' || typeof op !== 'string') continue;
    const mutation: JournalledMutation = { collection, op };
    if (typeof entityId === 'string') mutation.entityId = entityId;
    if (typeof body === 'object' && body !== null) {
      mutation.body = body as Record<string, unknown>;
    }
    out.push(mutation);
  }
  return out;
}

/**
 * A written value read by the same whole-pointer grammar a world query uses.
 * Scalars compare stringwise because an id the agent typed arrives as a string
 * where the world seeded a number, and refusing that would make every id
 * assertion miss.
 */
function writtenValueMatches(mutation: JournalledMutation, path: string, want: unknown): boolean {
  const resolved = resolveJsonPointer(mutation.body ?? {}, path);
  if (!resolved.found) return false;
  const held = resolved.value;
  if (held === want) return true;
  const scalar = (v: unknown): v is string | number | boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  return scalar(held) && scalar(want) && String(held) === String(want);
}

/** Whether a count of matching changes satisfies the case's claim. */
function timesSatisfied(count: number, times: SimulationMutationTimes): boolean {
  if (times.exactly !== undefined) return count === times.exactly;
  if (times.atLeast !== undefined && count < times.atLeast) return false;
  if (times.atMost !== undefined && count > times.atMost) return false;
  return true;
}

function gradeSimulation(
  index: number,
  expectation: SimulationExpectation,
  run: GradableRunRecord,
  payloads: ReadonlyMap<string, unknown>,
): ExpectationResult {
  const label = expectation.name ?? expectation.check.op;

  // A run that faced no simulation cannot satisfy a claim about one. Grading it
  // as a skip would let a case about a world quietly score on a run that never
  // had that world.
  // Fails BOTH directions, `expect: 'none'` included. A negative assertion over
  // a journal that recorded nothing is vacuous — it would credit the subject
  // for restraint it never exercised, and it reads as a measurement. This is
  // the same rule a missing reply gets, and it was written after the first
  // version of this check passed six `none` assertions against a journal it was
  // querying by the wrong identifier.
  if (run.simulationCalls === undefined || run.simulationCalls.length === 0) {
    return result(
      index,
      'simulation',
      false,
      `${label}: this run journalled no simulated calls, so nothing about its world can be asserted`,
    );
  }
  const calls = run.simulationCalls.filter(
    (call) =>
      expectation.simulationId === undefined || call.simulationId === expectation.simulationId,
  );

  if (expectation.check.op === 'called') {
    const { endpointId, status, expect } = expectation.check;
    const hits = calls.filter((call) => {
      if (call.endpointId !== endpointId) return false;
      if (status === undefined) return true;
      return (
        envelopeStatusOf(call.responseRef ? payloads.get(call.responseRef) : undefined) === status
      );
    });
    const found = hits.length > 0;
    const wanted = expect === 'any';
    const what = status === undefined ? endpointId : `${endpointId} → ${status}`;
    return result(
      index,
      'simulation',
      found === wanted,
      `${label}: ${what} was ${found ? `called ${String(hits.length)}×` : 'never called'}`,
    );
  }

  const { collection, change, expect, entityId, where, times } = expectation.check;
  const hits = calls.flatMap((call) =>
    mutationsOf(call.deltaRef ? payloads.get(call.deltaRef) : undefined).filter((mutation) => {
      if (mutation.collection !== collection) return false;
      if (change !== undefined && mutation.op !== change) return false;
      if (entityId !== undefined && mutation.entityId !== entityId) return false;
      if (where !== undefined) {
        return where.every((predicate) =>
          writtenValueMatches(mutation, predicate.path, predicate.value),
        );
      }
      return true;
    }),
  );

  const narrowing: string[] = [];
  if (change !== undefined) narrowing.push(change);
  if (entityId !== undefined) narrowing.push(`on ${entityId}`);
  if (where !== undefined) {
    narrowing.push(`where ${where.map((p) => `${p.path}=${String(p.value)}`).join(', ')}`);
  }
  const what = narrowing.length > 0 ? `${narrowing.join(' ')} in ${collection}` : collection;

  if (times !== undefined) {
    const wantText =
      times.exactly !== undefined
        ? `exactly ${String(times.exactly)}`
        : [
            times.atLeast !== undefined ? `at least ${String(times.atLeast)}` : null,
            times.atMost !== undefined ? `at most ${String(times.atMost)}` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' and ');
    return result(
      index,
      'simulation',
      timesSatisfied(hits.length, times),
      `${label}: ${what} changed ${String(hits.length)}×, expected ${wantText}`,
    );
  }

  const found = hits.length > 0;
  const wanted = expect === 'any';
  return result(
    index,
    'simulation',
    found === wanted,
    `${label}: ${what} ${found ? `changed ${String(hits.length)}×` : 'was never changed'}`,
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

type MaterializeOutcome = { ok: true; criterion: EvalCriterion } | { ok: false; reason: string };

/** Replace `$campaign` refs in a threshold check from the case's own config. */
function materializeThresholdCheck(
  check: ThresholdCriterion,
  campaignConfig: Record<string, unknown>,
): MaterializeOutcome {
  if (!isCampaignRef(check.operator) && !isCampaignRef(check.target)) {
    return { ok: true, criterion: check as EvalCriterion };
  }
  const operator = resolveCampaignEnumParam<ThresholdOperator>(
    check.operator,
    campaignConfig,
    THRESHOLD_OPERATORS,
  );
  if (!operator.ok) return { ok: false, reason: `operator: ${operator.reason}` };
  const target = resolveCampaignNumberParam(check.target, campaignConfig);
  if (!target.ok) return { ok: false, reason: `target: ${target.reason}` };
  return {
    ok: true,
    criterion: { ...check, operator: operator.value, target: target.value } as EvalCriterion,
  };
}

function gradeOutput(
  index: number,
  expectation: OutputExpectation,
  run: GradableRunRecord,
  payloads: ReadonlyMap<string, unknown>,
): ExpectationResult {
  const task = resolveOutputScopeTask(expectation, run);
  const scopeLabel =
    expectation.scope === 'run' ? 'run output' : `task '${expectation.scope.taskId}' output`;
  if (!task) {
    return result(index, 'output', false, `${scopeLabel}: no such task produced an output`);
  }
  if (!task.outputRef) {
    return result(index, 'output', false, `${scopeLabel}: task produced no output`);
  }
  const rawOutput = payloads.get(task.outputRef);
  if (rawOutput === undefined) {
    return result(index, 'output', false, `${scopeLabel}: output payload unavailable`);
  }
  const output =
    rawOutput !== null && typeof rawOutput === 'object' && !Array.isArray(rawOutput)
      ? (rawOutput as Record<string, unknown>)
      : undefined;
  const metrics = task.metrics ?? undefined;
  const summary = task.summary ?? undefined;

  const check = expectation.check;
  if ('type' in check) {
    // ThresholdCriterion | ContainsCriterion — reuse the production evaluator.
    let criterion: EvalCriterion = check as EvalCriterion;
    if (check.type === 'threshold') {
      const materialized = materializeThresholdCheck(check, run.campaignConfig ?? {});
      if (!materialized.ok) {
        return result(
          index,
          'output',
          false,
          `${scopeLabel}: unresolved $campaign parameter — ${materialized.reason}`,
        );
      }
      criterion = materialized.criterion;
    }
    const evaluated = evaluateCriterion(criterion, {
      ...(output !== undefined ? { output } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
      ...(summary !== undefined ? { summary } : {}),
    });
    if (!evaluated) {
      return result(index, 'output', false, `${scopeLabel}: check kind could not be evaluated`);
    }
    return result(
      index,
      'output',
      evaluated.passed && evaluated.applicable !== false,
      `${scopeLabel}: ${evaluated.evidence ?? ''}`.trim(),
    );
  }

  switch (check.op) {
    case 'not_contains': {
      const raw = fieldValueFrom(check.inField, output, metrics, summary);
      // An absent field fails, and does not pass for having nothing in it. A
      // negative assertion over text that was never produced is vacuously true
      // and is not evidence: it would score a subject for staying silent, and
      // score it HIGHER than one that answered, since only an answer can
      // contain the forbidden thing. `contains` already fails here — this is
      // the same rule, stated once for both directions.
      if (raw === undefined) {
        return result(
          index,
          'output',
          false,
          `${scopeLabel}: field '${check.inField}' absent — nothing was produced to check`,
        );
      }
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const matched = matchesPattern(text, check.pattern);
      return result(
        index,
        'output',
        !matched,
        `${scopeLabel}: field '${check.inField}' ${matched ? 'matches forbidden' : 'is free of'} pattern '${check.pattern}'`,
      );
    }
    case 'json_schema': {
      const schema = payloads.get(check.schemaRef);
      if (schema === undefined || schema === null || typeof schema !== 'object') {
        return result(index, 'output', false, `${scopeLabel}: schema payload unavailable`);
      }
      try {
        const ajv = new AjvCtor({ allErrors: true, strict: false });
        const validate = ajv.compile(schema as Record<string, unknown>);
        const valid = validate(rawOutput);
        if (valid) return result(index, 'output', true, `${scopeLabel}: matches schema`);
        const issues = (validate.errors ?? [])
          .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`)
          .join('; ');
        return result(index, 'output', false, `${scopeLabel}: schema violations — ${issues}`);
      } catch (err) {
        return result(
          index,
          'output',
          false,
          `${scopeLabel}: schema did not compile — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    case 'equals': {
      const observed = valueAtPath(rawOutput, check.path);
      if (observed === undefined) {
        return result(index, 'output', false, `${scopeLabel}: path '${check.path}' not present`);
      }
      const passed = deepEqual(observed, check.value);
      return result(
        index,
        'output',
        passed,
        `${scopeLabel}: '${check.path}' = ${JSON.stringify(observed)}${passed ? '' : `, expected ${JSON.stringify(check.value)}`}`,
      );
    }
  }
}

/**
 * The reply a paused subject gave. The pause contract carries it as `prompt` —
 * the text the person is being shown while the run waits on them.
 */
/**
 * The customer-facing answer of a run that stopped on a pause contract.
 *
 * Exported because the judge must read the SAME artifact the reply
 * expectations do. Given only task outputs, a judge reads raw tool JSON, finds
 * no prose, and scores the case on an answer it was never shown.
 */
export function replyTextFrom(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const prompt = (payload as Record<string, unknown>)['prompt'];
  return typeof prompt === 'string' && prompt.length > 0 ? prompt : undefined;
}

function gradeReply(
  index: number,
  expectation: ReplyExpectation,
  run: GradableRunRecord,
  payloads: ReadonlyMap<string, unknown>,
): ExpectationResult {
  const label = `reply of ${expectation.taskId ? `task '${expectation.taskId}'` : 'the paused task'}`;

  if (expectation.taskId !== undefined) {
    const task = run.tasks.find((t) => t.taskId === expectation.taskId);
    if (!task) {
      return result(index, 'reply', false, `${label}: no such task in this run`);
    }
    if (task.status !== 'paused') {
      return result(index, 'reply', false, `${label}: task status '${task.status}', not paused`);
    }
  }

  if (!run.pausedPayloadRef) {
    return result(index, 'reply', false, `${label}: the run stopped on no pause contract`);
  }
  const payload = payloads.get(run.pausedPayloadRef);
  if (payload === undefined) {
    return result(index, 'reply', false, `${label}: pause contract unavailable`);
  }
  const reply = replyTextFrom(payload);
  // A missing reply fails BOTH directions. A `not_contains` that scores because
  // nothing was said would credit a subject for staying silent.
  if (reply === undefined) {
    return result(index, 'reply', false, `${label}: the pause carried no reply text`);
  }

  const matched = matchesPattern(reply, expectation.check.pattern);
  const wanted = expectation.check.op === 'contains';
  return result(
    index,
    'reply',
    matched === wanted,
    `${label}: '${expectation.name ?? expectation.check.pattern}' — reply ` +
      `${matched ? 'matches' : 'does not match'} pattern '${expectation.check.pattern}'`,
  );
}

function gradeTrajectory(
  index: number,
  expectation: TrajectoryExpectation,
  run: GradableRunRecord,
): ExpectationResult {
  const check = expectation.check;
  const observedOps = new Set(
    run.tasks.map((t) => t.operationId).filter((op): op is string => op !== null && op.length > 0),
  );

  if ('type' in check) {
    // TraceBoundCriterion — aggregate trace metrics over the task rows.
    const aggregateMetrics = {
      stepCount: run.tasks.length,
      durationMs: run.tasks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0),
      costCents: run.tasks.reduce((sum, t) => sum + (t.costCents ?? 0), 0),
    };
    const evaluated = evaluateCriterion(check as EvalCriterion, { aggregateMetrics });
    if (!evaluated) {
      return result(index, 'trajectory', false, 'trace bound could not be evaluated');
    }
    return result(
      index,
      'trajectory',
      evaluated.passed && evaluated.applicable !== false,
      evaluated.evidence,
    );
  }

  if (check.op === 'required_ops') {
    const missing = check.operationIds.filter((op) => !observedOps.has(op));
    return result(
      index,
      'trajectory',
      missing.length === 0,
      missing.length === 0
        ? 'every required operation was used'
        : `required operations never used: ${missing.join(', ')}`,
    );
  }
  const hits = check.operationIds.filter((op) => observedOps.has(op));
  return result(
    index,
    'trajectory',
    hits.length === 0,
    hits.length === 0
      ? 'no forbidden operation was used'
      : `forbidden operations used: ${hits.join(', ')}`,
  );
}

// ============================================================================
// The grade
// ============================================================================

export interface TrialGrade {
  verdict: EvalCaseTrialVerdict;
  results: EvalCaseTrialResults;
}

/**
 * The slot a rubric occupies. Exported because the gating set is built from the
 * CASE's rubrics rather than from the results: a slot that reached neither a
 * result nor the pending list — because a shared name was drained by another
 * scope's result — would otherwise vanish from the gate entirely and let the
 * trial pass unjudged.
 */
export function rubricSlotName(rubric: CaseRubric): string {
  return rubric.kind === 'suite_criterion' ? rubric.criterionId : rubric.criterion.name;
}

/**
 * A rubric slot's full identity, scope included.
 *
 * `rubricSlotName` is the NAME, and results are identified by
 * `(criterionId, scopeKey)`. Two suite criteria sharing a name at different
 * scopes are different judges: keyed by name alone they collapse into one, and
 * a trial whose budget dispatched only the first would pass on a single answer
 * while the second judge never ran.
 */
export function rubricSlotKey(rubric: CaseRubric): string {
  const scope = rubric.kind === 'suite_criterion' ? (rubric.scopeKey ?? 'suite') : 'case_local';
  return `${scope}\u0000${rubricSlotName(rubric)}`;
}

/** The same identity, from a recorded result. */
export function resultSlotKey(result: { criterionId: string; scopeKey: string }): string {
  return `${result.scopeKey}\u0000${result.criterionId}`;
}

export function gradeCaseTrial(params: {
  expectations: readonly CaseExpectation[];
  rubrics: readonly CaseRubric[];
  fixtureTier: ContextFixtureTier;
  run: GradableRunRecord;
  payloads: ReadonlyMap<string, unknown>;
}): TrialGrade {
  const { expectations, rubrics, fixtureTier, run, payloads } = params;

  const expectationResults: ExpectationResult[] = expectations.map((expectation, index) => {
    switch (expectation.kind) {
      case 'terminal':
        return gradeTerminal(index, expectation, run);
      case 'task_status': {
        const task = run.tasks.find((t) => t.taskId === expectation.taskId);
        if (!task) {
          return result(
            index,
            'task_status',
            false,
            `task '${expectation.taskId}' has no record in this run`,
          );
        }
        return result(
          index,
          'task_status',
          task.status === expectation.status,
          `task '${expectation.taskId}' status '${task.status}'` +
            (task.status === expectation.status ? '' : `, expected '${expectation.status}'`),
        );
      }
      case 'output':
        return gradeOutput(index, expectation, run, payloads);
      case 'reply':
        return gradeReply(index, expectation, run, payloads);
      case 'trajectory':
        return gradeTrajectory(index, expectation, run);
      case 'simulation':
        return gradeSimulation(index, expectation, run, payloads);
    }
  });

  const pendingRubrics = rubrics.map(rubricSlotName);
  const runFailure =
    run.status === 'failed' || run.status === 'cancelled'
      ? {
          runStatus: run.status,
          ...(run.failureReason ? { failureReason: run.failureReason } : {}),
        }
      : undefined;

  if (expectations.length === 0 && rubrics.length === 0) {
    const results = EvalCaseTrialResultsSchema.parse({
      expectationResults: [],
      fractionPassed: 0,
      fixtureTier,
      pendingRubrics,
      ...(runFailure !== undefined ? { runFailure } : {}),
      gradingError:
        'Case carries neither a deterministic expectation nor a rubric, so nothing can decide ' +
        'a verdict for it.',
    });
    return { verdict: 'error', results };
  }

  const passedCount = expectationResults.filter((r) => r.passed).length;
  // The deterministic half only. The stored verdict is folded from every axis
  // at the call site, once the judge stage has run.
  const verdict: EvalCaseTrialVerdict = passedCount === expectations.length ? 'pass' : 'fail';
  const results = EvalCaseTrialResultsSchema.parse({
    expectationResults,
    ...(expectations.length > 0 ? { fractionPassed: passedCount / expectations.length } : {}),
    fixtureTier,
    pendingRubrics,
    ...(runFailure !== undefined ? { runFailure } : {}),
  });
  return { verdict, results };
}

// ============================================================================
// Trial outcome axes (Plan 301 §5.1)
// ============================================================================

/**
 * Prefer the signal execution stamped. The fallback reads artifacts, and is
 * blind in exactly the way §5.1 describes: it cannot see a turn that produced
 * no usable output, and a pause carrying placeholder prompt text reads to it
 * as a reply. It exists so runs recorded before the stamp still classify.
 */
export function deriveExecutionState(run: GradableRunRecord): TrialExecutionState {
  if (run.executionState !== undefined) return run.executionState;
  if (run.status === 'failed' || run.status === 'cancelled') return 'run_failed';
  return 'completed';
}

/**
 * A case is invalid when nothing can grade it — not when one KIND of grader is
 * absent. A rubric-only case is gradable: the judge decides it, which is what a
 * judge is for.
 */
function deriveSetupOutcome(
  results: EvalCaseTrialResults,
  expectationCount: number,
  gatingSlots: ReadonlySet<string>,
): 'valid' | 'invalid' {
  if (expectationCount === 0 && gatingSlots.size === 0) return 'invalid';
  return results.gradingError !== undefined ? 'invalid' : 'valid';
}

function deriveCheckOutcome(
  results: EvalCaseTrialResults,
  expectationCount: number,
): TrialAxes['checkOutcome'] {
  // Symmetric with quality: a case carrying no deterministic check is not
  // missing evidence, it simply measures on the other axis.
  if (expectationCount === 0) return 'not_applicable';
  if (results.expectationResults.length === 0) return 'incomplete';
  if (results.expectationResults.some((r) => !r.passed)) return 'failed';
  return 'passed';
}

/**
 * Only GATING rubric slots decide quality. A case carrying none is
 * `not_applicable` — reporting it as unverified would leave every
 * deterministic-only case permanently unscored.
 */
function deriveQualityOutcome(
  results: EvalCaseTrialResults,
  gatingSlots: ReadonlySet<string>,
): { qualityOutcome: TrialAxes['qualityOutcome']; reason?: TrialQualityUnverifiedReason } {
  if (gatingSlots.size === 0) return { qualityOutcome: 'not_applicable' };
  const gatingResults = results.rubricResults.filter((r) => gatingSlots.has(resultSlotKey(r)));
  // A definitive failure first: an abstention on one criterion does not retract
  // a failure the judge stated plainly on another.
  if (gatingResults.some((r) => r.status === 'judged' && r.verdict === 'fail')) {
    return { qualityOutcome: 'failed' };
  }
  if (gatingResults.some((r) => r.status === 'judged' && r.verdict === 'unclear')) {
    return { qualityOutcome: 'unverified', reason: 'abstained' };
  }
  // Pending entries carry the NAME only, so a name matching any gating slot
  // counts as that slot still owing an answer. Erring toward unverified is the
  // safe direction: the alternative is a slot silently leaving the gate.
  const gatingNames = new Set([...gatingSlots].map((key) => key.split('\u0000')[1]));
  const pendingGating = results.pendingRubrics.filter((slot) => gatingNames.has(slot));
  if (pendingGating.length > 0) return { qualityOutcome: 'unverified', reason: 'not_run' };
  const unresolved = gatingResults.find((r) => r.status !== 'judged');
  if (unresolved !== undefined) {
    return { qualityOutcome: 'unverified', reason: unverifiedReasonFor(unresolved) };
  }
  if (gatingResults.length < gatingSlots.size) {
    return { qualityOutcome: 'unverified', reason: 'not_run' };
  }
  return { qualityOutcome: 'passed' };
}

/**
 * Why a gating slot produced no verdict. The distinction is operator-facing:
 * a provider outage is retried, while a judge refused by the bias rule or a
 * criterion that will not resolve is a configuration fault no retry fixes.
 */
function unverifiedReasonFor(
  result: Exclude<EvalCaseRubricResult, { status: 'judged' }>,
): TrialQualityUnverifiedReason {
  if (result.status === 'not_selected') return 'sampled_out';
  if (result.status === 'skipped_run_error') return 'not_run';
  switch (result.errorCode) {
    case 'judge_dispatch_failed':
    case 'judge_client_unavailable':
    case 'manifest_unavailable':
      return 'provider_error';
    case 'judge_model_equals_subject':
    case 'rubric_criterion_unresolved':
      return 'not_run';
    case 'evidence_unavailable':
      // The judge was not asked, because the pack could not answer. That is an
      // abstention about this trial's evidence, not a fault in the judge.
      return 'abstained';
    default:
      // The switch is exhaustive over today's enum, but these rows are
      // persisted JSON: a code added later, or written by a newer deploy and
      // read by an older one, would fall through and hand back `undefined` for
      // a field the type says is always present. `not_run` is the safe landing
      // — it withholds a verdict rather than inventing a retryable one.
      return 'not_run';
  }
}

/**
 * Fold a graded trial onto the four axes. `gatingSlots` names the rubric slots
 * that decide the verdict; everything outside it is unscored and cannot move
 * the class.
 */
export function deriveTrialOutcome(params: {
  run: GradableRunRecord;
  results: EvalCaseTrialResults;
  expectationCount: number;
  gatingSlots?: ReadonlySet<string>;
}): TrialOutcome {
  const { run, results, expectationCount } = params;
  const gatingSlots = params.gatingSlots ?? new Set<string>();
  const quality = deriveQualityOutcome(results, gatingSlots);
  return classifyTrialOutcome({
    executionState: deriveExecutionState(run),
    setupOutcome: deriveSetupOutcome(results, expectationCount, gatingSlots),
    checkOutcome: deriveCheckOutcome(results, expectationCount),
    qualityOutcome: quality.qualityOutcome,
    ...(quality.reason !== undefined ? { qualityUnverifiedReason: quality.reason } : {}),
  });
}
