import { predicateCombinator, predicateExpressions } from '@aflow/schemas';
import type { WorkflowPollUntil, WorkflowTask, WorkflowWhen } from '@aflow/schemas';
import { parseOutputPath, readOutputPath } from './outputPath.js';

// ============================================================================
// Types
// ============================================================================

/** Result of a when-predicate evaluation. */
export type WhenResult =
  { outcome: 'pass' } | { outcome: 'skip'; reason: string } | { outcome: 'error'; reason: string };

/** Task output context for when-predicate evaluation. */
export interface TaskOutputContext {
  /** Map of taskId → task status ('succeeded', 'failed', 'skipped', etc.) */
  statuses: Map<string, string>;
  /** Map of taskId → task output fields (from PayloadRef, if resolved) */
  outputs: Map<string, Record<string, unknown>>;
}

/** Result of computeReadyTasks with when-predicate evaluation. */
export interface ReadyTasksResult {
  /** Tasks that are ready to be scheduled (deps satisfied, when passed). */
  ready: WorkflowTask[];
  /** Tasks that should be skipped (when evaluated to false). */
  skipped: Array<{ task: WorkflowTask; reason: string }>;
  /** Tasks whose when predicate hit an error (onMissingRef='error'). */
  errors: Array<{ task: WorkflowTask; reason: string }>;
}

// ============================================================================

export type ComparisonOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

export type PredicateLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null };

export interface ParsedTaskComparison {
  taskId: string;
  subject: { kind: 'status' } | { kind: 'output'; field: string };
  op: ComparisonOp;
  rhs: PredicateLiteral;
}

/** A parsed `poll.until` comparison: `output.<path> <op> <literal>`. */
export interface ParsedOutputComparison {
  field: string;
  op: ComparisonOp;
  rhs: PredicateLiteral;
}

const OPERATOR_PATTERN = /(==|!=|>=|<=|>|<)/;
const WHEN_STATUS_LHS = /^tasks\.([a-zA-Z0-9_-]+)\.status$/;
const WHEN_OUTPUT_LHS = /^tasks\.([a-zA-Z0-9_-]+)\.output\.(.+)$/;
const UNTIL_OUTPUT_LHS = /^output\.(.+)$/;
const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/;

function parseRhsLiteral(raw: string): PredicateLiteral | null {
  const s = raw.trim();
  const singleQuoted = /^'([^']*)'$/.exec(s);
  if (singleQuoted) return { kind: 'string', value: singleQuoted[1]! };
  const doubleQuoted = /^"([^"]*)"$/.exec(s);
  if (doubleQuoted) return { kind: 'string', value: doubleQuoted[1]! };
  if (s === 'true') return { kind: 'boolean', value: true };
  if (s === 'false') return { kind: 'boolean', value: false };
  // `null` — pairs with a projection's `onMissing: 'null'` so a gate can test
  // "this optional output is absent" (e.g. no PR exists for the branch) with
  // `== null` / `!= null`. Only equality applies (the op guard below enforces it).
  if (s === 'null') return { kind: 'null', value: null };
  if (NUMBER_LITERAL.test(s)) return { kind: 'number', value: parseFloat(s) };
  return null;
}

function splitComparison(
  expression: string,
): { lhs: string; op: ComparisonOp; rhs: PredicateLiteral } | null {
  const trimmed = expression.trim();
  const opMatch = OPERATOR_PATTERN.exec(trimmed);
  if (!opMatch) return null;
  const op = opMatch[1] as ComparisonOp;
  const lhs = trimmed.slice(0, opMatch.index).trim();
  const rhs = parseRhsLiteral(trimmed.slice(opMatch.index + op.length));
  if (!rhs) return null;
  // Ordering operators are numeric-only; equality applies to every literal kind.
  if (rhs.kind !== 'number' && op !== '==' && op !== '!=') return null;
  return { lhs, op, rhs };
}

/**
 * Parse a single `when` comparison. Returns null for anything outside the
 * supported grammar (callers reject at write time / fail-safe at runtime).
 */
export function parseTaskComparison(expression: string): ParsedTaskComparison | null {
  const split = splitComparison(expression);
  if (!split) return null;
  const statusMatch = WHEN_STATUS_LHS.exec(split.lhs);
  if (statusMatch) {
    // Status is a string; only string equality makes sense.
    if (split.rhs.kind !== 'string') return null;
    return { taskId: statusMatch[1]!, subject: { kind: 'status' }, op: split.op, rhs: split.rhs };
  }
  const outputMatch = WHEN_OUTPUT_LHS.exec(split.lhs);
  if (outputMatch) {
    // The field portion must parse under the shared output-path dialect
    const field = outputMatch[2]!;
    if (!parseOutputPath(field)) return null;
    return {
      taskId: outputMatch[1]!,
      subject: { kind: 'output', field },
      op: split.op,
      rhs: split.rhs,
    };
  }
  return null;
}

export function parseOutputComparison(expression: string): ParsedOutputComparison | null {
  const split = splitComparison(expression);
  if (!split) return null;
  const outputMatch = UNTIL_OUTPUT_LHS.exec(split.lhs);
  if (!outputMatch) return null;
  const field = outputMatch[1]!;
  if (!parseOutputPath(field)) return null;
  return { field, op: split.op, rhs: split.rhs };
}

// ============================================================================
// Typed comparison evaluation
// ============================================================================

type ComparisonOutcome = { kind: 'result'; value: boolean } | { kind: 'missing'; reason: string };

function evaluateTypedComparison(
  fieldValue: unknown,
  op: ComparisonOp,
  rhs: PredicateLiteral,
  subjectLabel: string,
): ComparisonOutcome {
  if (fieldValue === undefined) {
    return { kind: 'missing', reason: `${subjectLabel} is missing` };
  }
  if (op === '>' || op === '>=' || op === '<' || op === '<=') {
    if (rhs.kind !== 'number' || typeof fieldValue !== 'number') {
      return { kind: 'missing', reason: `${subjectLabel} is missing or not a number` };
    }
    let value: boolean;
    if (op === '>') value = fieldValue > rhs.value;
    else if (op === '>=') value = fieldValue >= rhs.value;
    else if (op === '<') value = fieldValue < rhs.value;
    else value = fieldValue <= rhs.value;
    return { kind: 'result', value };
  }
  // Strict typed equality — mismatched types are simply not equal.
  const equal = fieldValue === rhs.value;
  return { kind: 'result', value: op === '==' ? equal : !equal };
}

function evaluateTaskComparison(
  parsed: ParsedTaskComparison,
  context: TaskOutputContext,
): ComparisonOutcome {
  if (parsed.subject.kind === 'status') {
    const status = context.statuses.get(parsed.taskId);
    if (status === undefined) {
      return { kind: 'missing', reason: `Referenced task "${parsed.taskId}" has no status` };
    }
    return evaluateTypedComparison(
      status,
      parsed.op,
      parsed.rhs,
      `status of task "${parsed.taskId}"`,
    );
  }
  const outputs = context.outputs.get(parsed.taskId);
  if (!outputs) {
    return { kind: 'missing', reason: `Referenced task "${parsed.taskId}" has no output` };
  }
  return evaluateTypedComparison(
    readOutputPath(outputs, parsed.subject.field),
    parsed.op,
    parsed.rhs,
    `Field "${parsed.subject.field}" on task "${parsed.taskId}"`,
  );
}

// ============================================================================
// When predicate evaluation
// ============================================================================

export function evaluateWhen(when: WorkflowWhen, context: TaskOutputContext): WhenResult {
  const combinator = predicateCombinator(when);
  const expressions = predicateExpressions(when);
  const onMissingRef = when.onMissingRef;

  const evaluations: Array<{ expression: string; outcome: ComparisonOutcome }> = [];
  for (const expression of expressions) {
    const parsed = parseTaskComparison(expression);
    if (!parsed) {
      return {
        outcome: 'error',
        reason:
          `Unrecognized when expression: "${expression.trim()}". Expected a single comparison: ` +
          `tasks.<taskId>.status ==|!= '<value>', or tasks.<taskId>.output.<field> <op> <string|number|boolean literal>`,
      };
    }
    evaluations.push({ expression, outcome: evaluateTaskComparison(parsed, context) });
  }

  const firstMissing = evaluations.find((e) => e.outcome.kind === 'missing');
  const missingResult = (reason: string): WhenResult =>
    onMissingRef === 'error' ? { outcome: 'error', reason } : { outcome: 'skip', reason };

  if (combinator === 'anyOf') {
    if (evaluations.some((e) => e.outcome.kind === 'result' && e.outcome.value)) {
      return { outcome: 'pass' };
    }
    if (firstMissing?.outcome.kind === 'missing') {
      return missingResult(firstMissing.outcome.reason);
    }
    return { outcome: 'skip', reason: `anyOf [${expressions.join('; ')}] evaluated to false` };
  }

  if (combinator === 'allOf') {
    const firstFalse = evaluations.find((e) => e.outcome.kind === 'result' && !e.outcome.value);
    if (firstFalse) {
      return { outcome: 'skip', reason: `${firstFalse.expression.trim()} evaluated to false` };
    }
    if (firstMissing?.outcome.kind === 'missing') {
      return missingResult(firstMissing.outcome.reason);
    }
    return { outcome: 'pass' };
  }

  // Single expression.
  const single = evaluations[0]!;
  if (single.outcome.kind === 'missing') {
    return missingResult(single.outcome.reason);
  }
  return single.outcome.value
    ? { outcome: 'pass' }
    : { outcome: 'skip', reason: `${single.expression.trim()} evaluated to false` };
}

// ============================================================================

export function evaluateUntilPredicate(until: WorkflowPollUntil, rawOutput: unknown): boolean {
  const combinator = predicateCombinator(until);
  const results = predicateExpressions(until).map((expression) => {
    const parsed = parseOutputComparison(expression);
    if (!parsed) return false; // write-time validation rejects; runtime = unmet
    const fieldValue = readOutputPath(rawOutput, parsed.field);
    const outcome = evaluateTypedComparison(
      fieldValue,
      parsed.op,
      parsed.rhs,
      `output.${parsed.field}`,
    );
    return outcome.kind === 'result' ? outcome.value : false;
  });
  if (combinator === 'allOf') return results.every(Boolean);
  return results.some(Boolean);
}

// ============================================================================
// `when:` predicate task-ID reference extraction
// ============================================================================

const OUTPUT_REF_PATTERN = /tasks\.([a-zA-Z0-9_-]+)\.output\./g;

export function collectOutputReferencedTaskIds(tasks: readonly WorkflowTask[]): Set<string> {
  const referenced = new Set<string>();
  for (const task of tasks) {
    if (!task.when) continue;
    for (const expr of predicateExpressions(task.when)) {
      let match: RegExpExecArray | null;
      OUTPUT_REF_PATTERN.lastIndex = 0;
      while ((match = OUTPUT_REF_PATTERN.exec(expr)) !== null) {
        referenced.add(match[1]!);
      }
    }
  }
  return referenced;
}

// ============================================================================
// Ready task computation
// ============================================================================

/**
 * Compute the set of tasks whose dependencies are all satisfied AND whose
 * `when` predicates pass. Tasks with false predicates are returned in the
 * `skipped` set. Tasks with error predicates are returned in `errors`.
 *
 * This replaces the simpler `computeReadyTasks` from workflowEngine.ts
 * with full `when` support.
 */
export function computeReadyTasksWithWhen(
  tasks: WorkflowTask[],
  completedTaskIds: Set<string>,
  skippedTaskIds: Set<string>,
  taskOutputContext: TaskOutputContext,
  /** Task IDs that failed but are optional — treated as satisfied deps (104d Phase 2). */
  failedOptionalTaskIds?: Set<string>,
): ReadyTasksResult {
  const satisfiedIds = new Set([
    ...completedTaskIds,
    ...skippedTaskIds,
    ...(failedOptionalTaskIds ?? []),
  ]);
  const doneIds = satisfiedIds;
  const ready: WorkflowTask[] = [];
  const skipped: ReadyTasksResult['skipped'] = [];
  const errors: ReadyTasksResult['errors'] = [];

  for (const task of tasks) {
    // Already done
    if (doneIds.has(task.taskId)) continue;

    // Check deps — all must be completed, skipped, or failed-optional.
    const requiredDeps = collectTaskDependencies(task);
    if (requiredDeps.size > 0) {
      let allDepsSatisfied = true;
      for (const depId of requiredDeps) {
        if (!satisfiedIds.has(depId)) {
          allDepsSatisfied = false;
          break;
        }
      }
      if (!allDepsSatisfied) continue;
    }

    // Evaluate when predicate if present
    if (task.when) {
      const whenResult = evaluateWhen(task.when, taskOutputContext);
      if (whenResult.outcome === 'skip') {
        skipped.push({ task, reason: whenResult.reason });
        continue;
      }
      if (whenResult.outcome === 'error') {
        errors.push({ task, reason: whenResult.reason });
        continue;
      }
    }

    ready.push(task);
  }

  return { ready, skipped, errors };
}

// ============================================================================

/**
 * Returns the full set of upstream task IDs this task depends on.
 *
 * Merges two sources:
 *   - `task.dependsOn` (explicit ordering — the canonical edge type).
 *   - `task.inputBindings[*]` for `task_output` / `task_summary` binding kinds
 *     (binding to a producer's output IS a dependency on that producer).
 *
 * This is the **single source of truth** for the graph lens used by both
 * scheduling readiness (`computeReadyTasksWithWhen`) AND reset-scope
 * computation (`computeDescendants`). They MUST share the same lens — Plan
 * 123 §3.3 Phase B-prime resets producer + descendants on rerun; if
 * descendants is computed via bindings but readiness only via `dependsOn`,
 * a binding-only consumer can race ahead of its rerun producer.
 */
export function collectTaskDependencies(task: WorkflowTask): Set<string> {
  const deps = new Set<string>();
  if (task.dependsOn) {
    for (const depId of task.dependsOn) deps.add(depId);
  }
  if (task.inputBindings) {
    for (const binding of Object.values(task.inputBindings)) {
      if (binding.kind === 'task_output' || binding.kind === 'task_summary') {
        deps.add(binding.taskId);
      }
    }
  }
  return deps;
}

// ============================================================================
// Descendants computation
// ============================================================================

export function computeDescendants(tasks: WorkflowTask[], rootTaskIds: Set<string>): Set<string> {
  // Build reverse adjacency from the unified graph lens.
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const depId of collectTaskDependencies(task)) {
      const existing = dependents.get(depId) ?? [];
      if (!existing.includes(task.taskId)) existing.push(task.taskId);
      dependents.set(depId, existing);
    }
  }

  const descendants = new Set<string>();
  const queue = [...rootTaskIds];

  while (queue.length > 0) {
    const current = queue.pop()!;
    const children = dependents.get(current) ?? [];
    for (const childId of children) {
      if (!descendants.has(childId)) {
        descendants.add(childId);
        queue.push(childId);
      }
    }
  }

  return descendants;
}

/**
 * Tasks to mark `skipped` when an approval gate is **rejected**: the approve
 * task itself plus its `when`-gated descendants (the conditional branch the
 * approval guards).
 *
 * The when-LESS descendants are deliberately EXCLUDED — they are unconditional
 * (always-on learning / cleanup tasks). A skipped upstream satisfies
 * `dependsOn` (see `computeReadyTasksWithWhen`), so once the gated branch is
 * skipped the scheduler dispatches those always-on tasks; their `task_output`
 * bindings to the now-skipped branch resolve to ABSENT (see `resolveTaskInputs`
 * skipped/blocked → ABSENT). This is the mechanism behind "reject-but-learn".
 *
 * Why not `fail`/`applyFailureMode`: that **blocks** the whole descendant
 * closure (including the always-on tasks) and surfaces the run as failed.
 * Reject is an operator "no", not a system failure — the gated action simply
 * doesn't happen.
 *
 * The `when`-presence test IS the author's conditional/unconditional signal —
 * it is a convention, NOT a universal guarantee, and has two known edges:
 *
 *   1. A descendant WITHOUT a `when` is treated as unconditional and RUNS on
 *      reject (its skipped deps satisfy `dependsOn`). So a side-effecting task
 *      placed below the gate but left un-gated (`approve → gated(when) →
 *      side-effect(no when)`) will fire even though the approval was rejected.
 *      To make a downstream task conditional on the approval, gate it with a
 *      `when` — gating does NOT propagate from an upstream task. Authors who
 *      want a task to always run (learning / cleanup) deliberately omit `when`.
 *   2. A descendant carrying a `when` for an UNRELATED gate (a second,
 *      independent approval whose branch sits below this one) is skipped too.
 *
 * Both are acceptable for the single-gate, learning-tail skills this serves;
 * revisit (e.g. an explicit always-run marker) if a skill needs finer scoping.
 */
export function computeRejectedApprovalSkipSet(
  tasks: WorkflowTask[],
  approveTaskId: string,
): Set<string> {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const skip = new Set<string>([approveTaskId]);
  for (const id of computeDescendants(tasks, new Set([approveTaskId]))) {
    if (byId.get(id)?.when) skip.add(id);
  }
  return skip;
}

const RETRY_BLOCKING_STATUSES = new Set(['failed', 'blocked', 'cancelled']);

export interface RetryBlockedDescendantRow {
  taskId: string;
  status: string;
}

/**
 * Compute the blocked descendant rows that a retry may safely delete.
 *
 * A plain descendant closure is too broad for shared downstream nodes:
 * if `A` and `C` both feed `D`, retrying `A` must not delete `D` while
 * `C` is still failed/blocked/cancelled. This returns the subset of blocked
 * descendants whose blocking dependencies are either the retried task itself
 * or other blocked descendants that are cleared in the same wave.
 */
export function computeBlockedDescendantsToClearForRetry(
  tasks: WorkflowTask[],
  rows: RetryBlockedDescendantRow[],
  retriedTaskId: string,
): Set<string> {
  const descendants = computeDescendants(tasks, new Set([retriedTaskId]));
  const statusByTaskId = new Map(rows.map((row) => [row.taskId, row.status]));
  const optionalTaskIds = new Set(tasks.filter((task) => task.optional).map((task) => task.taskId));
  const depsByTaskId = new Map(tasks.map((task) => [task.taskId, collectTaskDependencies(task)]));
  const clearable = new Set(
    rows
      .filter((row) => row.status === 'blocked' && descendants.has(row.taskId))
      .map((row) => row.taskId),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const taskId of [...clearable]) {
      const deps = depsByTaskId.get(taskId) ?? new Set<string>();
      for (const depId of deps) {
        if (depId === retriedTaskId) continue;
        const depStatus = statusByTaskId.get(depId);
        if (depStatus === undefined) continue;
        if (depStatus === 'failed' && optionalTaskIds.has(depId)) continue;
        if (RETRY_BLOCKING_STATUSES.has(depStatus) && !clearable.has(depId)) {
          clearable.delete(taskId);
          changed = true;
          break;
        }
      }
    }
  }

  return clearable;
}
