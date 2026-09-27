import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import { validationError, internalError } from '@aflow/executor-runtime';
import type { MemoryDocRepository, MemoryDirRepository } from '@aflow/database';
import type { MemoryPutInput } from '@aflow/schemas';
import { resolveMemoryPath, MemoryPathError } from '@aflow/memory-paths';
import { writeMemoryDoc, runOrigin, MemoryWriteDeniedError } from '@aflow/memory-store';
import type { MemoryHandlerDeps } from './types.js';
import { buildResolveContext } from './resolveContext.js';

export async function handlePut(
  ctx: ExecutorContext,
  repo: MemoryDocRepository,
  input: MemoryPutInput,
  deps: MemoryHandlerDeps,
  dirRepo?: MemoryDirRepository,
): Promise<StepResult> {
  const spaceId = deps.spaceId;
  if (!spaceId) {
    return await failureWithError(
      ctx,
      validationError('MEMORY_NO_SPACE: memory operations require a space context'),
    );
  }

  let text: string;

  if (input.content.inlineText !== undefined) {
    text = input.content.inlineText;
  } else if (input.content.inlineJson !== undefined) {
    text = JSON.stringify(input.content.inlineJson);
  } else if (input.content.fromPath !== undefined) {
    try {
      const resolveCtx = buildResolveContext(ctx, deps);
      // For persistent paths, we need a real memoryDocReader
      const resolveCtxWithRepo = {
        ...resolveCtx,
        memoryDocReader: {
          getByPath: async (path: string) => {
            const doc = await repo.getByPath(path, spaceId);
            if (!doc) return null;
            return {
              id: doc.id,
              path: doc.path,
              mimeType: doc.mimeType,
              sizeBytes: doc.sizeBytes,
              inlineContent: doc.inlineContent,
              payloadRef: doc.payloadRef,
              spaceId: doc.spaceId,
            };
          },
        },
      };
      const resolved = await resolveMemoryPath(input.content.fromPath, resolveCtxWithRepo);
      text = resolved.content;
    } catch (err) {
      if (err instanceof MemoryPathError) {
        return await failureWithError(
          ctx,
          validationError(`Failed to resolve fromPath "${input.content.fromPath}": ${err.message}`),
        );
      }
      throw err;
    }
  } else {
    return await failureWithError(ctx, validationError('No content provided'));
  }

  let result;
  try {
    result = await writeMemoryDoc({
      repo,
      ...(dirRepo ? { dirRepo } : {}),
      payloadStore: deps.payloadStore,
      redis: deps.redis,
      log: ctx.log,
      tenantId: ctx.tenantId,
      origin: runOrigin(ctx),
      // Space scope is enforced from run context via deps.spaceId
      spaceId,
      path: input.path,
      content: { kind: 'text', text },
      docType: input.docType,
      mimeType: input.mimeType,
      writeMode: input.writeMode,
      indexing: input.indexing,
      tags: input.tags ?? [],
      summary: input.summary ?? null,
      semanticType: input.semanticType ?? null,
      ...(input.expectedHash ? { expectedHash: input.expectedHash } : {}),
    });
  } catch (err) {
    if (err instanceof MemoryWriteDeniedError) {
      return await failureWithError(ctx, validationError(err.message));
    }
    const message = err instanceof Error ? err.message : String(err);
    // Surface known domain errors (MEMORY_ALREADY_EXISTS, etc.) as user-visible
    if (message.startsWith('MEMORY_')) {
      return await failureWithError(ctx, validationError(message));
    }
    // Log server-side for operators (no raw SQL/params — just the error message)
    ctx.log.error('memory.store.put failed', {
      path: input.path,
      error: message.slice(0, 500),
    });
    return await failureWithError(
      ctx,
      internalError('Failed to write document — see logs for path', {
        retryable: false,
      }),
    );
  }

  const { doc, contentHash, inlineContent, payloadRef, preview, derivationReport } = result;

  const DATA_PREVIEW_BYTES = 1024;
  const output: Record<string, unknown> = {
    id: doc.id,
    path: doc.path,
    version: doc.currentVersion,
    contentHash: doc.contentHash ?? contentHash,
    sizeBytes: doc.sizeBytes,
    embeddingStatus: doc.embeddingStatus,
  };
  if (inlineContent) {
    output['data'] = inlineContent;
  } else if (payloadRef) {
    output['data'] = preview ?? '';
    if (preview && preview.length >= DATA_PREVIEW_BYTES) {
      output['data'] = preview.slice(0, DATA_PREVIEW_BYTES) + '…[truncated]';
    }
    // dataRef still stored internally for the sibling-ref resolver,
    output['dataRef'] = payloadRef;
  }
  if (derivationReport?.links) output['links'] = derivationReport.links;
  if (derivationReport?.properties) output['properties'] = derivationReport.properties;
  if (derivationReport?.incomingLinkCount !== undefined) {
    output['incomingLinkCount'] = derivationReport.incomingLinkCount;
  }

  return await successWithData(ctx, output);
}
