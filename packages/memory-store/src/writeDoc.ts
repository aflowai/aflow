import type { Redis } from 'ioredis';
import type {
  MemoryDocRepository,
  MemoryDirRepository,
  MemoryDoc,
  MemoryDocPutParams,
} from '@aflow/database';
import { canonicalizePath } from '@aflow/database';
import { contentAddressForJson, type PayloadStore } from '@aflow/payload-store';
import type { TenantId, SessionId, StepExecutionId } from '@aflow/schemas';
import { publishMemoryDocEmbedJob } from '@aflow/redis';
import { computeContentHash, computeBytesHash, makePreview } from './contentUtils.js';
import {
  prepareDerivedIndexes,
  prepareStructuralIndexes,
  commitDerivedIndexes,
  type DerivationReport,
} from './derivation.js';
import { isLinkableDocType } from './linkConstants.js';
import { assertIndexNoteHash, isIndexNotePath } from './indexNoteGuard.js';
import { governedPathRefusal, type GovernedWriter } from './governedPaths.js';

/** Inline threshold — keeps Postgres lean; larger text offloads to PayloadStore. */
export const MEMORY_INLINE_THRESHOLD = 65536; // 64KB

/** Minimal structured logger — structurally satisfied by ExecutorLogger. */
export interface MemoryWriteLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Write refused by a platform governance guard (governed eval suite,
 * platform-only evidence path). Callers surface this as a validation error.
 */
export class MemoryWriteDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryWriteDeniedError';
  }
}

export type MemoryWriteContent = { kind: 'text'; text: string } | { kind: 'binary'; bytes: Buffer };

/**
 * Who produced this write. Provenance is derived from it and never
 * caller-supplied, so a writer outside a run records no run — a fabricated
 * session/step id would read back as a run that never happened.
 */
export type MemoryWriteOrigin =
  | {
      kind: 'run';
      runId: SessionId;
      stepExecutionId?: StepExecutionId;
      /** Flow step id — server-derived from the executing step. */
      stepId?: string;
    }
  /** HTTP API, platform sweep, or any other writer with no run behind it. */
  | { kind: 'external'; actor: string };

/** Origin of a write made by an executing step, read off its context. */
export function runOrigin(ctx: {
  runId: SessionId;
  stepExecutionId: StepExecutionId;
  job: { stepId?: string | undefined };
}): MemoryWriteOrigin {
  return {
    kind: 'run',
    runId: ctx.runId,
    stepExecutionId: ctx.stepExecutionId,
    ...(ctx.job.stepId !== undefined ? { stepId: ctx.job.stepId } : {}),
  };
}

export interface WriteMemoryDocParams {
  repo: MemoryDocRepository;
  /** When present, parent directories are materialized before the put. */
  dirRepo?: MemoryDirRepository;
  payloadStore: PayloadStore;
  /** Embed-job transport; when omitted, an indexable doc logs a warning instead. */
  redis?: Redis;
  log: MemoryWriteLogger;

  tenantId: TenantId;
  origin: MemoryWriteOrigin;
  /** Space scope is mandatory — persistent memory is strictly space-isolated. */
  spaceId: string;

  path: string;
  content: MemoryWriteContent;
  docType: string;
  mimeType: string;
  writeMode?: 'upsert' | 'create' | 'overwrite';
  /** Binary content forces 'disabled' regardless of this value. */
  indexing?: 'auto' | 'disabled' | 'force';
  tags?: string[];
  summary?: string | null;
  semanticType?: string | null;
  expectedHash?: string;
  /**
   * For a body whose path is derived from the body itself: the write succeeds
   * when the path is free or already holds exactly these bytes, and fails
   * rather than replacing anything else. A caller-supplied `expectedHash` is
   * a stricter assertion and wins.
   */
  refuseDifferentContent?: boolean;
  /**
   * The governed prefix this writer owns. Only the platform writer named here
   * may write under it; every other caller is refused.
   */
  governedWriter?: GovernedWriter;
}

export interface WriteMemoryDocResult {
  doc: MemoryDoc;
  /** Whether this write is what made the path live. See `MemoryDocPutResult`. */
  created: boolean;
  /** Whether the path it made live was a soft-deleted row. See `MemoryDocPutResult`. */
  revived: boolean;
  contentHash: string;
  sizeBytes: number;
  /** Non-null only for small text content (the inline lane). */
  inlineContent: string | null;
  /** Non-null when content was offloaded (large text → .json lane, binary → .bin lane). */
  payloadRef: string | null;
  preview: string | null;
  /**
   * What the derivation authority stored (links resolved/ghost split, property
   * diagnostics, incoming-link count on create). Absent on the structural lane.
   */
  derivationReport?: DerivationReport;
}

/**
 * Sanctioned linkable-content write path: resolves payload routing + parent
 * dirs, then derives chunks + outgoing links + frontmatter properties and
 * commits them atomically with the doc put.
 */
export async function writeMemoryDoc(params: WriteMemoryDocParams): Promise<WriteMemoryDocResult> {
  return writeDocInternal(params, 'linkable');
}

/**
 * Sanctioned NON-linkable structural lane (JSON / workflow / skill projections
 * and future non-database structural writers). Same commit path, but chunks
 * only — no wikilink or frontmatter parse regardless of docType. Database-
 * internal structural writers (workflowPaths, skillLifecycle, …) cannot route
 * through this lane without a package cycle, so they stay on the raw repo put
 * and are enumerated in the derivation-authority guard-test allowlist.
 */
export async function writeStructuralDoc(
  params: WriteMemoryDocParams,
): Promise<WriteMemoryDocResult> {
  return writeDocInternal(params, 'structural');
}

async function writeDocInternal(
  params: WriteMemoryDocParams,
  mode: 'linkable' | 'structural',
): Promise<WriteMemoryDocResult> {
  const { repo, dirRepo, payloadStore, redis, log, content } = params;
  // Canonicalize once at the chokepoint: the doc row is stored at the canonical
  // path (repo.put re-canonicalizes), so every path-keyed decision below — the
  // shared-curation guard and the /index.md projection — must key on the SAME
  // canonical form, or a non-canonical spelling (e.g. `index.md`) lands on the
  // canonical row while skipping the guard and the projection.
  const path = canonicalizePath(params.path);

  // Governance guards — platform-governed artifacts must not be writable
  const refusal = governedPathRefusal(path, params.governedWriter);
  if (refusal !== null) throw new MemoryWriteDeniedError(refusal);

  // Shared-curation guard: an /index.md UPDATE must carry expectedHash so a
  // concurrent curator's edit is never silently clobbered. A first create is
  // exempt (nothing to clobber). Only /index.md pays for the existence probe.
  if (isIndexNotePath(path)) {
    const existing = await repo.getByPath(path, params.spaceId);
    assertIndexNoteHash({ path, docExists: existing !== null, expectedHash: params.expectedHash });
  }

  let inlineContent: string | null = null;
  let payloadRef: string | null = null;
  let sizeBytes: number;
  let contentHash: string;
  let indexing = params.indexing ?? 'auto';

  if (content.kind === 'text') {
    inlineContent = content.text;
    sizeBytes = Buffer.byteLength(inlineContent, 'utf8');
    contentHash = computeContentHash(inlineContent);
    // The body is addressed by the digest of the bytes the store writes, so a
    // version row's payloadRef can never be rewritten with different content.
    // That address is the digest of the JSON encoding, not of the raw text the
    // doc row is hashed by. persist=true keeps it past the Redis TTL in dev;
    // GCS (prod) has no TTL — persist is a no-op there.
    if (sizeBytes > MEMORY_INLINE_THRESHOLD) {
      payloadRef = await payloadStore.storeContentAddressed({
        tenantId: params.tenantId,
        contentHash: contentAddressForJson(inlineContent),
        kind: 'body', // 'output' would collide with the step-output payload
        data: inlineContent,
        persist: true,
      });
      inlineContent = null;
    }
  } else {
    sizeBytes = content.bytes.length;
    contentHash = computeBytesHash(content.bytes);
    payloadRef = await payloadStore.storeBytesContentAddressed({
      tenantId: params.tenantId,
      contentHash,
      kind: 'body',
      data: content.bytes,
      contentType: params.mimeType,
      persist: true,
    });
    indexing = 'disabled';
  }

  const preview = inlineContent ? makePreview(inlineContent) : null;

  // Provenance is server-derived from execution context — never caller-supplied.
  const origin = params.origin;
  const provenance: NonNullable<MemoryDocPutParams['provenance']> =
    origin.kind === 'run'
      ? {
          actor: 'executor',
          sessionId: origin.runId,
          ...(origin.stepExecutionId ? { stepExecutionId: origin.stepExecutionId } : {}),
          ...(origin.stepId ? { stepId: origin.stepId } : {}),
        }
      : { actor: origin.actor };

  const putParams: MemoryDocPutParams = {
    path,
    docType: params.docType,
    mimeType: params.mimeType,
    inlineContent,
    payloadRef,
    sizeBytes,
    contentHash,
    preview,
    tags: params.tags ?? [],
    summary: params.summary ?? null,
    semanticType: params.semanticType ?? null,
    indexing,
    // Space scope is enforced from run context — never caller-supplied.
    scope: { spaceId: params.spaceId },
    provenance,
  };
  if (params.writeMode) putParams.writeMode = params.writeMode;
  const expectedHash =
    params.expectedHash ?? (params.refuseDifferentContent ? contentHash : undefined);
  if (expectedHash) putParams.expectedHash = expectedHash;

  // Ensure parent directories exist (idempotent, safe outside the doc transaction)
  if (dirRepo) {
    await dirRepo.ensureParentDirs(path, { spaceId: params.spaceId }, 'executor');
  }

  // Resolve derived indexes (chunks + links + properties) BEFORE the tx opens —
  // pure, no IO. Binary content is never scanned (its chunks are disabled); its
  // derivation.sourceHash is the bytes hash, not sha256 of an empty string.
  const derivationInput = content.kind === 'text' ? content.text : '';
  const prepared =
    mode === 'structural'
      ? prepareStructuralIndexes(derivationInput, params.docType, contentHash)
      : prepareDerivedIndexes(
          derivationInput,
          params.docType,
          path,
          content.kind === 'binary' ? contentHash : undefined,
        );

  const { doc, embedJob, report, incomingLinkCount } = await repo.withTransaction(
    async (txRepo, txLinkRepo) => {
      const d = await txRepo.put(putParams);
      const { embedJob: ej, report: rep } = await commitDerivedIndexes(
        txRepo,
        txLinkRepo,
        d,
        prepared,
        {
          payloadStore,
          log,
          tenantId: params.tenantId,
        },
      );
      // incomingLinkCount is a create-time signal — how many live links already
      // point at this new path. Only meaningful for a first-version linkable doc.
      const incoming =
        mode === 'linkable' && isLinkableDocType(d.docType) && d.currentVersion === 1
          ? await txLinkRepo.countBacklinks(d.path, d.spaceId)
          : undefined;
      return { doc: d, embedJob: ej, report: rep, incomingLinkCount: incoming };
    },
  );

  if (embedJob) {
    if (redis) {
      try {
        await publishMemoryDocEmbedJob(redis, embedJob);
      } catch (e) {
        log.warn('Failed to publish embed job', {
          docId: doc.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    } else {
      log.warn('Embed job skipped — no Redis connection provided', { docId: doc.id });
    }
  }

  const result: WriteMemoryDocResult = {
    doc,
    created: doc.created,
    revived: doc.revived,
    contentHash,
    sizeBytes,
    inlineContent,
    payloadRef,
    preview,
  };
  if (mode === 'linkable') {
    result.derivationReport =
      incomingLinkCount === undefined ? report : { ...report, incomingLinkCount };
  }
  return result;
}
