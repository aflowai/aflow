/**
 * Where a render's bytes go.
 *
 * A step output is a run artifact — summarised, evicted, gone. Bytes that live
 * only there cannot be re-read, re-cut, or found again, and returning them
 * inline spends the agent's turn on base64 it can do nothing with. So every
 * render is filed as a Memory document, with its receipt and a text note, in
 * the same operation that made it; the step returns pinned references to those
 * documents.
 *
 * Nothing about the destination is caller-supplied, and nothing about it comes
 * from the delivered file either. The leaf name is derived from the request
 * identity alone — the container the provider chose rides the document's
 * mimeType — which is what makes an overwrite impossible: two different
 * requests cannot resolve to one path, one request cannot resolve to two, and a
 * re-dispatch that adopts the paid job resolves to the path it already wrote.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from '@aflow/redis';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError, internalError, successWithData } from '@aflow/executor-runtime';
import {
  AiMediaOutputSchema,
  MediaReceiptDocumentSchema,
  deriveMediaAssetId,
  type AflowError,
  type AiMediaOutput,
  type MediaAsset,
  type MediaAssetKind,
  type MediaGenerationReceipt,
  type ProviderNativeHandle,
} from '@aflow/schemas';
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import {
  readMemoryBodyBytes,
  runOrigin,
  saveBytesToMemoryDoc,
  GENERATED_MEDIA_PREFIX,
  type SaveBytesToMemoryDocParams,
  type SaveBytesToMemoryDocResult,
} from '@aflow/memory-store';
import type { MediaSpend } from '@aflow/ai-client';
import type { HandlerDeps } from './types.js';
import { buildMediaSidecar } from './mediaSidecar.js';

export interface MediaPersistenceTarget {
  db: PostgresJsDatabase;
  payloadStore: HandlerDeps['payloadStore'];
  redis?: Redis | undefined;
  spaceId: string;
}

export type MediaPersistenceResolution =
  { ok: true; target: MediaPersistenceTarget } | { ok: false; error: AflowError };

/**
 * Resolved BEFORE the provider is called. A render whose bytes have nowhere to
 * land is refused rather than paid for and thrown away.
 */
export function resolveMediaPersistence(
  ctx: ExecutorContext,
  deps: HandlerDeps,
): MediaPersistenceResolution {
  if (!deps.db) {
    return {
      ok: false,
      error: internalError(
        'Generated media is stored as a Memory document and this executor has no database connection.',
        { retryable: false },
      ),
    };
  }
  if (ctx.spaceId === undefined) {
    return {
      ok: false,
      error: internalError(
        'Generated media is stored in the space that asked for it, and this job carries no space.',
        { retryable: false },
      ),
    };
  }
  return {
    ok: true,
    target: {
      db: deps.db,
      payloadStore: deps.payloadStore,
      redis: deps.redis,
      spaceId: ctx.spaceId,
    },
  };
}

/** One candidate of one provider request, as it came off the route. */
export interface MediaCandidateBytes {
  bytes: Buffer;
  mimeType: string;
  revisedPrompt?: string | undefined;
  providerNative: ProviderNativeHandle;
}

export interface PersistMediaProductionParams {
  ctx: ExecutorContext;
  target: MediaPersistenceTarget;
  kind: MediaAssetKind;
  candidates: MediaCandidateBytes[];
  /** Everything about the request except where its assets ended up. */
  receipt: MediaGenerationReceipt;
}

/**
 * The directory every render of one session is filed under. A session is the
 * only grouping the media operations carry today, and it is never shared with
 * another session.
 */
function renderDirectory(runId: string): string {
  return `${GENERATED_MEDIA_PREFIX}${runId}`;
}

/**
 * The name the receipt and the note share with the assets they describe. Taken
 * off a derived asset id rather than hashed a second time — the derivation is
 * the schema's, and a private copy of it would drift the note away from the
 * bytes it documents.
 */
function renderStem(requestKey: string): string {
  const firstCandidate = deriveMediaAssetId(requestKey, 0);
  return firstCandidate.slice(0, firstCandidate.lastIndexOf('-'));
}

/** Where the production of one request keeps its own record of itself. */
function receiptPath(runId: string, requestKey: string): string {
  return `${renderDirectory(runId)}/take-${renderStem(requestKey)}.receipt.json`;
}

/**
 * Undo the documents a production wrote before it hit something it could not
 * finish. A stored asset is never chunked and never embedded, so one left
 * without its receipt and note is unreachable by search, by link and by the
 * step output that was never returned — bytes nothing can ever name again.
 *
 * Every path is put back the way this call found it, which is not the same for
 * all of them. A path this call inserted goes entirely: nothing existed there
 * to keep. A path it revived had a history before it — an earlier production's
 * asset, deleted rather than abandoned — so it is re-deleted and its versions
 * are left where they are. A path that was already live is left untouched: it
 * belongs to a production that did complete, and the same-content refusal has
 * already proved the bytes under it are the ones this call would have written.
 */
async function discardProduction(
  ctx: ExecutorContext,
  target: MediaPersistenceTarget,
  written: SaveBytesToMemoryDocResult[],
): Promise<void> {
  const repo = createMemoryDocRepository(target.db, createTenantContext(ctx.tenantId));
  for (const doc of written) {
    if (!doc.created) continue;
    try {
      if (doc.revived) {
        await repo.softDelete(doc.docId, target.spaceId);
        await repo.deleteChunksForDoc(doc.docId);
      } else {
        await repo.hardDelete(doc.docId, target.spaceId);
      }
    } catch (error) {
      ctx.log.warn('A partly written render could not be cleaned up', {
        path: doc.savedTo,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function persistMediaProduction(
  params: PersistMediaProductionParams,
): Promise<AiMediaOutput> {
  const { ctx, target, kind, candidates, receipt } = params;
  const { requestKey } = receipt.execution;
  const directory = renderDirectory(ctx.runId);
  const stem = renderStem(requestKey);

  const shared = {
    db: target.db,
    payloadStore: target.payloadStore,
    ...(target.redis ? { redis: target.redis } : {}),
    log: ctx.log,
    tenantId: ctx.tenantId,
    origin: runOrigin(ctx),
    spaceId: target.spaceId,
    contentType: null,
    governedWriter: 'generated_media',
  } as const;

  const written: SaveBytesToMemoryDocResult[] = [];
  async function file(
    document: Omit<SaveBytesToMemoryDocParams, keyof typeof shared>,
  ): Promise<SaveBytesToMemoryDocResult> {
    const stored = await saveBytesToMemoryDoc({ ...shared, ...document });
    written.push(stored);
    return stored;
  }

  try {
    const assets: MediaAsset[] = [];
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const assetId = deriveMediaAssetId(requestKey, candidateIndex);
      const stored = await file({
        // No extension: the container is the provider's choice at delivery and
        // is no part of the request the address is derived from, so spelling it
        // into the leaf would give one paid request a second address whenever
        // the route answered in a different format.
        path: `${directory}/take-${assetId}`,
        // The kind is the docType so nothing downstream tries to chunk or embed
        // the bytes; the lane is declared rather than sniffed, because a short
        // clip whose bytes happen to decode as UTF-8 is still a clip.
        docType: kind,
        mimeType: candidate.mimeType,
        indexing: 'disabled',
        refuseDifferentContent: true,
        tags: ['generated_media', kind],
        content: { kind: 'binary', bytes: candidate.bytes },
      });
      assets.push({
        assetId,
        candidateIndex,
        docId: stored.docId,
        path: stored.savedTo,
        version: stored.version,
        contentHash: stored.contentHash,
        kind,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        ...(candidate.revisedPrompt !== undefined
          ? { revisedPrompt: candidate.revisedPrompt }
          : {}),
        providerNative: candidate.providerNative,
      });
    }

    const receiptDocument = MediaReceiptDocumentSchema.parse({ assets, receipt });
    const storedReceipt = await file({
      path: receiptPath(ctx.runId, requestKey),
      docType: 'json',
      mimeType: 'application/json',
      // The note is what a search should surface; embedding the receipt as well
      // would return both for every query about the same render.
      indexing: 'disabled',
      tags: ['generated_media', 'render_receipt'],
      content: { kind: 'text', text: JSON.stringify(receiptDocument, null, 2) },
    });

    await file({
      path: `${directory}/take-${stem}.md`,
      docType: 'markdown',
      mimeType: 'text/markdown',
      indexing: 'auto',
      tags: ['generated_media', 'render_notes', kind],
      content: {
        kind: 'text',
        text: buildMediaSidecar({
          kind,
          operationId: ctx.operationId,
          assets,
          receipt,
          receiptPath: storedReceipt.savedTo,
        }),
      },
    });

    return AiMediaOutputSchema.parse({
      assets,
      receipt,
      receiptRef: {
        path: storedReceipt.savedTo,
        version: storedReceipt.version,
        contentHash: storedReceipt.contentHash,
      },
    });
  } catch (error) {
    await discardProduction(ctx, target, written);
    throw error;
  }
}

export interface CollectMediaProductionParams {
  ctx: ExecutorContext;
  target: MediaPersistenceTarget;
  /** The receipt's `execution.requestKey` — what every path of the production is derived from. */
  requestKey: string;
}

/**
 * The production already filed for one request, or null when there is none.
 *
 * Nothing about a production's addresses comes from the worker that filed it,
 * so a second worker holding the same finished render can read what the first
 * one wrote instead of writing it again. The receipt is the whole record — it
 * carries the assets it was written beside — so nothing is re-derived here, and
 * a render that two workers deliver still has one set of documents at one
 * version.
 */
export async function collectMediaProduction(
  params: CollectMediaProductionParams,
): Promise<AiMediaOutput | null> {
  const { ctx, target, requestKey } = params;
  const repo = createMemoryDocRepository(target.db, createTenantContext(ctx.tenantId));
  const doc = await repo.getByPath(receiptPath(ctx.runId, requestKey), target.spaceId);
  if (doc === null) return null;
  const { contentHash } = doc;
  if (contentHash === null) return null;
  const body = await readMemoryBodyBytes(doc, target.payloadStore);
  if (body === null) return null;
  const receiptDocument = MediaReceiptDocumentSchema.parse(JSON.parse(body.toString('utf-8')));
  return AiMediaOutputSchema.parse({
    ...receiptDocument,
    receiptRef: { path: doc.path, version: doc.currentVersion, contentHash },
  });
}

export interface DeliverMediaProductionParams extends PersistMediaProductionParams {
  /** What this render cost, reported on the step when the bytes land. */
  spend: MediaSpend;
  /** What the lane can name the paid render by, carried on a failure. */
  failureDetails?: Record<string, unknown>;
}

/**
 * Turn a finished render into the step's result.
 *
 * Every lane reaches this point holding bytes the provider has already been
 * paid for, so a storage failure here is not a failed render — it is a render
 * that exists, that nobody can read, and that a retry buys again. Both lanes
 * say that in the same words: the same failure must not read as an ordinary
 * error on one operation and as a spent budget on another.
 */
export async function deliverMediaProduction(
  params: DeliverMediaProductionParams,
): Promise<StepResult> {
  const { ctx, spend, failureDetails, ...production } = params;
  try {
    const output = await persistMediaProduction({ ctx, ...production });
    return await successWithData(ctx, output, { costJson: spend.usageBreakdown });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    ctx.log.error('A finished render could not be filed in Memory', {
      ...failureDetails,
      error: cause,
    });
    return await failureWithError(
      ctx,
      internalError(
        'This render finished at the provider but its bytes could not be stored, so the step has ' +
          'no asset to return. The render is paid for either way: no automatic retry re-runs this ' +
          'step, and retrying the run derives a fresh request and buys a second render rather than ' +
          're-collecting this one.',
        { retryable: false, details: { ...failureDetails, cause } },
      ),
    );
  }
}
