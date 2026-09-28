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

/**
 * `/tasks/{taskId}/...` rewritten to `/tasks/{index}/...`, so a task can be
 * addressed by the id the author knows rather than a position that shifts as
 * tasks are added. Indices, `-` and ids that name no task pass through
 * unchanged, and fail or apply exactly as they would have.
 */
export function resolveTaskIdPaths(
  ops: WorkflowPatchInput['operations'],
  tasks: ReadonlyArray<{ taskId: string }>,
): WorkflowPatchInput['operations'] {
  const indexOf = new Map(tasks.map((t, i) => [t.taskId, i]));
  const resolve = (path: string): string => {
    const match = TASK_PATH.exec(path);
    const segment = match?.[1];
    if (segment === undefined || segment === '-' || /^\d+$/.test(segment)) return path;
    const index = indexOf.get(segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    return index === undefined ? path : `/tasks/${String(index)}${match?.[2] ?? ''}`;
  };
  return ops.map((op) => ({
    ...op,
    path: resolve(op.path),
    ...(op.from !== undefined ? { from: resolve(op.from) } : {}),
  }));
}
