/**
 * memory.store.collect — read named documents whole, as data.
 *
 * The selection rules live in `collectMemoryDocuments` (`@aflow/schemas`),
 * which every stand-in for this store shares. This file only answers its two
 * questions from the space's documents.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  internalError,
  validationError,
} from '@aflow/executor-runtime';
import type { MemoryDocRepository } from '@aflow/database';
import {
  collectMemoryDocuments,
  type MemoryCollectInput,
  type MemoryCollectRead,
  type MemoryCollectStore,
} from '@aflow/schemas';
import { isVirtualPath } from '@aflow/memory-paths';
import { taskDraftReadRefusal } from '@aflow/memory-store';
import type { MemoryHandlerDeps } from './types.js';
import { loadBody } from './get.js';

/**
 * The payload store holding a document's body did not answer. The collect
 * cannot tell such a document from a missing one, so the read fails.
 */
class PayloadStoreUnreachable extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(
      `MEMORY_PAYLOAD_UNREACHABLE: the payload store did not answer for ${path}, so the read ` +
        `cannot tell whether the document is there — ${detail}`,
    );
  }
}

function spaceStore(
  repo: MemoryDocRepository,
  deps: MemoryHandlerDeps,
  spaceId: string,
): MemoryCollectStore {
  return {
    async list({ prefix, before, updatedSince, order, max }) {
      if (isVirtualPath(prefix)) return [];
      const rows = await repo.list({
        pathPrefix: prefix,
        pathStartsWith: prefix,
        pathBefore: before,
        order,
        scope: { spaceId },
        ...(updatedSince === undefined ? {} : { filters: { updatedAfter: updatedSince } }),
        limit: max,
      });
      return rows.map((row) => row.path);
    },
    async read(path): Promise<MemoryCollectRead> {
      if (isVirtualPath(path)) {
        return { ok: false, reason: 'A /run/ path is a run output, not a stored document.' };
      }
      const refusal = taskDraftReadRefusal(path);
      if (refusal) return { ok: false, reason: refusal };
      const doc = await repo.getByPath(path, spaceId);
      if (!doc) return { ok: false, reason: 'No document at this path.' };
      const body = await loadBody(doc, doc, deps);
      if (!body.ok) {
        if (body.unreachable) throw new PayloadStoreUnreachable(path, body.error.message);
        return { ok: false, reason: body.error.message };
      }
      if (body.kind === 'binary') {
        return { ok: false, reason: `A ${doc.docType} document holds bytes, not text.` };
      }
      return {
        ok: true,
        docType: doc.docType,
        content: body.contentJson !== undefined ? body.contentJson : (body.content ?? ''),
      };
    },
  };
}

export async function handleCollect(
  ctx: ExecutorContext,
  repo: MemoryDocRepository,
  input: MemoryCollectInput,
  deps: MemoryHandlerDeps,
): Promise<StepResult> {
  const spaceId = deps.spaceId;
  if (!spaceId) {
    return await failureWithError(
      ctx,
      validationError('MEMORY_NO_SPACE: memory operations require a space context'),
    );
  }
  try {
    const output = await collectMemoryDocuments(input, spaceStore(repo, deps, spaceId));
    return await successWithData(ctx, output);
  } catch (error) {
    if (!(error instanceof PayloadStoreUnreachable)) throw error;
    return await failureWithError(
      ctx,
      internalError(error.message, { retryable: true, details: { path: error.path } }),
    );
  }
}
