import {
  registerRuntimeValidator,
  type RuntimeValidatorContext,
  type RuntimeValidatorIssue,
} from '@aflow/schemas';

export const TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF = 'task-graph-self-consistent' as const;

// ============================================================================
// Lightweight payload shape — duplicated locally to avoid pulling Zod into the
// validator's hot path. Ajv has already accepted the payload against
// TaskGraphDraftSchema before we run; this is structural defensive shape only.
// ============================================================================

interface DraftProduce {
  key?: unknown;
}
interface DraftConsume {
  taskId?: unknown;
  outputKey?: unknown;
  bindAs?: unknown;
}
interface DraftTask {
  type?: unknown;
  taskId?: unknown;
  dependsOn?: unknown;
  produces?: unknown;
  consumes?: unknown;
  approves?: unknown;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ============================================================================
// Cycle detection (Kahn's algorithm — easier to attribute than DFS)
// ============================================================================

/**
 * Returns the set of task IDs participating in a cycle, or empty when the
 * graph is acyclic. Uses Kahn's algorithm: any node not removed by the
 * topological sort is in a cycle.
 */
function findCyclicTaskIds(adjacency: Map<string, Set<string>>): Set<string> {
  const inDegree = new Map<string, number>();
  for (const node of adjacency.keys()) {
    inDegree.set(node, 0);
  }
  for (const [, deps] of adjacency) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }
  // Reverse edge counting: actually we want in-degree where a → b means
  // "b depends on a". Recompute correctly.
  inDegree.clear();
  for (const node of adjacency.keys()) inDegree.set(node, 0);
  for (const [from, tos] of adjacency) {
    for (const to of tos) {
      // Edge from → to means `to` has `from` as a prerequisite (from points
      // at to). Increment to's in-degree.
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
      if (!adjacency.has(from)) inDegree.set(from, inDegree.get(from) ?? 0);
    }
  }

  const queue: string[] = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited.add(node);
    const outs = adjacency.get(node);
    if (!outs) continue;
    for (const next of outs) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  const cyclic = new Set<string>();
  for (const node of adjacency.keys()) {
    if (!visited.has(node)) cyclic.add(node);
  }
  return cyclic;
}

// ============================================================================
// Validator entry point
// ============================================================================

export async function taskGraphSelfConsistentValidator(
  data: unknown,
  _ctx: RuntimeValidatorContext,
): Promise<RuntimeValidatorIssue[]> {
  const issues: RuntimeValidatorIssue[] = [];

  if (!data || typeof data !== 'object') return issues;
  const tasks = asArray<DraftTask>((data as { tasks?: unknown }).tasks);
  if (tasks.length === 0) return issues;

  // Pass 1: build maps of taskId → index, and producesByTaskId.
  const indexByTaskId = new Map<string, number>();
  const producedKeysByTaskId = new Map<string, Set<string>>();

  for (const [idx, task] of tasks.entries()) {
    const taskId = asString(task.taskId);
    if (taskId === null) continue;

    // (4) duplicate taskId — emit on the second sighting onward.
    if (indexByTaskId.has(taskId)) {
      issues.push({
        code: 'custom',
        path: ['tasks', idx, 'taskId'],
        message: `Duplicate taskId "${taskId}" — task IDs must be unique within a TaskGraphDraft. The earlier definition is at tasks[${String(indexByTaskId.get(taskId))}]. Rename one of them.`,
        params: {
          runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
          violation: 'duplicate-task-id',
          taskId,
          firstIndex: indexByTaskId.get(taskId),
          duplicateIndex: idx,
        },
      });
      continue;
    }
    indexByTaskId.set(taskId, idx);

    const producedKeys = new Set<string>();
    for (const p of asArray<DraftProduce>(task.produces)) {
      const key = asString(p.key);
      if (key !== null) producedKeys.add(key);
    }
    producedKeysByTaskId.set(taskId, producedKeys);
  }

  // Build adjacency for cycle detection (from → to means "from must run
  // before to"). Edges come from the union of explicit dependsOn and
  // implicit consumes-derived dependencies.
  const adjacency = new Map<string, Set<string>>();
  for (const taskId of indexByTaskId.keys()) {
    adjacency.set(taskId, new Set());
  }

  // Pass 2: validate dependsOn + consumes against the index built above.
  for (const [idx, task] of tasks.entries()) {
    const taskId = asString(task.taskId);
    if (taskId === null) continue;
    // Skip duplicates we've already flagged — only the first occurrence
    // gets full reference checking.
    if (indexByTaskId.get(taskId) !== idx) continue;

    // (1) dependsOn references
    const dependsOn = asArray(task.dependsOn);
    for (const [depIdx, depRaw] of dependsOn.entries()) {
      const dep = asString(depRaw);
      if (dep === null) continue;
      if (!indexByTaskId.has(dep)) {
        issues.push({
          code: 'custom',
          path: ['tasks', idx, 'dependsOn', depIdx],
          message: `tasks[${String(idx)}] (taskId="${taskId}").dependsOn[${String(depIdx)}] references taskId="${dep}" but no such task is declared in the draft. Either remove the reference or add the missing task.`,
          params: {
            runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
            violation: 'dangling-depends-on',
            sourceTaskId: taskId,
            missingTaskId: dep,
          },
        });
        continue;
      }
      adjacency.get(dep)!.add(taskId);
    }

    // (1b) approves references (human tasks only — each entry must name an existing task)
    if (asString(task.type) === 'human') {
      const approves = asArray(task.approves);
      for (const [appIdx, appRaw] of approves.entries()) {
        const approvedId = asString(appRaw);
        if (approvedId === null) continue;
        if (!indexByTaskId.has(approvedId)) {
          issues.push({
            code: 'custom',
            path: ['tasks', idx, 'approves', appIdx],
            message: `tasks[${String(idx)}] (taskId="${taskId}").approves[${String(appIdx)}] references taskId="${approvedId}" but no such task is declared in the draft.`,
            params: {
              runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
              violation: 'dangling-approves',
              sourceTaskId: taskId,
              missingTaskId: approvedId,
            },
          });
          continue;
        }
        // Ordering edge: the approved task must complete before this human task.
        adjacency.get(approvedId)!.add(taskId);
      }
    }

    // (2) + (3) consumes references
    const consumes = asArray<DraftConsume>(task.consumes);
    for (const [consIdx, cons] of consumes.entries()) {
      const upstreamTaskId = asString(cons.taskId);
      const outputKey = asString(cons.outputKey);
      if (upstreamTaskId === null) continue;

      if (!indexByTaskId.has(upstreamTaskId)) {
        issues.push({
          code: 'custom',
          path: ['tasks', idx, 'consumes', consIdx, 'taskId'],
          message: `tasks[${String(idx)}] (taskId="${taskId}").consumes[${String(consIdx)}] references taskId="${upstreamTaskId}" but no such task is declared in the draft.`,
          params: {
            runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
            violation: 'dangling-consumes-task',
            sourceTaskId: taskId,
            missingTaskId: upstreamTaskId,
          },
        });
        continue;
      }

      // Human tasks have no output ports — consuming from one is always wrong.
      // The run pauses at the human task and only continues when the operator
      // approves; downstream tasks should use dependsOn, not consumes.
      const upstreamTask = tasks[indexByTaskId.get(upstreamTaskId)!];
      if (upstreamTask && asString(upstreamTask.type) === 'human') {
        issues.push({
          code: 'custom',
          path: ['tasks', idx, 'consumes', consIdx, 'taskId'],
          message:
            `tasks[${String(idx)}] (taskId="${taskId}").consumes[${String(consIdx)}] tries to read output from human task "${upstreamTaskId}", ` +
            `but human tasks have no typed output ports. ` +
            `Remove this consumes entry and use dependsOn: ["${upstreamTaskId}"] instead — ` +
            `the run pauses at the human task and only proceeds when the operator approves, ` +
            `so the downstream task will automatically run after approval without needing to read its output.`,
          params: {
            runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
            violation: 'consumes-from-human-task',
            sourceTaskId: taskId,
            upstreamTaskId,
          },
        });
        continue;
      }

      // (3) outputKey must match a `produces[*].key` on the producer.
      if (outputKey !== null) {
        const produced = producedKeysByTaskId.get(upstreamTaskId);
        if (!produced?.has(outputKey)) {
          const knownKeys =
            produced && produced.size > 0 ? [...produced].sort().join(', ') : '(none)';
          issues.push({
            code: 'custom',
            path: ['tasks', idx, 'consumes', consIdx, 'outputKey'],
            message: `tasks[${String(idx)}] (taskId="${taskId}").consumes[${String(consIdx)}] reads outputKey="${outputKey}" from taskId="${upstreamTaskId}", but that task does not declare it in produces[]. Available keys on "${upstreamTaskId}": ${knownKeys}.`,
            params: {
              runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
              violation: 'unknown-output-key',
              sourceTaskId: taskId,
              upstreamTaskId,
              outputKey,
              availableKeys: produced ? [...produced].sort() : [],
            },
          });
        }
      }

      // Implicit dependency from consumer → producer: producer must run first.
      adjacency.get(upstreamTaskId)!.add(taskId);
    }
  }

  const hasStructuralError = issues.some(
    (i) =>
      i.params?.['violation'] === 'dangling-depends-on' ||
      i.params?.['violation'] === 'dangling-consumes-task' ||
      i.params?.['violation'] === 'duplicate-task-id',
  );

  // (5) cycles. Only run when the graph is otherwise consistent — a
  // dangling reference would already be flagged and the cycle output
  // would just be noise.
  if (!hasStructuralError) {
    const cyclic = findCyclicTaskIds(adjacency);
    if (cyclic.size > 0) {
      const cyclicList = [...cyclic].sort();
      // Attribute on every task in the cycle so the runner can pick any
      // of them to break the loop.
      for (const taskId of cyclicList) {
        const idx = indexByTaskId.get(taskId);
        if (idx === undefined) continue;
        issues.push({
          code: 'custom',
          path: ['tasks', idx],
          message: `tasks[${String(idx)}] (taskId="${taskId}") participates in a cycle with: ${cyclicList.filter((t) => t !== taskId).join(', ')}. The graph induced by dependsOn + implicit consumes-edges must be acyclic. Break one of the dependencies.`,
          params: {
            runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
            violation: 'cycle',
            cyclicTaskIds: cyclicList,
          },
        });
      }
    }
  }

  // (6) Multiple root tasks — exactly one task may have no predecessors.
  // Only run when the graph is otherwise structurally sound.
  if (!hasStructuralError && !issues.some((i) => i.params?.['violation'] === 'cycle')) {
    // Tasks that appear as successors in any adjacency edge have at least one predecessor.
    const tasksWithPredecessors = new Set<string>();
    for (const successors of adjacency.values()) {
      for (const succ of successors) tasksWithPredecessors.add(succ);
    }
    const rootTaskIds = [...indexByTaskId.keys()].filter((id) => !tasksWithPredecessors.has(id));
    if (rootTaskIds.length > 1) {
      issues.push({
        code: 'custom',
        path: ['tasks'],
        message:
          `Multiple root tasks: ${rootTaskIds.map((id) => `"${id}"`).join(', ')} all have no predecessors ` +
          `(no dependsOn or consumes). A workflow must have exactly one starting task. ` +
          `If parallel execution is needed, add a single setup/initialize task and fan out ` +
          `from it using dependsOn.`,
        params: {
          runtimeValidatorKind: TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
          violation: 'multiple-root-tasks',
          rootTaskIds,
        },
      });
    }
  }

  return issues;
}

// Register at module load. The cybernetic-runtime barrel re-exports this
// file so registration happens once when the orchestrator boots.
registerRuntimeValidator(
  TASK_GRAPH_SELF_CONSISTENT_VALIDATOR_REF,
  taskGraphSelfConsistentValidator,
);
