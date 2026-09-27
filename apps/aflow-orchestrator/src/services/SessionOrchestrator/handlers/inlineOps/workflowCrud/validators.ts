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
