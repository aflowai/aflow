/**
 * Routes: a fork stored on the task that decides it.
 *
 * A task's `routes` say which tasks its outcome enables. The enabled tasks'
 * guards are derived from them — at materialization, the form every run and
 * every validity check uses, and in the designer — so the fork is authored
 * once, on its source, and the guards cannot drift from it. A derived guard is
 * marked `derivedFromRoutes`, which is what lets a workflow stored in its
 * materialized form be read again as authored.
 */
import {
  predicateCombinator,
  predicateExpressions,
  type WorkflowPollUntil,
  type WorkflowTask,
  type WorkflowTaskRoute,
  type WorkflowWhen,
} from './task.js';

/** A route as an operator reads it: `when <condition> → enable <tasks>`. */
export function describeRoute(route: WorkflowTaskRoute): string {
  const joiner = predicateCombinator(route.when) === 'anyOf' ? ' or ' : ' and ';
  return `when ${predicateExpressions(route.when).join(joiner)} → enable ${route.enable.join(', ')}`;
}

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

/** Every task some route enables, with the sources and routes that enable it. */
export function routeClaims(
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

/** Whether materialization derived this guard from routes, rather than an author writing it. */
export function isRouteDerivedGuard(when: WorkflowWhen | undefined): boolean {
  return when?.derivedFromRoutes !== undefined;
}

/**
 * The task as authored: without the guard an earlier materialization derived
 * from routes, and without the dependency on the source that it added.
 */
function withoutDerivedRouteGuard(task: WorkflowTask): WorkflowTask {
  const mark = task.when?.derivedFromRoutes;
  if (mark === undefined) return task;
  const { when: _derived, dependsOn, ...rest } = task;
  const authoredDependsOn = mark.addedDependency
    ? (dependsOn ?? []).filter((id) => id !== mark.source)
    : dependsOn;
  return authoredDependsOn !== undefined && authoredDependsOn.length > 0
    ? { ...rest, dependsOn: authoredDependsOn }
    : rest;
}

/**
 * Give each routed task the guard its routes imply and its source as a
 * dependency. A target the routes cannot guard — claimed by two sources,
 * carrying its own `when`, or enabled by an inexpressible combination — is
 * left as authored; validation refuses that workflow before it can run.
 *
 * Idempotent: what an earlier pass derived — the guard, and the dependency on
 * the source when the author had not declared it — is marked, dropped and
 * derived again from the routes as they are now, so a stored materialized
 * workflow whose routes were since edited carries no stale guard and no stale
 * dependency.
 */
export function deriveRouteGuards(tasks: WorkflowTask[]): WorkflowTask[] {
  const byTarget = routeClaims(tasks);
  if (byTarget.size === 0 && !tasks.some((t) => isRouteDerivedGuard(t.when))) return tasks;
  return tasks.map((stored) => {
    const task = withoutDerivedRouteGuard(stored);
    const claimed = byTarget.get(task.taskId);
    if (!claimed || task.when !== undefined) return task;
    const sources = new Set(claimed.map((c) => c.source));
    if (sources.size !== 1) return task;
    const source = [...sources][0]!;
    const guard = routeGuardFor(
      source,
      claimed.map((c) => c.route),
    );
    if (!guard) return task;
    const authoredDependsOn = task.dependsOn ?? [];
    const addedDependency = !authoredDependsOn.includes(source);
    return {
      ...task,
      when: { ...guard, derivedFromRoutes: { source, addedDependency } },
      dependsOn: addedDependency ? [...authoredDependsOn, source] : authoredDependsOn,
    };
  });
}

/** The task whose routes enable this one, when exactly one does. */
export function routeSourceOf(tasks: readonly WorkflowTask[], taskId: string): string | undefined {
  const sources = new Set((routeClaims(tasks).get(taskId) ?? []).map((c) => c.source));
  return sources.size === 1 ? [...sources][0] : undefined;
}
