/**
 * memory.store.mkdir - create directories explicitly.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError, validationError } from '@aflow/executor-runtime';
import type { MemoryDirRepository } from '@aflow/database';
import type { MemoryMkdirInput } from '@aflow/schemas';
import type { MemoryHandlerDeps } from './types.js';

export async function handleMkdir(
  ctx: ExecutorContext,
  dirRepo: MemoryDirRepository,
  input: MemoryMkdirInput,
  deps: MemoryHandlerDeps,
): Promise<StepResult> {
  const spaceId = deps.spaceId;
  if (!spaceId) {
    return await failureWithError(
      ctx,
      validationError('MEMORY_NO_SPACE: memory operations require a space context'),
    );
  }

  const result = await dirRepo.mkdir({
    path: input.path,
    description: input.description,
    metadata: input.metadata,
    scope: { spaceId },
    parents: input.parents,
    tags: input.tags,
    createdByActor: 'executor',
  });

  return await successWithData(ctx, {
    id: result.id,
    path: result.path,
    created: result.created,
  });
}
