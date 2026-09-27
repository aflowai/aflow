import type { CaseExpectation } from '@aflow/schemas';

import { splitJsonPointer } from '@aflow/applet-runtime';

import { gradeCaseTrial, type GradableRunRecord } from './evalTrialGrader.js';

/**
 * Plan 301 §5.2 — a check earns its place by rejecting the defect it claims to
 * catch, and by accepting a reference that does not contain it.
 *
 * Both halves are load-bearing. A check that only accepts proves nothing about
 * the defect; a check that only rejects may simply always fail, and a suite of
 * always-failing checks looks rigorous and measures nothing. The gate runs both
 * directions against the deterministic grader, which is pure, so this costs no
 * model call and no run.
 *
 * The judge lane is separate and priced: a criterion asking about prose cannot
 * be witnessed by mutating a journal.
 */

const REFERENCE_REPLY =
  'Your refund of 120 SAR from the merchant is still with them, and I have not moved anything yet.';
const DELTA_REF = 'inline:gate-delta';
const RESPONSE_REF = 'inline:gate-response';
const PAUSE_REF = 'inline:gate-pause';

/**
 * Text that actually matches a reply pattern, or null when this cannot build
 * one.
 *
 * The pattern is a regex, so the mutant has to satisfy it rather than contain
 * its source: writing `PAY-\d` into the reply produces a literal backslash-d,
 * which the check correctly does not match — and the gate would then report the
 * check as failing to reject its own defect. Simple classes are expanded and
 * the result is VERIFIED against the pattern; anything richer is declared
 * unconstructible instead of guessed at.
 */
function textMatching(pattern: string): string | null {
  const candidate = pattern
    .replace(/\\d/g, '7')
    .replace(/\\w/g, 'a')
    .replace(/\\s/g, ' ')
    .replace(/[$^]/g, '')
    .replace(/\\./g, '.');
  if (/[[\]()|*+?{}\\]/.test(candidate)) return null;
  try {
    return new RegExp(pattern).test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

interface SyntheticTrial {
  run: GradableRunRecord;
  payloads: Map<string, unknown>;
}

interface JournalledCall {
  simulationId: string;
  endpointId: string;
  status: string;
  mutations: Array<{ collection: string; op: string; entityId?: string; body?: unknown }>;
}

/**
 * A run that satisfies every deterministic check the case states.
 *
 * Built from the checks rather than from a recorded run, so the gate gives an
 * answer at authoring time. What it cannot synthesise it reports: a check kind
 * absent from this builder is not silently treated as satisfied.
 */
export function buildReferenceTrial(expectations: readonly CaseExpectation[]): {
  trial: SyntheticTrial;
  unsupported: string[];
} {
  const calls: JournalledCall[] = [];
  const unsupported: string[] = [];
  let reply = REFERENCE_REPLY;
  let runStatus: GradableRunRecord['status'] = 'paused';

  // The simulation id travels with the call. `gradeSimulation` filters by a
  // declared `expectation.simulationId`, so stamping every synthetic call with
  // one fixed id made any simulation-scoped assertion unsatisfiable and got the
  // case refused at the write path as a contradiction it does not contain.
  const callFor = (simulationId: string, endpointId: string, status: string): JournalledCall => {
    const existing = calls.find(
      (c) => c.endpointId === endpointId && c.simulationId === simulationId,
    );
    if (existing !== undefined) return existing;
    const created: JournalledCall = { simulationId, endpointId, status, mutations: [] };
    calls.push(created);
    return created;
  };

  for (const expectation of expectations) {
    switch (expectation.kind) {
      case 'terminal':
        runStatus = expectation.runStatus;
        break;
      case 'reply':
        if (expectation.check.op === 'contains') {
          // The pattern is a regex, so the reference has to SATISFY it. Pasting
          // its source produced a reply containing the characters `PAY-\d`,
          // which the check correctly does not match — and the case was then
          // refused at the write path as a contradiction it does not contain.
          const witness = textMatching(expectation.check.pattern);
          if (witness === null) {
            unsupported.push('reply:contains');
            break;
          }
          reply = `${reply} ${witness}`;
        }
        break;
      case 'simulation': {
        const check = expectation.check;
        const simulationId = expectation.simulationId ?? 'gate';
        if (check.op === 'called') {
          if (check.expect === 'none') {
            // The reference must NOT make the forbidden call, and still has to
            // journal something: the grader refuses a negative assertion over
            // an empty journal.
            callFor(simulationId, 'gate_reader', 'ok');
            break;
          }
          callFor(simulationId, check.endpointId, check.status ?? 'ok');
          break;
        }
        if (check.expect === 'none' && check.times === undefined) {
          // The grader fails a negative assertion over an EMPTY journal, on
          // purpose: crediting restraint the subject never exercised is a
          // vacuous pass. So the reference has to have called something, just
          // not written what the check forbids.
          callFor(simulationId, 'gate_reader', 'ok');
          break;
        }
        const target = callFor(simulationId, 'gate_writer', 'ok');
        const wanted = check.times?.exactly ?? check.times?.atLeast ?? 1;
        for (let i = 0; i < wanted; i += 1) {
          target.mutations.push({
            collection: check.collection,
            op: check.change ?? 'create',
            ...(check.entityId !== undefined ? { entityId: check.entityId } : {}),
            // A delete journals no body, so supplying one would let an
            // impossible `where` on a delete pass the gate.
            ...(check.change === 'delete' ? {} : { body: bodyFor(check.where) }),
          });
        }
        break;
      }
      case 'task_status':
      case 'output':
      case 'trajectory':
        // Not synthesisable from the check alone: each needs a task graph or a
        // produced output the gate has no way to invent. Reported, never
        // treated as satisfied.
        unsupported.push(expectation.kind);
        break;
    }
  }

  const payloads = new Map<string, unknown>([
    [PAUSE_REF, { prompt: reply }],
    [RESPONSE_REF, { status: 'ok' }],
  ]);
  calls.forEach((call, index) => {
    payloads.set(`${RESPONSE_REF}:${String(index)}`, { status: call.status });
    payloads.set(`${DELTA_REF}:${String(index)}`, { mutations: call.mutations });
  });

  return {
    trial: {
      run: {
        status: runStatus,
        pausedReason: 'task_paused',
        pausedPayloadRef: PAUSE_REF,
        executionState: 'completed',
        tasks: [],
        simulationCalls: calls.map((call, index) => ({
          simulationId: call.simulationId,
          endpointId: call.endpointId,
          responseStatus: 200,
          responseRef: `${RESPONSE_REF}:${String(index)}`,
          deltaRef: `${DELTA_REF}:${String(index)}`,
          ordinal: index + 1,
        })),
      },
      payloads,
    },
    unsupported: [...new Set(unsupported)],
  };
}

function bodyFor(
  where: ReadonlyArray<{ path: string; value?: unknown }> | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const predicate of where ?? []) {
    // RFC 6901: `~1` is a literal '/', `~0` a literal '~'. Splitting raw built
    // a key named `account~1id` where the grader resolves `account/id`, so the
    // reference could not satisfy a check a real mutation would.
    const segments = splitJsonPointer(predicate.path);
    let cursor = body;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        cursor[segment] = predicate.value;
        return;
      }
      const existing = cursor[segment];
      const next =
        typeof existing === 'object' && existing !== null
          ? (existing as Record<string, unknown>)
          : {};
      cursor[segment] = next;
      cursor = next;
    });
  }
  return body;
}

// ============================================================================
// Mutants — one per check, defeating exactly that check
// ============================================================================

export interface Mutant {
  id: string;
  /** Index into the case's expectations: the check this defeats. */
  targets: number;
  /** What the mutant does, for a diagnostic a reader can act on. */
  describes: string;
  /**
   * Null when the defect cannot be constructed — a pattern too rich to satisfy,
   * say. Reported as unconstructible rather than counted as a check that failed
   * to reject, which would be a gap the case does not have.
   */
  apply: (trial: SyntheticTrial) => SyntheticTrial | null;
}

function clone(trial: SyntheticTrial): SyntheticTrial {
  return {
    run: { ...trial.run, simulationCalls: [...(trial.run.simulationCalls ?? [])] },
    payloads: new Map(trial.payloads),
  };
}

function mutationsOfRef(trial: SyntheticTrial, ref: string): Array<Record<string, unknown>> {
  const payload = trial.payloads.get(ref) as { mutations?: unknown } | undefined;
  return Array.isArray(payload?.mutations)
    ? (payload.mutations as Array<Record<string, unknown>>)
    : [];
}

function withMutations(
  trial: SyntheticTrial,
  ref: string,
  mutations: Array<Record<string, unknown>>,
): SyntheticTrial {
  const next = clone(trial);
  next.payloads.set(ref, { mutations });
  return next;
}

/** The delta ref of the call that carries writes in a reference trial. */
function writerRef(trial: SyntheticTrial): string | undefined {
  const index = (trial.run.simulationCalls ?? []).findIndex((c) => c.endpointId === 'gate_writer');
  return index >= 0 ? `${DELTA_REF}:${String(index)}` : undefined;
}

/**
 * The defect each check claims to reject, as a change to the reference.
 *
 * Derived from the check's own shape. That is not the circularity the plan
 * warns about: coverage already guarantees every requirement HAS a claiming
 * check, so a deleted check surfaces as an uncovered requirement rather than as
 * a mutant that quietly stopped applying.
 */
export function deterministicMutants(expectations: readonly CaseExpectation[]): Mutant[] {
  const mutants: Mutant[] = [];

  expectations.forEach((expectation, index) => {
    if (expectation.kind === 'reply') {
      const { check } = expectation;
      mutants.push({
        id: `reply-${String(index)}`,
        targets: index,
        describes:
          check.op === 'not_contains'
            ? `a reply containing '${check.pattern}'`
            : 'a reply missing what the check requires',
        apply: (trial) => {
          if (check.op === 'not_contains') {
            const offending = textMatching(check.pattern);
            if (offending === null) return null;
            const next = clone(trial);
            next.payloads.set(PAUSE_REF, { prompt: `The reference is ${offending}.` });
            return next;
          }
          // Defeating a `contains` check means a reply the pattern does not
          // match. A fixed string could coincidentally satisfy the pattern, so
          // it is checked rather than assumed.
          const next = clone(trial);
          const bland = 'No further detail is available.';
          try {
            if (new RegExp(check.pattern).test(bland)) return null;
          } catch {
            return null;
          }
          next.payloads.set(PAUSE_REF, { prompt: bland });
          return next;
        },
      });
      return;
    }

    if (expectation.kind === 'terminal') {
      mutants.push({
        id: `terminal-${String(index)}`,
        targets: index,
        describes: `a run that ended '${expectation.runStatus === 'completed' ? 'failed' : 'completed'}'`,
        apply: (trial) => {
          const next = clone(trial);
          next.run = {
            ...next.run,
            status: expectation.runStatus === 'completed' ? 'failed' : 'completed',
          };
          return next;
        },
      });
      return;
    }

    if (expectation.kind !== 'simulation') return;
    const check = expectation.check;

    if (check.op === 'called') {
      const simulationId = expectation.simulationId ?? 'gate';
      if (check.expect === 'none') {
        mutants.push({
          id: `called-${String(index)}`,
          targets: index,
          describes: `a run that did call '${check.endpointId}'`,
          apply: (trial) => {
            const next = clone(trial);
            next.run = {
              ...next.run,
              simulationCalls: [
                ...(next.run.simulationCalls ?? []),
                {
                  simulationId,
                  endpointId: check.endpointId,
                  responseStatus: 200,
                  responseRef: RESPONSE_REF,
                  deltaRef: null,
                  ordinal: 98,
                },
              ],
            };
            return next;
          },
        });
        return;
      }
      mutants.push({
        id: `uncalled-${String(index)}`,
        targets: index,
        describes: `a run that never called '${check.endpointId}'`,
        apply: (trial) => {
          const next = clone(trial);
          next.run = {
            ...next.run,
            simulationCalls: (next.run.simulationCalls ?? []).filter(
              (call) => call.endpointId !== check.endpointId,
            ),
          };
          return next;
        },
      });
      return;
    }

    // `expect: none` — the write it forbids.
    if (check.expect === 'none' && check.times === undefined) {
      mutants.push({
        id: `wrote-${String(index)}`,
        targets: index,
        describes: `a run that wrote to '${check.collection}'`,
        apply: (trial) => {
          const next = clone(trial);
          const ref = writerRef(next) ?? `${DELTA_REF}:0`;
          if (writerRef(next) === undefined) {
            next.run = {
              ...next.run,
              simulationCalls: [
                ...(next.run.simulationCalls ?? []),
                {
                  // Grading filters by the expectation's declared simulation
                  // before it looks at mutations, so a writer stamped with a
                  // different id is invisible to a scoped check and the gate
                  // reports a valid check as ineffective.
                  simulationId: expectation.simulationId ?? 'gate',
                  endpointId: 'gate_writer',
                  responseStatus: 200,
                  responseRef: RESPONSE_REF,
                  deltaRef: `${DELTA_REF}:0`,
                  ordinal: 99,
                },
              ],
            };
          }
          next.payloads.set(ref, {
            mutations: [
              ...mutationsOfRef(next, ref),
              { collection: check.collection, op: check.change ?? 'create', entityId: 'MUT-1' },
            ],
          });
          return next;
        },
      });
      return;
    }

    const ref = `${DELTA_REF}:0`;

    // A positive write assertion is defeated by no write at all — but only when
    // the check actually demands one. `atMost: 10` is satisfied by zero writes,
    // so removing them violates nothing and the absent rejection would be
    // reported as a gap the check does not have.
    const demandsAWrite =
      check.expect === 'any' &&
      (check.times === undefined ||
        (check.times.exactly ?? 0) > 0 ||
        (check.times.atLeast ?? 0) > 0);
    if (demandsAWrite) {
      mutants.push({
        id: `unwritten-${String(index)}`,
        targets: index,
        describes: `a run that never wrote to '${check.collection}'`,
        apply: (trial) => {
          const target = writerRef(trial) ?? ref;
          return withMutations(
            trial,
            target,
            mutationsOfRef(trial, target).filter((m) => m['collection'] !== check.collection),
          );
        },
      });
    }

    if (check.entityId !== undefined) {
      mutants.push({
        id: `wrong-entity-${String(index)}`,
        targets: index,
        describes: `the same write against a different record than '${check.entityId}'`,
        apply: (trial) => {
          const target = writerRef(trial) ?? ref;
          return withMutations(
            trial,
            target,
            mutationsOfRef(trial, target).map((m) =>
              m['collection'] === check.collection ? { ...m, entityId: 'WRONG-1' } : m,
            ),
          );
        },
      });
    }

    for (const predicate of check.where ?? []) {
      mutants.push({
        id: `wrong-value-${String(index)}-${predicate.path}`,
        targets: index,
        describes: `the same write with a different '${predicate.path}'`,
        apply: (trial) => {
          const target = writerRef(trial) ?? ref;
          return withMutations(
            trial,
            target,
            mutationsOfRef(trial, target).map((m) =>
              m['collection'] === check.collection
                ? { ...m, body: bodyFor([{ path: predicate.path, value: '__mutated__' }]) }
                : m,
            ),
          );
        },
      });
    }

    const bound = check.times?.exactly ?? check.times?.atMost;
    if (bound !== undefined) {
      // Exactly one more than the bound allows. Duplicating the reference list
      // does not guarantee a violation — `atMost: 10` stays inside its bound
      // however many times it is doubled, and `exactly: 0` has nothing to
      // duplicate — so both valid checks would have been reported as unable to
      // fail.
      const violating = bound + 1;
      mutants.push({
        id: `count-${String(index)}`,
        targets: index,
        describes: `${String(violating)} writes to '${check.collection}' where the check allows ${String(bound)}`,
        apply: (trial) => {
          const target = writerRef(trial) ?? ref;
          const others = mutationsOfRef(trial, target).filter(
            (m) => m['collection'] !== check.collection,
          );
          const write = {
            collection: check.collection,
            op: check.change ?? 'create',
            ...(check.entityId !== undefined ? { entityId: check.entityId } : {}),
            ...(check.change === 'delete' ? {} : { body: bodyFor(check.where) }),
          };
          return withMutations(trial, target, [
            ...others,
            ...Array.from({ length: violating }, (_, i) => ({
              ...write,
              entityId: `CNT-${String(i)}`,
            })),
          ]);
        },
      });
    }
  });

  return mutants;
}

// ============================================================================
// The witness — reference passes, mutant fails, failure lands on the claimant
// ============================================================================

export interface MutantWitness {
  mutantId: string;
  describes: string;
  /** The check the mutant targets, and the requirements that check claims. */
  targets: number;
  claims: string[];
  rejected: boolean;
  /** Set when the mutant was rejected by a check OTHER than the one it targets. */
  attributedElsewhere?: string;
}

export interface GateReport {
  /** The reference must pass every check, or a rejection proves nothing. */
  referencePasses: boolean;
  referenceFailures: string[];
  /** Check kinds the reference builder cannot synthesise — never treated as satisfied. */
  unsupported: string[];
  /**
   * Defects this could not construct. Distinct from `unwitnessed`: the check
   * may well reject them, and reporting them as gaps would send an author
   * hunting a hole that is in the gate rather than in the case.
   */
  unconstructible: string[];
  witnesses: MutantWitness[];
  /** Mutants no check rejected: the defects this case would not notice. */
  unwitnessed: string[];
  passed: boolean;
}

/**
 * Run both directions of the gate over a case's deterministic checks.
 *
 * `referencePasses` comes first deliberately. A check that always fails rejects
 * every mutant and would otherwise satisfy the gate perfectly, which is the
 * shape of a suite that measures nothing while looking rigorous.
 */
export function runDeterministicGate(caseDef: {
  expectations: readonly CaseExpectation[];
  rubrics?: readonly unknown[];
}): GateReport {
  const { trial, unsupported } = buildReferenceTrial(caseDef.expectations);

  // A check the builder cannot synthesise is graded against a run that was
  // never built to satisfy it, so it fails — and that failure read as a
  // contradiction between the case's own checks, turning the advisory
  // "unproven" path into a blocking refusal. Unsupported kinds are held out of
  // the reference grade and reported on their own terms.
  const supported = caseDef.expectations.filter(
    (expectation) => !unsupported.includes(expectation.kind),
  );

  const referenceGrade = gradeCaseTrial({
    expectations: supported,
    rubrics: [],
    fixtureTier: 'sealed',
    run: trial.run,
    payloads: trial.payloads,
  });
  const referenceFailures = referenceGrade.results.expectationResults
    .filter((r) => !r.passed)
    .map((r) => r.detail ?? `expectation ${String(r.expectationIndex)} failed`);
  const referencePasses = referenceFailures.length === 0;

  const witnesses: MutantWitness[] = [];
  const unconstructible: string[] = [];
  for (const mutant of deterministicMutants(caseDef.expectations)) {
    // The mutant's `targets` indexes the ORIGINAL expectation list, which is
    // what a diagnostic must point at; grading runs over the supported subset,
    // so the two are matched by identity rather than by position.
    const targeted = caseDef.expectations[mutant.targets];
    if (targeted === undefined || unsupported.includes(targeted.kind)) continue;
    const mutated = mutant.apply(trial);
    if (mutated === null) {
      unconstructible.push(`${mutant.id} (${mutant.describes})`);
      continue;
    }
    const grade = gradeCaseTrial({
      expectations: supported,
      rubrics: [],
      fixtureTier: 'sealed',
      run: mutated.run,
      payloads: mutated.payloads,
    });
    const supportedIndex = supported.indexOf(targeted);
    const failures = grade.results.expectationResults.filter((r) => !r.passed);
    const rejected = failures.some((f) => f.expectationIndex === supportedIndex);
    const claimed = caseDef.expectations[mutant.targets]?.claims ?? [];

    witnesses.push({
      mutantId: mutant.id,
      describes: mutant.describes,
      targets: mutant.targets,
      claims: [...claimed],
      rejected,
      // A mutant caught only by a different check is not evidence THIS check
      // works: the suite would still pass if this check were deleted.
      ...(!rejected && failures.length > 0
        ? { attributedElsewhere: failures.map((f) => String(f.expectationIndex)).join(', ') }
        : {}),
    });
  }

  const unwitnessed = witnesses.filter((w) => !w.rejected).map((w) => w.mutantId);
  return {
    referencePasses,
    referenceFailures,
    unsupported,
    unconstructible,
    witnesses,
    unwitnessed,
    passed: referencePasses && unsupported.length === 0 && unwitnessed.length === 0,
  };
}

// ============================================================================
// Polarity — does the check assert the direction its requirement states?
// ============================================================================

export type CheckPolarity = 'positive' | 'negative' | 'neutral';

/**
 * Which way a check points, where that is mechanical.
 *
 * The mutation gate proves a check CAN fail; it cannot tell that a check fails
 * for the opposite reason to the one intended. Relaxing "opened no case" to
 * "opened a case" leaves a check that rejects its own defect perfectly and
 * asserts the reverse of the policy — the gate is satisfied and the case now
 * demands the thing it was written to forbid.
 *
 * The requirement says which direction was meant, so the mismatch is visible
 * without anyone reading the prose.
 */
export function checkPolarity(expectation: CaseExpectation): CheckPolarity {
  if (expectation.kind === 'reply') {
    return expectation.check.op === 'not_contains' ? 'negative' : 'positive';
  }
  if (expectation.kind !== 'simulation') return 'neutral';
  const check = expectation.check;
  if (check.op === 'called') return check.expect === 'none' ? 'negative' : 'positive';
  if (check.times !== undefined) {
    return check.times.exactly === 0 || check.times.atMost === 0 ? 'negative' : 'positive';
  }
  return check.expect === 'none' ? 'negative' : 'positive';
}

export interface PolarityMismatch {
  requirementId: string;
  requirementKind: string;
  checkIndex: number;
  polarity: CheckPolarity;
  detail: string;
}

export function findPolarityMismatches(caseDef: {
  requirements: ReadonlyArray<{ id: string; kind: string; statement: string }>;
  expectations: readonly CaseExpectation[];
}): PolarityMismatch[] {
  const byId = new Map(caseDef.requirements.map((r) => [r.id, r]));
  const mismatches: PolarityMismatch[] = [];

  caseDef.expectations.forEach((expectation, index) => {
    const polarity = checkPolarity(expectation);
    if (polarity === 'neutral') return;
    for (const id of expectation.claims ?? []) {
      const requirement = byId.get(id);
      if (requirement === undefined) continue;
      const wanted =
        requirement.kind === 'must_not_do'
          ? 'negative'
          : requirement.kind === 'must_do'
            ? 'positive'
            : null;
      // `must_ask_before_acting` is satisfied either way: the deterministic
      // half of "it asked first" is usually that it did NOT act, while the
      // asking itself is prose a judge reads.
      if (wanted === null || polarity === wanted) continue;
      mismatches.push({
        requirementId: id,
        requirementKind: requirement.kind,
        checkIndex: index,
        polarity,
        detail: `'${requirement.statement}' is a ${requirement.kind} requirement, and the check claiming it asserts the ${polarity} case`,
      });
    }
  });

  return mismatches;
}
