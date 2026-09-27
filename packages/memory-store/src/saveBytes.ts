import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDocRepository,
  createMemoryDirRepository,
  createTenantContext,
  canonicalizePath,
} from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import { writeMemoryDoc, MemoryWriteDeniedError, type WriteMemoryDocParams } from './writeDoc.js';
import { isBinaryContent } from './binaryDetection.js';

const MEMORY_VIRTUAL_PREFIX = '/run/';

export interface SaveBytesToMemoryDocParams {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
  redis?: Redis | undefined;
  log: WriteMemoryDocParams['log'];
  tenantId: WriteMemoryDocParams['tenantId'];
  origin: WriteMemoryDocParams['origin'];
  spaceId: string;
  /** Memory path to write to; a `/workspace/` mount prefix is stripped. */
  path: string;
  docType?: string | undefined;
  mimeType?: string | undefined;
  indexing?: 'auto' | 'disabled' | 'force' | undefined;
  tags: string[];
  /**
   * The full body to persist. `text` is caller-vouched UTF-8 and always lands
   * on the text lane regardless of the path's extension; `binary` is the same
   * promise in the other direction; `bytes` runs binary detection (content
   * sniff + extension) because the caller genuinely does not know which it is.
   */
  content:
    | { kind: 'text'; text: string }
    | { kind: 'bytes'; bytes: Buffer }
    | { kind: 'binary'; bytes: Buffer };
  /** Raw Content-Type header value (may carry parameters), when known. */
  contentType: string | null;
  /** See `WriteMemoryDocParams.refuseDifferentContent`. */
  refuseDifferentContent?: boolean | undefined;
  /** See `WriteMemoryDocParams.governedWriter`. */
  governedWriter?: WriteMemoryDocParams['governedWriter'] | undefined;
}

export interface SaveBytesToMemoryDocResult {
  /** Canonical Memory path the body was written to. */
  savedTo: string;
  sizeBytes: number;
  docId: string;
  /**
   * The version this write created. Versions are immutable, so `savedTo` plus
   * this number plus `contentHash` is the reference that keeps resolving to
   * these exact bytes after the path is overwritten.
   */
  version: number;
  contentHash: string;
  mimeType: string;
  docType: string;
  /**
   * Whether this call is what made the path live. A caller that undoes its own
   * writes removes exactly the documents it created, and a version above the
   * first is no evidence either way — a revived document is one this call
   * created at version two.
   */
  created: boolean;
  /**
   * Whether the path this call made live was a deleted document rather than a
   * free path. Undoing a revival means putting the document back the way it was
   * found — deleted — not erasing the versions somebody else wrote.
   */
  revived: boolean;
}

/** Strip parameters ("; charset=utf-8") off a Content-Type header value. */
function parseMimeType(contentType: string | null): string | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  return mime ? mime : undefined;
}

/** Default Memory docType for a text-lane doc, derived from its MIME type. */
function docTypeFromMime(mimeType: string): string {
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) return 'json';
  if (mimeType === 'application/x-ndjson') return 'ndjson';
  if (mimeType === 'text/csv') return 'dataset';
  if (mimeType === 'text/markdown') return 'markdown';
  return 'text';
}

/**
 * Agents address Memory at `/workspace/<memoryPath>`; strip that mount prefix
 * so `/workspace/data/x.csv` resolves to the Memory doc at `/data/x.csv`. A
 * path without the prefix is treated as a direct Memory path.
 */
export function workspacePathToMemoryPath(path: string): string {
  let p = path;
  if (p === '/workspace') {
    p = '/';
  } else if (p.startsWith('/workspace/')) {
    p = p.slice('/workspace'.length);
  }
  return canonicalizePath(p);
}

/**
 * Persist a fetched/downloaded body to a Memory doc — the platform's
 * large-file currency (readable via memory.store.get, sandbox-mountable via
 * the compute workspace inputs). Shared by every executor that lands external
 * bytes in Memory; throws `MemoryWriteDeniedError` / `MEMORY_*` errors raw —
 * callers translate to their own error envelope.
 */
export async function saveBytesToMemoryDoc(
  params: SaveBytesToMemoryDocParams,
): Promise<SaveBytesToMemoryDocResult> {
  const { db, payloadStore, redis, spaceId, content, contentType } = params;

  const path = workspacePathToMemoryPath(params.path);
  // Enforced on the CANONICAL path — schema-level refines catch only the
  // literal spelling, not `//run/x`, `run/x`, or `/workspace/../run/x`.
  if (path === '/run' || path.startsWith(MEMORY_VIRTUAL_PREFIX)) {
    throw new MemoryWriteDeniedError(
      `Cannot save to the virtual /run/ namespace ("${params.path}" resolves to "${path}") — ` +
        'use a persistent path like /workspace/refs/spec.md',
    );
  }
  const binary =
    content.kind === 'binary' || (content.kind === 'bytes' && isBinaryContent(content.bytes, path));
  const mimeType =
    params.mimeType ??
    parseMimeType(contentType) ??
    (binary ? 'application/octet-stream' : 'text/plain');
  const docType = params.docType ?? (binary ? 'binary' : docTypeFromMime(mimeType));

  const tenantCtx = createTenantContext(params.tenantId);
  const repo = createMemoryDocRepository(db, tenantCtx);
  const dirRepo = createMemoryDirRepository(db, tenantCtx);

  const result = await writeMemoryDoc({
    repo,
    dirRepo,
    payloadStore,
    ...(redis ? { redis } : {}),
    log: params.log,
    tenantId: params.tenantId,
    origin: params.origin,
    spaceId,
    path,
    content:
      content.kind === 'text'
        ? { kind: 'text', text: content.text }
        : binary
          ? { kind: 'binary', bytes: content.bytes }
          : { kind: 'text', text: content.bytes.toString('utf-8') },
    docType,
    mimeType,
    writeMode: 'upsert',
    indexing: params.indexing ?? 'auto', // binary content is forced to 'disabled' by the core regardless
    tags: params.tags,
    ...(params.refuseDifferentContent ? { refuseDifferentContent: true } : {}),
    ...(params.governedWriter ? { governedWriter: params.governedWriter } : {}),
  });
  return {
    savedTo: result.doc.path,
    sizeBytes: result.sizeBytes,
    docId: result.doc.id,
    version: result.doc.currentVersion,
    contentHash: result.contentHash,
    mimeType,
    docType,
    created: result.created,
    revived: result.revived,
  };
}
