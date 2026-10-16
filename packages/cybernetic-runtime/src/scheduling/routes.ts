/**
 * Routes: a fork stored on the task that decides it.
 *
 * A task's `routes` say which tasks its outcome enables. The enabled tasks'
 * guards are derived here, at materialization — the form every run and every
 * validity check uses — so the stored workflow holds the fork once, on its
 * source, and the guards cannot drift from it.
 */
import {
  DECISION_OPERATION_ID,
  predicateCombinator,
  predicateExpressions,
  type WorkflowPollUntil,
  type WorkflowTask,
  type WorkflowTaskRoute,
  type WorkflowWhen,
} from '@aflow/schemas';
import { parseOutputComparison } from './graph.js';
import type { GraphValidationError } from './graphValidation.js';
import { checkDecisionRoutes } from './decisionRouteChecks.js';

/**
 * Checks only one operation can make about its own routes — that a route names
 * an answer the operation can give. Keyed by operation id, so the workflow
 * model carries no operation-specific concept.
 */
const ROUTE_CHECKS: Readonly<Record<string, (task: WorkflowTask) => GraphValidationError[]>> = {
  [DECISION_OPERATION_ID]: checkDecisionRoutes,
};

/** `output.<path> …` read from the source, rewritten to how the target reads it. */
function fromSource(sourceId: string, expression: string): string {
  return `tasks.${sourceId}.${expression.trim()}`;
}

/**
 * The guard a task enabled by these routes of one source runs under, or null
 * when the combination has no single-level form. Several routes combine as
 * `anyOf`; a route that is itself an `allOf` combines with nothing, because the
 * `when` grammar has no nesting.
 */
export function routeGuardFor(
  sourceId: string,
  routes: readonly WorkflowTaskRoute[],
): WorkflowWhen | null {
  const first = routes[0];
  if (first === undefined) return null;
  if (routes.length === 1) return toWhen(sourceId, first.when);
  if (
    routes.some(
      (r) => predicateCombinator(r.when) === 'allOf' && predicateExpressions(r.when).length > 1,
    )
  ) {
    return null;
  }
  const expressions = [
    ...new Set(
      routes.flatMap((r) => predicateExpressions(r.when)).map((e) => fromSource(sourceId, e)),
    ),
  ];
  return expressions.length === 1
    ? { expression: expressions[0]!, onMissingRef: 'skip' }
    : { anyOf: expressions, onMissingRef: 'skip' };
}

function toWhen(sourceId: string, predicate: WorkflowPollUntil): WorkflowWhen {
  const expressions = predicateExpressions(predicate).map((e) => fromSource(sourceId, e));
  switch (predicateCombinator(predicate)) {
    case 'expression':
      return { expression: expressions[0]!, onMissingRef: 'skip' };
    case 'anyOf':
      return { anyOf: expressions, onMissingRef: 'skip' };
    case 'allOf':
      return { allOf: expressions, onMissingRef: 'skip' };
  }
}

/** Every task some route enables, with its one source and the routes that enable it. */
function claims(
  tasks: readonly WorkflowTask[],
): Map<string, Array<{ source: string; route: WorkflowTaskRoute }>> {
  const byTarget = new Map<string, Array<{ source: string; route: WorkflowTaskRoute }>>();
  for (const task of tasks) {
    for (const route of task.routes ?? []) {
      for (const target of route.enable) {
        const list = byTarget.get(target) ?? [];
        list.push({ source: task.taskId, route });
        byTarget.set(target, list);
      }
    }
  }
  return byTarget;
}

/**
 * Give each routed task the guard its routes imply and its source as a
 * dependency. A target the routes cannot guard — claimed by two sources,
 * carrying its own `when`, or enabled by an inexpressible combination — is
 * left as stored; validation refuses that workflow before it can run.
 */
export function deriveRouteGuards(tasks: WorkflowTask[]): WorkflowTask[] {
  const byTarget = claims(tasks);
  if (byTarget.size === 0) return tasks;
  return tasks.map((task) => {
    const claimed = byTarget.get(task.taskId);
    if (!claimed || task.when !== undefined) return task;
    const sources = new Set(claimed.map((c) => c.source));
    if (sources.size !== 1) return task;
    const [source] = sources;
    const guard = routeGuardFor(
      source!,
      claimed.map((c) => c.route),
    );
    if (!guard) return task;
    return {
      ...task,
      when: guard,
      dependsOn: [...new Set([...(task.dependsOn ?? []), source!])],
    };
  });
}

/** The route rules, read on the workflow as stored — before any guard is derived. */
export function validateRoutes(tasks: readonly WorkflowTask[]): GraphValidationError[] {
  const errors: GraphValidationError[] = [];
  const byId = new Map(tasks.map((t) => [t.taskId, t]));

  for (const task of tasks) {
    (task.routes ?? []).forEach((route, ri) => {
      for (const expression of predicateExpressions(route.when)) {
        if (!parseOutputComparison(expression.trim())) {
          errors.push({
            kind: 'route_unsupported_when',
            taskIds: [task.taskId],
            field: `routes[${String(ri)}].when`,
            detail:
              `Task "${task.taskId}" routes[${String(ri)}] has the condition "${expression}", which is not a comparison on its own output. ` +
              "Write output.<path> <op> <literal>, e.g. output.answers.team.value == 'billing'.",
          });
        }
      }
      for (const target of route.enable) {
        if (target === task.taskId) {
          errors.push({
            kind: 'route_target_self',
            taskIds: [task.taskId],
            field: `routes[${String(ri)}].enable`,
            detail: `Task "${task.taskId}" routes[${String(ri)}] enables itself; a route enables the tasks after it.`,
          });
        } else if (!byId.has(target)) {
          errors.push({
            kind: 'route_target_unknown',
            taskIds: [task.taskId, target],
            field: `routes[${String(ri)}].enable`,
            detail: `Task "${task.taskId}" routes[${String(ri)}] enables "${target}", which is not a task in this workflow.`,
          });
        }
      }
    });
    errors.push(...(task.operation ? (ROUTE_CHECKS[task.operation]?.(task) ?? []) : []));
  }

  for (const [target, claimed] of claims(tasks)) {
    const targetTask = byId.get(target);
    if (!targetTask) continue;
    const sources = [...new Set(claimed.map((c) => c.source))];
    if (sources.length > 1) {
      errors.push({
        kind: 'route_target_multiple_sources',
        taskIds: [target, ...sources],
        detail: `Task "${target}" is enabled by routes of ${sources.map((s) => `"${s}"`).join(' and ')}. A task is enabled by the routes of one task; give each source its own task.`,
      });
      continue;
    }
    if (targetTask.when !== undefined) {
      errors.push({
        kind: 'route_target_has_when',
        taskIds: [target, sources[0]!],
        detail: `Task "${target}" is enabled by routes of "${sources[0]!}" and also declares a when. Its guard comes from those routes; remove its when.`,
      });
      continue;
    }
    if (
      routeGuardFor(
        sources[0]!,
        claimed.map((c) => c.route),
      ) === null
    ) {
      errors.push({
        kind: 'route_guard_inexpressible',
        taskIds: [target, sources[0]!],
        detail:
          `Task "${target}" is enabled by several routes of "${sources[0]!}", and one of them is an allOf. ` +
          'Routes to one task combine as anyOf, and a condition cannot nest; give the allOf route its own task, or split it.',
      });
    }
  }
  return errors;
}
