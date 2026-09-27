/**
 * Memory v2 Document Repository.
 *
 * Data access for the repo-like memory document store.
 * Supports path-based CRUD, versioning, and hybrid query modes.
 */
import { eq, and, sql, inArray, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { APPLET_MEMORY_PREFIX } from '@aflow/schemas';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import {
  memoryDocs,
  memoryDocVersions,
  memoryChunks,
  memoryEmbedConfig,
} from '../schema/tenant.js';
import type { MemoryDocRow, NewMemoryDocRow, MemoryDerivation } from '../schema/tenant.js';
import { createMemoryLinkRepository, type MemoryLinkRepository } from './memoryLinks.js';

// ============================================================================
// Types
// ============================================================================

export interface MemoryDoc {
  id: string;
  path: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string | null;
  inlineContent: string | null;
  payloadRef: string | null;
  preview: string | null;
  tags: string[];
  summary: string | null;
  semanticType: string | null;
  properties: Record<string, unknown>;
  derivation: MemoryDerivation | null;
  spaceId: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
  createdByActor: string | null;
  createdBySessionId: string | null;
  createdByStepId: string | null;
  createdByStepExecutionId: string | null;
  currentVersion: number;
  embeddingStatus: 'disabled' | 'pending' | 'indexed' | 'failed';
  indexingMode: 'auto' | 'disabled' | 'force';
  expiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryDocVersion {
  id: string;
  docId: string;
  version: number;
  inlineContent: string | null;
  payloadRef: string | null;
  contentHash: string;
  sizeBytes: number;
  createdByActor: string | null;
  createdBySessionId: string | null;
  createdByStepExecutionId: string | null;
  createdAt: Date;
}

export interface MemoryScope {
  spaceId: string;
  userId?: string | undefined;
  agentId?: string | undefined;
  sessionId?: string | undefined;
}

export interface MemoryDocQueryOptions {
  pathPrefix?: string | undefined;
  scope: MemoryScope;
  filters?:
    | {
        docType?: string[] | undefined;
        tagsAny?: string[] | undefined;
        tagsAll?: string[] | undefined;
        updatedAfter?: string | undefined;
        updatedBefore?: string | undefined;
        maxSizeBytes?: number | undefined;
        properties?:
          Record<string, string | number | boolean | Array<string | number | boolean>> | undefined;
      }
    | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  includeDeleted?: boolean | 'only' | undefined;
}

export interface MemoryDocQueryResult {
  id: string;
  path: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: Date;
  preview: string | null;
  tags: string[];
  semanticType: string | null;
  spaceId: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
  deletedAt: Date | null;
}

export interface MemoryDocGrepResult {
  id: string;
  path: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: Date;
  tags: string[];
  snippet: string;
  score: number;
  spaceId: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
}

export interface MemoryDocPutParams {
  path: string;
  docType: string;
  mimeType: string;
  inlineContent: string | null;
  payloadRef: string | null;
  sizeBytes: number;
  contentHash: string;
  preview: string | null;
  tags: string[];
  summary: string | null;
  semanticType?: string | null;
  scope: MemoryScope;
  provenance?:
    | {
        actor?: string | undefined;
        sessionId?: string | undefined;
        stepId?: string | undefined;
        stepExecutionId?: string | undefined;
      }
    | undefined;
  writeMode?: 'upsert' | 'create' | 'overwrite' | undefined;
  indexing: 'auto' | 'disabled' | 'force';
  expectedHash?: string | undefined;
}

export interface MemoryDocPutResult extends MemoryDoc {
  /**
   * Whether this put made the path live — a first insert or the revival of a
   * soft-deleted row. A writer that undoes its own work keys on this and not on
   * the version: a revived document is created at a version above the first.
   * `revived` separates the two, because undoing a revival re-hides a document
   * somebody else wrote rather than erasing one nobody had.
   */
  created: boolean;
  revived: boolean;
}

// ============================================================================
// Embedding Model Resolution
// ============================================================================

/** Supported embedding dimensions → column name mapping (whitelist) */
export const EMBEDDING_COLUMNS: Record<number, string> = {
  1536: 'embedding_1536',
  3072: 'embedding_3072',
};

const ALLOWED_EMBED_COLUMNS = new Set(Object.values(EMBEDDING_COLUMNS));

/**
 * Validates that a column name is in the EMBEDDING_COLUMNS whitelist.
 * Prevents dynamic SQL injection through column name parameters.
 */
function assertAllowedEmbedColumn(col: string): void {
  if (!ALLOWED_EMBED_COLUMNS.has(col)) {
    throw new Error(
      `Invalid embedding column '${col}'. Allowed: ${[...ALLOWED_EMBED_COLUMNS].join(', ')}`,
    );
  }
}

/** Coerce a nullable raw-SQL scalar (postgres-js may hand back an object) to `string | null`. */
function scalarOrNull(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value as string | number);
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Coerce a NOT NULL raw-SQL scalar to `string`. */
function requiredScalar(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value as string | number);
}

export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBED_DIMS = 1536;

import { canonicalizePath, targetsAppletReservedSubtree } from './memoryPaths.js';
import { TASK_DRAFT_PREFIX, isReservedScratchPath } from './reservedPaths.js';

export {
  canonicalizePath,
  isAppletReservedPath,
  targetsAppletReservedSubtree,
} from './memoryPaths.js';

export interface ResolvedEmbedModel {
  model: string;
  dims: number;
  column: string;
}

export interface MemoryEmbedConfigEntry {
  id: string;
  scopeType: string;
  scopeValue: string | null;
  embeddingModel: string;
  dims: number;
}

export interface MemoryChunkInsert {
  docId: string;
  docVersionId: string;
  chunkIndex: number;
  text: string;
  startOffset: number;
  endOffset: number;
  skipEmbedding?: boolean;
}

export interface MemorySearchHit {
  docId: string;
  path: string;
  docType: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: Date;
  tags: string[];
  score: number;
  snippet: string;
  chunkId: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  searchBackend: 'fts' | 'vector' | 'hybrid';
  spaceId: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
}

export interface MemoryDocRepository {
  getById(
    id: string,
    spaceId: string,
    opts?: { includeDeleted?: boolean; forUpdate?: boolean },
  ): Promise<MemoryDoc | null>;
  getByPath(
    path: string,
    spaceId: string,
    opts?: {
      includeDeleted?: boolean;
      forUpdate?: boolean;
      /** Read a reserved path — only the store that owns the prefix. */
      allowReserved?: boolean;
    },
  ): Promise<MemoryDoc | null>;
  list(options: MemoryDocQueryOptions): Promise<MemoryDocQueryResult[]>;
  /**
   * Fetch live docs whose path is one of `paths`, applying the same scope and
   * `filters` predicate as `list`. Used to materialize link-expansion neighbors
   * with filter-parity to the seeds. Result order is not significant — the
   * caller re-orders by its own neighbor ranking.
   */
  listByPaths(paths: string[], options: MemoryDocQueryOptions): Promise<MemoryDocQueryResult[]>;
  grep(options: MemoryDocQueryOptions & { query: string }): Promise<MemoryDocGrepResult[]>;
  put(params: MemoryDocPutParams): Promise<MemoryDocPutResult>;
  getVersion(docId: string, version: number): Promise<MemoryDocVersion | null>;
  getLatestVersion(docId: string): Promise<MemoryDocVersion | null>;
  softDelete(id: string, spaceId: string): Promise<boolean>;

  /** List soft-deleted documents in a space. */
  listDeleted(options: { spaceId: string; limit?: number; cursor?: string }): Promise<MemoryDoc[]>;

  /** Restore a soft-deleted document (clear deletedAt). */
  restore(id: string, spaceId: string): Promise<boolean>;

  /** Permanently delete a document and its chunks/versions. */
  hardDelete(id: string, spaceId: string): Promise<boolean>;

  insertChunks(chunks: MemoryChunkInsert[]): Promise<void>;
  deleteChunksForDoc(docId: string): Promise<void>;
  searchFts(options: MemoryDocQueryOptions & { query: string }): Promise<MemorySearchHit[]>;
  searchVector(
    options: MemoryDocQueryOptions & { queryEmbedding: number[]; embedColumn?: string },
  ): Promise<MemorySearchHit[]>;
  /**
   * Hybrid search: run vector + FTS in parallel, fuse results with RRF.
   * Falls back to whichever backend(s) are available.
   */
  searchHybrid(
    options: MemoryDocQueryOptions & {
      query: string;
      queryEmbedding?: number[];
      embedColumn?: string;
    },
  ): Promise<MemorySearchHit[]>;
  getChunksForVersion(
    docVersionId: string,
  ): Promise<Array<{ id: string; chunkIndex: number; text: string; skipEmbedding: boolean }>>;
  updateChunkEmbedding(
    chunkId: string,
    embedding: number[],
    model: string,
    dims: number,
    column?: string,
  ): Promise<void>;
  updateDocEmbeddingStatus(
    docId: string,
    status: 'disabled' | 'pending' | 'indexed' | 'failed',
  ): Promise<void>;

  /**
   * Overwrite a doc's derived index columns (parsed frontmatter properties +
   * link/property scan derivation). Written inside the same transaction as the
   * doc put so content and its derived indexes commit or roll back together.
   */
  updateDerivedFields(
    docId: string,
    spaceId: string,
    fields: { properties: Record<string, unknown>; derivation: MemoryDerivation },
  ): Promise<void>;

  resolveEmbeddingModel(scope?: {
    spaceId?: string | undefined;
    agentId?: string | undefined;
    pathPrefix?: string | undefined;
  }): Promise<ResolvedEmbedModel>;
  getEmbedConfig(
    scopeType: string,
    scopeValue: string | null,
  ): Promise<MemoryEmbedConfigEntry | null>;
  setEmbedConfig(entry: {
    scopeType: string;
    scopeValue: string | null;
    embeddingModel: string;
    dims: number;
  }): Promise<MemoryEmbedConfigEntry>;

  /**
   * Mark docs matching a scope as needing re-embedding.
   * Sets embeddingStatus='pending' for all non-disabled docs in scope.
   * Returns the IDs of affected docs (caller can enqueue backfill jobs).
   */
  markDocsStaleForScope(scope: { scopeType: string; scopeValue: string | null }): Promise<string[]>;

  /**
   * Return docs with embeddingStatus='pending' that need (re-)embedding.
   * Used by the embedder's periodic backfill scan to pick up stale docs
   * after a config change or missed embed jobs.
   */
  getStaleDocsForReembed(limit: number): Promise<
    Array<{
      id: string;
      path: string;
      contentHash: string;
      currentVersion: number;
      latestVersionId: string;
      spaceId: string;
      agentId: string | null;
    }>
  >;

  /**
   * Execute a callback with a repo bound to a single Postgres transaction.
   * All repo calls inside the callback share one connection and one
   * BEGIN/COMMIT cycle, reducing pool churn and improving atomicity
   * for multi-step writes (put + chunk + embed config).
   *
   * The second callback argument is a `MemoryLinkRepository` bound to the SAME
   * transaction — the link rebuild for a doc write must commit or roll back
   * atomically with the doc put, so derivation callers use this handle rather
   * than a separately-connected link repo.
   */
  withTransaction<T>(
    fn: (txRepo: MemoryDocRepository, txLinkRepo: MemoryLinkRepository) => Promise<T>,
  ): Promise<T>;
}

// ============================================================================
// Row Mapper
// ============================================================================

function toDoc(row: MemoryDocRow): MemoryDoc {
  return {
    id: row.id,
    path: row.path,
    docType: row.docType,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    inlineContent: row.inlineContent,
    payloadRef: row.payloadRef,
    preview: row.preview,
    tags: row.tags,
    summary: row.summary,
    semanticType: row.semanticType,
    properties: row.properties,
    derivation: row.derivation ?? null,
    spaceId: row.spaceId,
    userId: row.userId,
    agentId: row.agentId,
    sessionId: row.sessionId,
    createdByActor: row.createdByActor,
    createdBySessionId: row.createdBySessionId,
    createdByStepId: row.createdByStepId,
    createdByStepExecutionId: row.createdByStepExecutionId,
    currentVersion: row.currentVersion,
    embeddingStatus: row.embeddingStatus,
    indexingMode: row.indexingMode,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ============================================================================
// Build scope + filter conditions
// ============================================================================

function buildScopeConditions(options: MemoryDocQueryOptions): SQL[] {
  const deletionCondition: SQL =
    options.includeDeleted === 'only'
      ? sql`${memoryDocs.deletedAt} IS NOT NULL`
      : options.includeDeleted === true
        ? sql`TRUE` // include both active and soft-deleted
        : sql`${memoryDocs.deletedAt} IS NULL`;
  const conditions: SQL[] = [
    deletionCondition,
    sql`(${memoryDocs.expiresAt} IS NULL OR ${memoryDocs.expiresAt} > NOW())`,
  ];

  if (options.pathPrefix) {
    const prefix = canonicalizePath(options.pathPrefix);
    conditions.push(sql`${memoryDocs.path} LIKE ${prefix + '%'}`);
  }

  // Applet state is platform-managed, not knowledge: hidden from every
  // list/grep/search shape unless the caller aims a pathPrefix directly at
  // the reserved subtree. Exact-path gets are unaffected.
  if (!options.pathPrefix || !targetsAppletReservedSubtree(options.pathPrefix)) {
    conditions.push(sql`${memoryDocs.path} NOT LIKE ${APPLET_MEMORY_PREFIX + '%'}`);
  }

  // In the predicate, not the caller: filtering after the query lets drafts
  // consume the page and then vanish from it.
  conditions.push(sql`${memoryDocs.path} NOT LIKE ${TASK_DRAFT_PREFIX + '%'}`);

  const scope = options.scope;
  conditions.push(eq(memoryDocs.spaceId, scope.spaceId));
  if (scope.userId) {
    conditions.push(eq(memoryDocs.userId, scope.userId));
  }
  if (scope.agentId) {
    conditions.push(eq(memoryDocs.agentId, scope.agentId));
  }
  if (scope.sessionId) {
    conditions.push(eq(memoryDocs.sessionId, scope.sessionId));
  }

  const filters = options.filters;
  if (filters?.docType && filters.docType.length > 0) {
    conditions.push(inArray(memoryDocs.docType, filters.docType));
  }
  if (filters?.tagsAny && filters.tagsAny.length > 0) {
    const jsonArr = JSON.stringify(filters.tagsAny);
    conditions.push(sql`${memoryDocs.tags} ?| ${sql`${jsonArr}::text[]`}`);
  }
  if (filters?.tagsAll && filters.tagsAll.length > 0) {
    const jsonArr = JSON.stringify(filters.tagsAll);
    conditions.push(sql`${memoryDocs.tags} ?& ${sql`${jsonArr}::text[]`}`);
  }
  if (filters?.updatedAfter) {
    conditions.push(sql`${memoryDocs.updatedAt} > ${filters.updatedAfter}::timestamptz`);
  }
  if (filters?.updatedBefore) {
    conditions.push(sql`${memoryDocs.updatedAt} < ${filters.updatedBefore}::timestamptz`);
  }
  if (filters?.maxSizeBytes) {
    conditions.push(sql`${memoryDocs.sizeBytes} <= ${filters.maxSizeBytes}`);
  }
  if (filters?.properties) {
    for (const [key, value] of Object.entries(filters.properties)) {
      conditions.push(buildPropertyCondition(key, value));
    }
  }

  return conditions;
}

/**
 * jsonb containment predicate for one property filter key, served by the
 * `properties jsonb_path_ops` GIN index (`@>` only). A scalar candidate `v`
 * matches when the stored value equals `v` OR is an array that contains `v` —
 * so each candidate expands to `(properties @> {k:v} OR properties @> {k:[v]})`.
 * An array of candidates is the OR of its members' predicates (any-of).
 */
function buildPropertyCondition(
  key: string,
  value: string | number | boolean | Array<string | number | boolean>,
): SQL {
  const candidates = Array.isArray(value) ? value : [value];
  const perCandidate = candidates.map((candidate) => {
    const scalarDoc = JSON.stringify({ [key]: candidate });
    const arrayDoc = JSON.stringify({ [key]: [candidate] });
    return sql`(${memoryDocs.properties} @> ${scalarDoc}::jsonb OR ${memoryDocs.properties} @> ${arrayDoc}::jsonb)`;
  });
  return sql`(${sql.join(perCandidate, sql` OR `)})`;
}

/** Shared column projection for list-shaped reads (list, listByPaths). */
const LIST_QUERY_COLUMNS = {
  id: memoryDocs.id,
  path: memoryDocs.path,
  docType: memoryDocs.docType,
  mimeType: memoryDocs.mimeType,
  sizeBytes: memoryDocs.sizeBytes,
  updatedAt: memoryDocs.updatedAt,
  preview: memoryDocs.preview,
  tags: memoryDocs.tags,
  semanticType: memoryDocs.semanticType,
  spaceId: memoryDocs.spaceId,
  userId: memoryDocs.userId,
  agentId: memoryDocs.agentId,
  sessionId: memoryDocs.sessionId,
  deletedAt: memoryDocs.deletedAt,
} as const;

function toQueryResult(row: {
  [K in keyof typeof LIST_QUERY_COLUMNS]: MemoryDocQueryResult[K];
}): MemoryDocQueryResult {
  return { ...row };
}

// ============================================================================
// Repository Implementation
// ============================================================================

type QueryRunner = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>) => Promise<T>;

/**
 * @param options.inTransaction - When true, `db` is already a Drizzle tx
 *   with search_path set. Methods use it directly, skipping withTenantSchema.
 */
export function createMemoryDocRepository(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  options?: { inTransaction?: boolean },
): MemoryDocRepository {
  const run: QueryRunner = options?.inTransaction
    ? async (fn) => fn(db)
    : async (fn) => withTenantSchema(db, tenantContext, fn);

  return {
    async getById(id, spaceId, opts) {
      return run(async (tx) => {
        let query = tx
          .select()
          .from(memoryDocs)
          .where(
            opts?.includeDeleted
              ? and(eq(memoryDocs.id, id), eq(memoryDocs.spaceId, spaceId))
              : and(
                  eq(memoryDocs.id, id),
                  eq(memoryDocs.spaceId, spaceId),
                  sql`${memoryDocs.deletedAt} IS NULL`,
                ),
          )
          .limit(1);
        if (opts?.forUpdate) {
          query = query.for('update') as typeof query;
        }
        const [row] = await query;

        if (row && isReservedScratchPath(row.path)) return null;

        return row ? toDoc(row) : null;
      });
    },

    async getByPath(path, spaceId, opts) {
      if (!opts?.allowReserved && isReservedScratchPath(path)) return null;
      return run(async (tx) => {
        const conditions = [
          eq(memoryDocs.path, canonicalizePath(path)),
          eq(memoryDocs.spaceId, spaceId),
        ];
        if (!opts?.includeDeleted) {
          conditions.push(sql`${memoryDocs.deletedAt} IS NULL`);
        }
        let query = tx
          .select()
          .from(memoryDocs)
          .where(and(...conditions))
          .limit(1);
        if (opts?.forUpdate) {
          query = query.for('update') as typeof query;
        }
        const [row] = await query;
        return row ? toDoc(row) : null;
      });
    },

    async list(options) {
      const limit = options.limit ?? 50;

      return run(async (tx) => {
        const conditions = buildScopeConditions(options);

        if (options.cursor) {
          conditions.push(sql`${memoryDocs.path} > ${options.cursor}`);
        }

        const rows = await tx
          .select(LIST_QUERY_COLUMNS)
          .from(memoryDocs)
          .where(and(...conditions))
          .orderBy(memoryDocs.path)
          .limit(limit);

        return rows.map(toQueryResult);
      });
    },

    async listByPaths(paths, options) {
      if (paths.length === 0) return [];
      const canonical = paths.map(canonicalizePath);

      return run(async (tx) => {
        const conditions = buildScopeConditions({ ...options, pathPrefix: undefined });
        conditions.push(inArray(memoryDocs.path, canonical));

        const rows = await tx
          .select(LIST_QUERY_COLUMNS)
          .from(memoryDocs)
          .where(and(...conditions))
          .limit(canonical.length);

        return rows.map(toQueryResult);
      });
    },

    async grep(options) {
      const limit = options.limit ?? 50;
      const query = options.query;

      return run(async (tx) => {
        const conditions = buildScopeConditions(options);
        const searchPattern = `%${query}%`;

        conditions.push(
          sql`(${memoryDocs.inlineContent} ILIKE ${searchPattern} OR ${memoryDocs.summary} ILIKE ${searchPattern})`,
        );

        const rows = await tx
          .select({
            id: memoryDocs.id,
            path: memoryDocs.path,
            docType: memoryDocs.docType,
            mimeType: memoryDocs.mimeType,
            sizeBytes: memoryDocs.sizeBytes,
            updatedAt: memoryDocs.updatedAt,
            tags: memoryDocs.tags,
            inlineContent: memoryDocs.inlineContent,
            spaceId: memoryDocs.spaceId,
            userId: memoryDocs.userId,
            agentId: memoryDocs.agentId,
            sessionId: memoryDocs.sessionId,
          })
          .from(memoryDocs)
          .where(and(...conditions))
          .orderBy(memoryDocs.updatedAt)
          .limit(limit * 2);

        return rows.slice(0, limit).map((row) => {
          const text = row.inlineContent ?? '';
          const lowerQuery = query.toLowerCase();
          const lowerText = text.toLowerCase();
          const matchIdx = lowerText.indexOf(lowerQuery);

          let snippet: string;
          if (matchIdx >= 0) {
            const start = Math.max(0, matchIdx - 60);
            const end = Math.min(text.length, matchIdx + query.length + 60);
            snippet =
              (start > 0 ? '...' : '') +
              text.substring(start, end) +
              (end < text.length ? '...' : '');
          } else {
            snippet = text.substring(0, 200);
          }

          return {
            id: row.id,
            path: row.path,
            docType: row.docType,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            updatedAt: row.updatedAt,
            tags: row.tags,
            snippet: snippet.substring(0, 500),
            score: matchIdx >= 0 ? 1.0 : 0.5,
            spaceId: row.spaceId,
            userId: row.userId,
            agentId: row.agentId,
            sessionId: row.sessionId,
          };
        });
      });
    },

    async put(params) {
      return run(async (tx) => {
        const now = new Date();
        const normalizedPath = canonicalizePath(params.path);

        // Look up any existing doc at this path within the same space —
        // including soft-deleted rows. The UNIQUE index on (path, space_id)
        // WHERE deleted_at IS NULL covers active rows; we also check for
        // soft-deleted rows to revive them instead of creating duplicates.
        const spaceId = params.scope.spaceId;
        const existing = await tx
          .select({
            id: memoryDocs.id,
            currentVersion: memoryDocs.currentVersion,
            contentHash: memoryDocs.contentHash,
            deletedAt: memoryDocs.deletedAt,
          })
          .from(memoryDocs)
          .where(and(eq(memoryDocs.path, normalizedPath), eq(memoryDocs.spaceId, spaceId)))
          .limit(1);

        const existingRow = existing[0];
        const isSoftDeleted = existingRow?.deletedAt != null;
        // For writeMode checks, treat soft-deleted as non-existing
        const existingDoc = existingRow && !isSoftDeleted ? existingRow : undefined;

        const writeMode = params.writeMode ?? 'upsert';
        if (writeMode === 'create' && existingDoc) {
          throw new Error(
            `MEMORY_ALREADY_EXISTS: document at path '${normalizedPath}' already exists`,
          );
        }
        if (writeMode === 'overwrite' && !existingDoc) {
          throw new Error(`MEMORY_NOT_FOUND: no document at path '${normalizedPath}'`);
        }

        // Asserted against the row itself, deleted or not: a soft-deleted row
        // still holds bytes this path can be revived to, so exempting it lets a
        // guarded write replace content it declared it was not replacing.
        // This read is the early refusal, NOT the guarantee: under READ
        // COMMITTED two writers can both pass it. The UPDATE below carries the
        // same hash, where the row lock decides.
        if (params.expectedHash && existingRow && existingRow.contentHash !== params.expectedHash) {
          throw new Error(
            `MEMORY_HASH_MISMATCH: expected ${params.expectedHash}, got ${existingRow.contentHash ?? 'null'}`,
          );
        }

        // Reserved applet-state snapshots are never embedded — a caller's
        // 'force' must not win, including when reviving a soft-deleted doc.
        const indexing = normalizedPath.startsWith(APPLET_MEMORY_PREFIX)
          ? 'disabled'
          : params.indexing;
        const embeddingStatus = indexing === 'disabled' ? 'disabled' : 'pending';
        // For soft-deleted docs, continue from the existing version number
        // (old version snapshots still exist in memory_doc_versions)
        const newVersion = (existingDoc?.currentVersion ?? existingRow?.currentVersion ?? 0) + 1;

        let doc: MemoryDocRow;

        if (existingDoc || isSoftDeleted) {
          // Active doc: normal update. Soft-deleted doc: revive by clearing
          // deletedAt and overwriting content (avoids UNIQUE constraint violation).
          const updateId = existingDoc?.id ?? existingRow!.id;
          const updatedRows = await tx
            .update(memoryDocs)
            .set({
              docType: params.docType,
              mimeType: params.mimeType,
              sizeBytes: params.sizeBytes,
              contentHash: params.contentHash,
              inlineContent: params.inlineContent,
              payloadRef: params.payloadRef,
              preview: params.preview,
              tags: params.tags,
              summary: params.summary,
              semanticType: params.semanticType ?? null,
              currentVersion: newVersion,
              embeddingStatus,
              indexingMode: indexing,
              updatedAt: now,
              ...(isSoftDeleted
                ? {
                    deletedAt: null,
                    createdAt: now,
                    // Re-set scope and provenance on revive (may differ from original)
                    spaceId: params.scope.spaceId,
                    userId: params.scope.userId ?? null,
                    agentId: params.scope.agentId ?? null,
                    sessionId: params.scope.sessionId ?? null,
                    createdByActor: params.provenance?.actor ?? null,
                    createdBySessionId: params.provenance?.sessionId ?? null,
                    createdByStepId: params.provenance?.stepId ?? null,
                    createdByStepExecutionId: params.provenance?.stepExecutionId ?? null,
                  }
                : {}),
            })
            .where(
              params.expectedHash
                ? and(eq(memoryDocs.id, updateId), eq(memoryDocs.contentHash, params.expectedHash))
                : eq(memoryDocs.id, updateId),
            )
            .returning();

          // Zero rows: another writer committed in between, so the hash no
          // longer matches. Fails rather than overwriting what arrived.
          if (params.expectedHash && updatedRows.length === 0) {
            const current = await tx
              .select({ contentHash: memoryDocs.contentHash })
              .from(memoryDocs)
              .where(eq(memoryDocs.id, updateId))
              .limit(1);
            throw new Error(
              `MEMORY_HASH_MISMATCH: expected ${params.expectedHash}, got ${
                current[0]?.contentHash ?? 'null'
              }`,
            );
          }

          doc = updatedRows[0]!;
        } else {
          // Nothing satisfies "the content here is X" when there is no row:
          // reaching the insert means it went away after the caller read it, so
          // creating it would resurrect a draft terminal cleanup had removed.
          if (params.expectedHash) {
            throw new Error(
              `MEMORY_HASH_MISMATCH: expected ${params.expectedHash}, got null ` +
                `(no document at '${normalizedPath}' — it was removed after you read it)`,
            );
          }
          const insertData: NewMemoryDocRow = {
            path: normalizedPath,
            docType: params.docType,
            mimeType: params.mimeType,
            sizeBytes: params.sizeBytes,
            contentHash: params.contentHash,
            inlineContent: params.inlineContent,
            payloadRef: params.payloadRef,
            preview: params.preview,
            tags: params.tags,
            summary: params.summary,
            semanticType: params.semanticType ?? null,
            spaceId: params.scope.spaceId,
            currentVersion: 1,
            embeddingStatus,
            indexingMode: indexing,
            createdAt: now,
            updatedAt: now,
          };

          if (params.scope.userId) insertData.userId = params.scope.userId;
          if (params.scope.agentId) insertData.agentId = params.scope.agentId;
          if (params.scope.sessionId) insertData.sessionId = params.scope.sessionId;

          if (params.provenance?.actor) insertData.createdByActor = params.provenance.actor;
          if (params.provenance?.sessionId)
            insertData.createdBySessionId = params.provenance.sessionId;
          if (params.provenance?.stepId) insertData.createdByStepId = params.provenance.stepId;
          if (params.provenance?.stepExecutionId)
            insertData.createdByStepExecutionId = params.provenance.stepExecutionId;

          const [inserted] = await tx.insert(memoryDocs).values(insertData).returning();

          doc = inserted!;
        }

        // Create immutable version snapshot
        await tx.insert(memoryDocVersions).values({
          docId: doc.id,
          version: newVersion,
          inlineContent: params.inlineContent,
          payloadRef: params.payloadRef,
          contentHash: params.contentHash,
          sizeBytes: params.sizeBytes,
          createdByActor: params.provenance?.actor ?? null,
          createdBySessionId: params.provenance?.sessionId ?? null,
          createdByStepExecutionId: params.provenance?.stepExecutionId ?? null,
        });

        return { ...toDoc(doc), created: existingDoc === undefined, revived: isSoftDeleted };
      });
    },

    async getVersion(docId, version) {
      return run(async (tx) => {
        const [row] = await tx
          .select()
          .from(memoryDocVersions)
          .where(and(eq(memoryDocVersions.docId, docId), eq(memoryDocVersions.version, version)))
          .limit(1);

        if (!row) return null;

        return {
          id: row.id,
          docId: row.docId,
          version: row.version,
          inlineContent: row.inlineContent,
          payloadRef: row.payloadRef,
          contentHash: row.contentHash,
          sizeBytes: row.sizeBytes,
          createdByActor: row.createdByActor,
          createdBySessionId: row.createdBySessionId,
          createdByStepExecutionId: row.createdByStepExecutionId,
          createdAt: row.createdAt,
        };
      });
    },

    async getLatestVersion(docId) {
      return run(async (tx) => {
        const [row] = await tx
          .select()
          .from(memoryDocVersions)
          .where(eq(memoryDocVersions.docId, docId))
          .orderBy(sql`${memoryDocVersions.version} DESC`)
          .limit(1);

        if (!row) return null;

        return {
          id: row.id,
          docId: row.docId,
          version: row.version,
          inlineContent: row.inlineContent,
          payloadRef: row.payloadRef,
          contentHash: row.contentHash,
          sizeBytes: row.sizeBytes,
          createdByActor: row.createdByActor,
          createdBySessionId: row.createdBySessionId,
          createdByStepExecutionId: row.createdByStepExecutionId,
          createdAt: row.createdAt,
        };
      });
    },

    async softDelete(id, spaceId) {
      return run(async (tx) => {
        // Trashing reserved scratch would strand it: neither gone nor reachable.
        const [existing] = await tx
          .select({ path: memoryDocs.path })
          .from(memoryDocs)
          .where(and(eq(memoryDocs.id, id), eq(memoryDocs.spaceId, spaceId)))
          .limit(1);
        if (existing && isReservedScratchPath(existing.path)) return false;
        const result = await tx
          .update(memoryDocs)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(memoryDocs.id, id),
              eq(memoryDocs.spaceId, spaceId),
              sql`${memoryDocs.deletedAt} IS NULL`,
            ),
          )
          .returning({ id: memoryDocs.id });

        return result.length > 0;
      });
    },

    async listDeleted(options) {
      return run(async (tx) => {
        const conditions: SQL[] = [
          sql`${memoryDocs.deletedAt} IS NOT NULL`,
          eq(memoryDocs.spaceId, options.spaceId),
          // Trash is a browse surface too — reserved applet state never appears.
          sql`${memoryDocs.path} NOT LIKE ${APPLET_MEMORY_PREFIX + '%'}`,
        ];
        if (options.cursor) conditions.push(sql`${memoryDocs.path} > ${options.cursor}`);

        const rows = await tx
          .select()
          .from(memoryDocs)
          .where(and(...conditions))
          .orderBy(memoryDocs.path)
          .limit(options.limit ?? 100);

        return rows.map(toDoc);
      });
    },

    async restore(id, spaceId) {
      return run(async (tx) => {
        const result = await tx
          .update(memoryDocs)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(memoryDocs.id, id),
              eq(memoryDocs.spaceId, spaceId),
              sql`${memoryDocs.deletedAt} IS NOT NULL`,
            ),
          )
          .returning({ id: memoryDocs.id });

        return result.length > 0;
      });
    },

    async hardDelete(id, spaceId) {
      return run(async (tx) => {
        // Confirm the doc belongs to this space before touching its chunks or
        // versions — otherwise a foreign id would cascade-delete another
        // space's chunk/version rows even though the doc row itself survives.
        const [owned] = await tx
          .select({ id: memoryDocs.id })
          .from(memoryDocs)
          .where(and(eq(memoryDocs.id, id), eq(memoryDocs.spaceId, spaceId)))
          .limit(1);
        if (!owned) return false;

        // Delete chunks first (FK)
        await tx.delete(memoryChunks).where(eq(memoryChunks.docId, id));
        // Delete versions
        await tx.delete(memoryDocVersions).where(eq(memoryDocVersions.docId, id));
        // Delete the document
        const result = await tx
          .delete(memoryDocs)
          .where(and(eq(memoryDocs.id, id), eq(memoryDocs.spaceId, spaceId)))
          .returning({ id: memoryDocs.id });

        return result.length > 0;
      });
    },

    async insertChunks(chunks) {
      if (chunks.length === 0) return;
      return run(async (tx) => {
        const values = chunks.map((c) => ({
          docId: c.docId,
          docVersionId: c.docVersionId,
          chunkIndex: c.chunkIndex,
          text: c.text,
          startOffset: c.startOffset,
          endOffset: c.endOffset,
          ...(c.skipEmbedding === true ? { skipEmbedding: true } : {}),
        }));
        await tx.insert(memoryChunks).values(values);
      });
    },

    async deleteChunksForDoc(docId) {
      return run(async (tx) => {
        await tx.delete(memoryChunks).where(eq(memoryChunks.docId, docId));
      });
    },

    async searchFts(options) {
      const limit = options.limit ?? 20;
      const query = options.query;

      return run(async (tx) => {
        const conditions = buildScopeConditions(options);

        // buildScopeConditions renders table-qualified column refs, so the
        // docs table must not be aliased here.
        const rows = await tx.execute(sql`
          SELECT
            ${memoryDocs.id}   AS doc_id,
            ${memoryDocs.path},
            ${memoryDocs.docType},
            ${memoryDocs.mimeType},
            ${memoryDocs.sizeBytes},
            ${memoryDocs.updatedAt},
            ${memoryDocs.tags},
            ${memoryDocs.spaceId},
            ${memoryDocs.userId},
            ${memoryDocs.agentId},
            ${memoryDocs.sessionId},
            c.id   AS chunk_id,
            c.chunk_index,
            c.start_offset,
            c.end_offset,
            ts_rank_cd(c.chunk_tsv, websearch_to_tsquery('english', ${query})) AS rank,
            ts_headline('english', c.text, websearch_to_tsquery('english', ${query}),
              'MaxWords=40, MinWords=10, StartSel=**, StopSel=**') AS snippet
          FROM ${memoryDocs}
          JOIN ${memoryChunks} c ON c.doc_id = ${memoryDocs.id}
          WHERE c.chunk_tsv @@ websearch_to_tsquery('english', ${query})
            AND ${and(...conditions)}
          ORDER BY rank DESC
          LIMIT ${limit}
        `);

        return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
          docId: String(r['doc_id']),
          path: String(r['path']),
          docType: String(r['doc_type']),
          mimeType: String(r['mime_type']),
          sizeBytes: Number(r['size_bytes']),
          updatedAt: new Date(String(r['updated_at'])),
          tags: stringArrayOrEmpty(r['tags']),
          score: Number(r['rank']),
          snippet: String(r['snippet']),
          chunkId: String(r['chunk_id']),
          chunkIndex: Number(r['chunk_index']),
          startOffset: Number(r['start_offset']),
          endOffset: Number(r['end_offset']),
          searchBackend: 'fts' as const,
          spaceId: requiredScalar(r['space_id']),
          userId: scalarOrNull(r['user_id']),
          agentId: scalarOrNull(r['agent_id']),
          sessionId: scalarOrNull(r['session_id']),
        }));
      });
    },

    async searchVector(options) {
      const limit = options.limit ?? 20;
      const embedding = options.queryEmbedding;
      const vectorStr = `[${embedding.join(',')}]`;
      const col = options.embedColumn ?? EMBEDDING_COLUMNS[DEFAULT_EMBED_DIMS] ?? 'embedding_1536';
      assertAllowedEmbedColumn(col);

      return run(async (tx) => {
        const conditions = buildScopeConditions(options);

        // buildScopeConditions renders table-qualified column refs, so the
        // docs table must not be aliased here.
        const rows = await tx.execute(sql`
          SELECT
            ${memoryDocs.id}   AS doc_id,
            ${memoryDocs.path},
            ${memoryDocs.docType},
            ${memoryDocs.mimeType},
            ${memoryDocs.sizeBytes},
            ${memoryDocs.updatedAt},
            ${memoryDocs.tags},
            ${memoryDocs.spaceId},
            ${memoryDocs.userId},
            ${memoryDocs.agentId},
            ${memoryDocs.sessionId},
            c.id   AS chunk_id,
            c.chunk_index,
            c.start_offset,
            c.end_offset,
            1 - (c.${sql.raw(col)} <=> ${vectorStr}::vector) AS score,
            substring(c.text from 1 for 300) AS snippet
          FROM ${memoryDocs}
          JOIN ${memoryChunks} c ON c.doc_id = ${memoryDocs.id}
          WHERE c.${sql.raw(col)} IS NOT NULL
            AND ${and(...conditions)}
          ORDER BY c.${sql.raw(col)} <=> ${vectorStr}::vector
          LIMIT ${limit}
        `);

        return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
          docId: String(r['doc_id']),
          path: String(r['path']),
          docType: String(r['doc_type']),
          mimeType: String(r['mime_type']),
          sizeBytes: Number(r['size_bytes']),
          updatedAt: new Date(String(r['updated_at'])),
          tags: stringArrayOrEmpty(r['tags']),
          score: Number(r['score']),
          snippet: String(r['snippet']),
          chunkId: String(r['chunk_id']),
          chunkIndex: Number(r['chunk_index']),
          startOffset: Number(r['start_offset']),
          endOffset: Number(r['end_offset']),
          searchBackend: 'vector' as const,
          spaceId: requiredScalar(r['space_id']),
          userId: scalarOrNull(r['user_id']),
          agentId: scalarOrNull(r['agent_id']),
          sessionId: scalarOrNull(r['session_id']),
        }));
      });
    },

    async searchHybrid(options) {
      const limit = options.limit ?? 20;
      const K = 60; // RRF constant — standard value from the original RRF paper

      const [vectorHits, ftsHits] = await Promise.allSettled([
        options.queryEmbedding
          ? this.searchVector({
              ...options,
              queryEmbedding: options.queryEmbedding,
              ...(options.embedColumn != null ? { embedColumn: options.embedColumn } : {}),
              limit: limit * 2,
            })
          : Promise.resolve([]),
        this.searchFts({ ...options, query: options.query, limit: limit * 2 }),
      ]);

      const vectorResults = vectorHits.status === 'fulfilled' ? vectorHits.value : [];
      const ftsResults = ftsHits.status === 'fulfilled' ? ftsHits.value : [];

      if (vectorResults.length === 0 && ftsResults.length === 0) {
        return [];
      }
      if (vectorResults.length === 0) {
        return ftsResults.slice(0, limit);
      }
      if (ftsResults.length === 0) {
        return vectorResults.slice(0, limit);
      }

      // Build rank maps: chunkId → rank position (1-based)
      const vectorRank = new Map<string, number>();
      vectorResults.forEach((hit, i) => vectorRank.set(hit.chunkId, i + 1));

      const ftsRank = new Map<string, number>();
      ftsResults.forEach((hit, i) => ftsRank.set(hit.chunkId, i + 1));

      // Collect all unique chunks, keeping the best metadata from either source
      const merged = new Map<string, MemorySearchHit>();
      for (const hit of [...vectorResults, ...ftsResults]) {
        if (!merged.has(hit.chunkId)) {
          merged.set(hit.chunkId, hit);
        }
      }

      // Compute RRF score: sum of 1/(K + rank) for each list where the chunk appears
      const scored = Array.from(merged.entries()).map(([chunkId, hit]) => {
        let rrfScore = 0;
        const vr = vectorRank.get(chunkId);
        if (vr !== undefined) rrfScore += 1 / (K + vr);
        const fr = ftsRank.get(chunkId);
        if (fr !== undefined) rrfScore += 1 / (K + fr);
        return { ...hit, score: rrfScore, searchBackend: 'hybrid' as const };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    async getChunksForVersion(docVersionId) {
      return run(async (tx) => {
        const rows = await tx
          .select({
            id: memoryChunks.id,
            chunkIndex: memoryChunks.chunkIndex,
            text: memoryChunks.text,
            skipEmbedding: memoryChunks.skipEmbedding,
          })
          .from(memoryChunks)
          .where(eq(memoryChunks.docVersionId, docVersionId))
          .orderBy(memoryChunks.chunkIndex);

        return rows;
      });
    },

    async updateChunkEmbedding(chunkId, embedding, model, dims, column) {
      const vectorStr = `[${embedding.join(',')}]`;
      const col = column ?? EMBEDDING_COLUMNS[dims];
      if (!col) {
        throw new Error(
          `No embedding column for dimension ${dims}. Supported: ${Object.keys(EMBEDDING_COLUMNS).join(', ')}`,
        );
      }
      assertAllowedEmbedColumn(col);
      return run(async (tx) => {
        await tx.execute(sql`
          UPDATE ${memoryChunks}
          SET ${sql.raw(col)} = ${vectorStr}::vector,
              embedding_model = ${model},
              dims = ${dims}
          WHERE id = ${chunkId}::uuid
        `);
      });
    },

    async updateDocEmbeddingStatus(docId, status) {
      return run(async (tx) => {
        await tx
          .update(memoryDocs)
          .set({ embeddingStatus: status, updatedAt: new Date() })
          .where(eq(memoryDocs.id, docId));
      });
    },

    async updateDerivedFields(docId, spaceId, fields) {
      return run(async (tx) => {
        await tx
          .update(memoryDocs)
          .set({ properties: fields.properties, derivation: fields.derivation })
          .where(and(eq(memoryDocs.id, docId), eq(memoryDocs.spaceId, spaceId)));
      });
    },

    async resolveEmbeddingModel(scope) {
      return run(async (tx) => {
        // Priority: path_prefix → flow → space → global → hardcoded default
        const candidates: Array<{ scopeType: string; scopeValue: string | null }> = [];

        if (scope?.pathPrefix) {
          candidates.push({
            scopeType: 'path_prefix',
            scopeValue: canonicalizePath(scope.pathPrefix),
          });
        }
        if (scope?.agentId) {
          candidates.push({ scopeType: 'flow', scopeValue: scope.agentId });
        }
        if (scope?.spaceId) {
          candidates.push({ scopeType: 'space', scopeValue: scope.spaceId });
        }
        candidates.push({ scopeType: 'global', scopeValue: null });

        for (const { scopeType, scopeValue } of candidates) {
          const conditions: SQL[] = [eq(memoryEmbedConfig.scopeType, scopeType)];
          if (scopeValue != null) {
            conditions.push(eq(memoryEmbedConfig.scopeValue, scopeValue));
          } else {
            conditions.push(sql`${memoryEmbedConfig.scopeValue} IS NULL`);
          }

          const [row] = await tx
            .select()
            .from(memoryEmbedConfig)
            .where(and(...conditions))
            .limit(1);

          if (row) {
            const col = EMBEDDING_COLUMNS[row.dims];
            if (!col) {
              throw new Error(
                `Unsupported embedding dimension ${row.dims} configured for ${scopeType}:${scopeValue ?? 'null'}`,
              );
            }
            return { model: row.embeddingModel, dims: row.dims, column: col };
          }
        }

        return {
          model: DEFAULT_EMBED_MODEL,
          dims: DEFAULT_EMBED_DIMS,
          column: EMBEDDING_COLUMNS[DEFAULT_EMBED_DIMS]!,
        };
      });
    },

    async getEmbedConfig(scopeType, scopeValue) {
      return run(async (tx) => {
        const normalizedValue =
          scopeType === 'path_prefix' && scopeValue != null
            ? canonicalizePath(scopeValue)
            : scopeValue;
        const conditions: SQL[] = [eq(memoryEmbedConfig.scopeType, scopeType)];
        if (normalizedValue != null) {
          conditions.push(eq(memoryEmbedConfig.scopeValue, normalizedValue));
        } else {
          conditions.push(sql`${memoryEmbedConfig.scopeValue} IS NULL`);
        }

        const [row] = await tx
          .select()
          .from(memoryEmbedConfig)
          .where(and(...conditions))
          .limit(1);

        if (!row) return null;
        return {
          id: row.id,
          scopeType: row.scopeType,
          scopeValue: row.scopeValue,
          embeddingModel: row.embeddingModel,
          dims: row.dims,
        };
      });
    },

    async setEmbedConfig(entry) {
      return run(async (tx) => {
        const col = EMBEDDING_COLUMNS[entry.dims];
        if (!col) {
          throw new Error(
            `Unsupported embedding dimension ${entry.dims}. Supported: ${Object.keys(EMBEDDING_COLUMNS).join(', ')}`,
          );
        }

        const scopeValue =
          entry.scopeType === 'path_prefix' && entry.scopeValue
            ? canonicalizePath(entry.scopeValue)
            : entry.scopeValue;

        const rows = await tx.execute(sql`
          INSERT INTO ${memoryEmbedConfig} (scope_type, scope_value, embedding_model, dims)
          VALUES (${entry.scopeType}, ${scopeValue}, ${entry.embeddingModel}, ${entry.dims})
          ON CONFLICT (scope_type, scope_value) DO UPDATE
          SET embedding_model = EXCLUDED.embedding_model,
              dims = EXCLUDED.dims,
              updated_at = NOW()
          RETURNING id, scope_type, scope_value, embedding_model, dims
        `);

        const row = (rows as unknown as Array<Record<string, unknown>>)[0]!;
        return {
          id: String(row['id']),
          scopeType: String(row['scope_type']),
          scopeValue: scalarOrNull(row['scope_value']),
          embeddingModel: String(row['embedding_model']),
          dims: Number(row['dims']),
        };
      });
    },

    async markDocsStaleForScope(scope) {
      return run(async (tx) => {
        const conditions: SQL[] = [
          sql`${memoryDocs.deletedAt} IS NULL`,
          sql`${memoryDocs.indexingMode} != 'disabled'`,
          sql`${memoryDocs.embeddingStatus} != 'disabled'`,
        ];

        switch (scope.scopeType) {
          case 'global':
            break;
          case 'space':
            if (scope.scopeValue) {
              conditions.push(eq(memoryDocs.spaceId, scope.scopeValue));
            }
            break;
          case 'flow':
            if (scope.scopeValue) {
              conditions.push(eq(memoryDocs.agentId, scope.scopeValue));
            }
            break;
          case 'path_prefix':
            if (scope.scopeValue) {
              const prefix = canonicalizePath(scope.scopeValue);
              conditions.push(sql`${memoryDocs.path} LIKE ${prefix + '%'}`);
            }
            break;
        }

        const rows = await tx
          .update(memoryDocs)
          .set({ embeddingStatus: 'pending', updatedAt: new Date() })
          .where(and(...conditions))
          .returning({ id: memoryDocs.id });

        return rows.map((r) => r.id);
      });
    },

    async getStaleDocsForReembed(limit) {
      return run(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT d.id, d.path, d.content_hash, d.current_version,
                 d.space_id, d.agent_id, v.id AS version_id
          FROM ${memoryDocs} d
          JOIN ${memoryDocVersions} v
            ON v.doc_id = d.id AND v.version = d.current_version
          WHERE d.deleted_at IS NULL
            AND d.embedding_status = 'pending'
            AND d.indexing_mode != 'disabled'
          ORDER BY d.updated_at ASC
          LIMIT ${limit}
        `);

        return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
          id: String(r['id']),
          path: String(r['path']),
          contentHash: String(r['content_hash']),
          currentVersion: Number(r['current_version']),
          latestVersionId: String(r['version_id']),
          spaceId: requiredScalar(r['space_id']),
          agentId: scalarOrNull(r['agent_id']),
        }));
      });
    },

    async withTransaction<T>(
      fn: (txRepo: MemoryDocRepository, txLinkRepo: MemoryLinkRepository) => Promise<T>,
    ): Promise<T> {
      if (options?.inTransaction) {
        const linkRepo = createMemoryLinkRepository(db, tenantContext, { inTransaction: true });
        return fn(this, linkRepo);
      }
      return withTenantSchema(db, tenantContext, async (tx) => {
        const txRepo = createMemoryDocRepository(tx, tenantContext, { inTransaction: true });
        const txLinkRepo = createMemoryLinkRepository(tx, tenantContext, { inTransaction: true });
        return fn(txRepo, txLinkRepo);
      });
    },
  };
}
