import type { WorkflowPatchInput } from '@aflow/schemas';

export const WORKFLOW_METADATA_PATH_PREFIXES = [
  '/name',
  '/description',
  '/assignedAgent',
  '/taskAssignments',
  '/budget',
  '/status',
];

export function isMetadataOnlyOp(op: WorkflowPatchInput['operations'][number]): boolean {
  const path = op.path;
  const matches = (p: string): boolean =>
    WORKFLOW_METADATA_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
  if (op.op === 'move' || op.op === 'copy') {
    return matches(op.path) && Boolean(op.from && matches(op.from));
  }
  return matches(path);
}

export function patchTouchesDefinition(ops: WorkflowPatchInput['operations']): boolean {
  return ops.some((op) => !isMetadataOnlyOp(op));
}

export function patchTouchesMetadata(ops: WorkflowPatchInput['operations']): boolean {
  return ops.some((op) => isMetadataOnlyOp(op));
}

const TASK_PATH = /^\/tasks\/([^/]+)(\/.*)?$/;

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function taskIdOf(value: unknown): string | undefined {
  const id = (value as { taskId?: unknown } | null)?.taskId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * `/tasks/{taskId}/...` rewritten to `/tasks/{index}/...`, so a task can be
 * addressed by the id the author knows rather than a position.
 *
 * Operations apply in order and positions shift as tasks are added and removed,
 * so each id is resolved against the task list as the operations before it
 * leave it — never against the list as stored. Indices, `-` and ids that name
 * no task pass through unchanged, and fail or apply exactly as they would have.
 */
export function resolveTaskIdPaths(
  ops: WorkflowPatchInput['operations'],
  tasks: ReadonlyArray<{ taskId: string }>,
): WorkflowPatchInput['operations'] {
  const ids: Array<string | undefined> = tasks.map((t) => t.taskId);

  const resolve = (path: string): string => {
    const match = TASK_PATH.exec(path);
    const segment = match?.[1];
    if (segment === undefined || segment === '-' || /^\d+$/.test(segment)) return path;
    const index = ids.indexOf(unescapePointer(segment));
    return index === -1 ? path : `/tasks/${String(index)}${match?.[2] ?? ''}`;
  };

  /** The position a whole-task path names, or undefined for a deeper path. */
  const wholeTask = (path: string): number | '-' | undefined => {
    const match = TASK_PATH.exec(path);
    if (!match || match[2] !== undefined) return undefined;
    if (match[1] === '-') return '-';
    return /^\d+$/.test(match[1] ?? '') ? Number(match[1]) : undefined;
  };

  const track = (op: WorkflowPatchInput['operations'][number]): void => {
    if (op.path === '/tasks' && (op.op === 'replace' || op.op === 'add')) {
      const next = Array.isArray(op.value) ? op.value.map(taskIdOf) : [];
      ids.splice(0, ids.length, ...next);
      return;
    }
    const idField = /^\/tasks\/(\d+)\/taskId$/.exec(op.path);
    if (idField && (op.op === 'replace' || op.op === 'add')) {
      ids[Number(idField[1])] = typeof op.value === 'string' ? op.value : undefined;
      return;
    }
    const target = wholeTask(op.path);
    const source = op.from !== undefined ? wholeTask(op.from) : undefined;
    const insert = (at: number | '-', id: string | undefined) => {
      if (at === '-') ids.push(id);
      else ids.splice(at, 0, id);
    };
    if (op.op === 'add' && target !== undefined) insert(target, taskIdOf(op.value));
    if (op.op === 'remove' && typeof target === 'number') ids.splice(target, 1);
    if (op.op === 'replace' && typeof target === 'number') ids[target] = taskIdOf(op.value);
    if (
      (op.op === 'move' || op.op === 'copy') &&
      typeof source === 'number' &&
      target !== undefined
    ) {
      const moved = ids[source];
      if (op.op === 'move') ids.splice(source, 1);
      insert(target, moved);
    }
  };

  return ops.map((op) => {
    const resolved = {
      ...op,
      path: resolve(op.path),
      ...(op.from !== undefined ? { from: resolve(op.from) } : {}),
    };
    track(resolved);
    return resolved;
  });
}
