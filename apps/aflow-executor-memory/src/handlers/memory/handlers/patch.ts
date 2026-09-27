/**
 * memory.store.patch - partial update via json_patch / text_patch.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import { internalError, notFoundError, validationError } from '@aflow/executor-runtime';
import type { MemoryDocRepository } from '@aflow/database';
import type { MemoryPatchInput } from '@aflow/schemas';
import { publishMemoryDocEmbedJob } from '@aflow/redis';
import { contentAddressForJson } from '@aflow/payload-store';
import {
  makePreview,
  computeContentHash,
  isBinaryPayloadRef,
  prepareDerivedIndexes,
  commitDerivedIndexes,
  governedPathRefusal,
  isIndexNotePath,
  MEMORY_HASH_REQUIRED_MESSAGE,
} from '@aflow/memory-store';
import { stripUndefined } from '../utils.js';
import { applyJsonPatch } from '@aflow/lib';
import type { MemoryHandlerDeps } from './types.js';

export async function handlePatch(
  ctx: ExecutorContext,
  repo: MemoryDocRepository,
  input: MemoryPatchInput,
  deps: MemoryHandlerDeps,
): Promise<StepResult> {
  const target = input.target;

  // Both sites are load-bearing: a governed path reached by id names nothing
  // here, and one reached by path can still canonicalize onto a governed row.
  const requestedRefusal = governedPathRefusal(target.path);
  if (requestedRefusal !== null) {
    return await failureWithError(ctx, validationError(requestedRefusal));
  }

  const doc = deps.spaceId
    ? target.id
      ? await repo.getById(target.id, deps.spaceId)
      : await repo.getByPath(target.path!, deps.spaceId)
    : null;

  if (!doc) {
    return await failureWithError(
      ctx,
      notFoundError(`MEMORY_NOT_FOUND: no document at ${JSON.stringify(target)}`, { target }),
    );
  }

  // Ahead of the lane check: a governed document refuses the edit for a reason
  // the caller can act on, whichever lane its body happens to live on.
  const resolvedRefusal = governedPathRefusal(doc.path);
  if (resolvedRefusal !== null) {
    return await failureWithError(ctx, validationError(resolvedRefusal));
  }

  // A patch is a text edit. On the binary lane there is no text to edit, and
  // reading the bytes through the JSON lane would write a decimal dump of them
  // back over the document.
  const offloadedRef = doc.inlineContent === null ? doc.payloadRef : null;
  if (offloadedRef !== null && isBinaryPayloadRef(offloadedRef)) {
    return await failureWithError(
      ctx,
      validationError(
        `MEMORY_BINARY_NOT_PATCHABLE: ${doc.path} holds raw bytes (${doc.mimeType}), which no ` +
          'text or JSON patch can edit. Replace the whole file with memory.store.put.',
        { path: doc.path, mimeType: doc.mimeType },
      ),
    );
  }

  // A patch is always an update of an existing doc, so /index.md patches must
  // carry expectedHash — shared curation must not silently clobber.
  if (isIndexNotePath(doc.path) && !input.expectedHash) {
    return await failureWithError(ctx, validationError(MEMORY_HASH_REQUIRED_MESSAGE));
  }

  // Read-time only, so the caller hears about a stale hash before the patch is
  // computed. It is NOT the guard — `expectedHash` rides into the write below,
  // where the repository asserts it inside the same transaction. Checking here
  // and writing unconditionally is check-then-act: a writer landing between the
  // two is lost silently.
  if (input.expectedHash && doc.contentHash !== input.expectedHash) {
    return await failureWithError(
      ctx,
      internalError(
        `MEMORY_HASH_MISMATCH: expected ${input.expectedHash}, got ${doc.contentHash ?? 'null'}`,
        { retryable: false },
      ),
    );
  }

  let currentContent: string;
  if (doc.inlineContent !== null) {
    currentContent = doc.inlineContent;
  } else if (doc.payloadRef) {
    const payload = await deps.payloadStore.retrieve(doc.payloadRef);
    currentContent = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } else {
    currentContent = '';
  }

  let newContent: string;

  if (input.patch.type === 'json_patch') {
    const parsed = JSON.parse(currentContent) as unknown;
    const ops = input.patch.operations.map((o) =>
      stripUndefined(o as Record<string, unknown>),
    ) as Array<{
      op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
      path: string;
      value?: unknown;
      from?: string;
    }>;
    const patched = applyJsonPatch(parsed, ops);
    newContent = JSON.stringify(patched);
  } else {
    const lines = currentContent.split('\n');
    const before = lines.slice(0, input.patch.lineRange.startLine);
    const after = lines.slice(input.patch.lineRange.endLine);
    const replacementLines = input.patch.replacement.split('\n');
    newContent = [...before, ...replacementLines, ...after].join('\n');
  }

  const sizeBytes = Buffer.byteLength(newContent, 'utf8');
  const contentHash = computeContentHash(newContent);

  let inlineContent: string | null = newContent;
  let payloadRef: string | null = null;

  const INLINE_THRESHOLD = 65536;
  if (sizeBytes > INLINE_THRESHOLD) {
    // `kind: 'body'`, content-addressed and persisted — the shape
    // `writeStructuralDoc` uses. Storing under the step's own `output` address
    // put a document body where that step's result also writes, and a doc body
    // outliving its run needs retention a step output does not have.
    payloadRef = await deps.payloadStore.storeContentAddressed({
      tenantId: ctx.tenantId,
      contentHash: contentAddressForJson(newContent),
      kind: 'body',
      data: newContent,
      persist: true,
    });
    inlineContent = null;
  }

  const scope: Parameters<MemoryDocRepository['put']>[0]['scope'] = { spaceId: doc.spaceId };
  if (doc.userId) scope.userId = doc.userId;
  if (doc.agentId) scope.agentId = doc.agentId;
  if (doc.sessionId) scope.sessionId = doc.sessionId;

  const patchPutParams: Parameters<MemoryDocRepository['put']>[0] = {
    path: doc.path,
    // The compare-and-swap. Without it the pre-check above is advisory and a
    // concurrent patch is overwritten with no error anywhere.
    ...(input.expectedHash !== undefined ? { expectedHash: input.expectedHash } : {}),
    docType: doc.docType,
    mimeType: doc.mimeType,
    inlineContent,
    payloadRef,
    sizeBytes,
    contentHash,
    preview: inlineContent ? makePreview(inlineContent) : null,
    tags: doc.tags,
    summary: doc.summary,
    indexing: doc.indexingMode,
    scope,
  };

  // Derive chunks + links + properties from the patched content BEFORE the tx.
  const prepared = prepareDerivedIndexes(newContent, doc.docType, doc.path);

  const {
    doc: updated,
    embedJob,
    report,
  } = await repo.withTransaction(async (txRepo, txLinkRepo) => {
    const d = await txRepo.put(patchPutParams);
    const { embedJob: ej, report: rep } = await commitDerivedIndexes(
      txRepo,
      txLinkRepo,
      d,
      prepared,
      {
        payloadStore: deps.payloadStore,
        log: ctx.log,
        tenantId: ctx.tenantId,
      },
    );
    return { doc: d, embedJob: ej, report: rep };
  });

  if (embedJob) {
    try {
      await publishMemoryDocEmbedJob(deps.redis, embedJob);
    } catch (e) {
      ctx.log.warn('Failed to publish embed job', {
        docId: updated.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const output: Record<string, unknown> = {
    id: updated.id,
    path: updated.path,
    version: updated.currentVersion,
    contentHash: updated.contentHash ?? contentHash,
    sizeBytes: updated.sizeBytes,
    embeddingStatus: updated.embeddingStatus,
  };
  if (report.links) output['links'] = report.links;
  if (report.properties) output['properties'] = report.properties;

  return await successWithData(ctx, output);
}
