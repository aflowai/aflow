/**
 * memory.store.delete - soft-delete documents or directories.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError, validationError } from '@aflow/executor-runtime';
import type { MemoryDocRepository, MemoryDirRepository } from '@aflow/database';
import type { MemoryDeleteInput } from '@aflow/schemas';
import { notFoundError } from '@aflow/executor-runtime';
import { governedPathRefusal, governedSubtreeRefusal } from '@aflow/memory-store';
import type { MemoryHandlerDeps } from './types.js';

export async function handleDelete(
  ctx: ExecutorContext,
  repo: MemoryDocRepository,
  dirRepo: MemoryDirRepository,
  input: MemoryDeleteInput,
  _deps: MemoryHandlerDeps,
): Promise<StepResult> {
  const target = input.target;
  const runSpaceId = ctx.job.spaceId;

  // Both sites are load-bearing: a governed path reached by id names nothing
  // here, and one reached by path can still canonicalize onto a governed row.
  const requestedRefusal = governedPathRefusal(target.path);
  if (requestedRefusal !== null) {
    return await failureWithError(ctx, validationError(requestedRefusal));
  }

  const requestPath = target.path;

  // Try to resolve as a document first
  const doc = runSpaceId
    ? target.id
      ? await repo.getById(target.id, runSpaceId)
      : await repo.getByPath(requestPath!, runSpaceId)
    : null;

  if (doc) {
    const resolvedRefusal = governedPathRefusal(doc.path);
    if (resolvedRefusal !== null) {
      return await failureWithError(ctx, validationError(resolvedRefusal));
    }

    await repo.softDelete(doc.id, doc.spaceId);
    await repo.deleteChunksForDoc(doc.id);
    return await successWithData(ctx, {
      id: doc.id,
      path: doc.path,
      deleted: true,
      entryType: 'document',
    });
  }

  // Not a document — try as a directory (path-based only; need a path, not just id)
  if (runSpaceId && requestPath) {
    const dir = await dirRepo.getDir(requestPath, runSpaceId);
    if (dir) {
      const subtreeRefusal = governedSubtreeRefusal(dir.path);
      if (subtreeRefusal !== null) {
        return await failureWithError(ctx, validationError(subtreeRefusal));
      }
      const deleted = await dirRepo.deleteDir(dir.path, runSpaceId, input.recursive);
      return await successWithData(ctx, {
        id: dir.id,
        path: dir.path,
        deleted,
        entryType: 'directory',
      });
    }
  }

  return await failureWithError(
    ctx,
    notFoundError(
      `MEMORY_NOT_FOUND: no document or directory found for target ${JSON.stringify(target)}`,
    ),
  );
}
