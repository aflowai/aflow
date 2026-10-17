/**
 * The route rules. The guards routes imply are derived in `@aflow/schemas`
 * (`deriveRouteGuards`), where both materialization and the designer read them.
 */
import {
  DECISION_OPERATION_ID,
  predicateExpressions,
  routeClaims,
  routeGuardFor,
  type WorkflowTask,
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

  for (const [target, claimed] of routeClaims(tasks)) {
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
