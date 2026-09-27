/**
 * Memory Link Repository.
 *
 * Read-time resolution is the core design: whether a link resolves to a live
 * document is NEVER stored. It is recomputed at read by joining `target_path`
 * against live docs in the same space. Likewise a link only counts while its
 * SOURCE doc is live — every read joins `from_doc_id → memory_docs` under the
 * same liveness predicate (both-endpoint liveness).
 *
 * Every query is scoped by `space_id` in the WHERE — never optional.
 */
import { eq, and, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import { memoryLinks } from '../schema/tenant.js';

// ============================================================================
// Types
// ============================================================================

export interface LinkInput {
  targetPath: string;
  ordinal: number;
  occurrenceCount: number;
  firstContext?: string | undefined;
}

export interface OutgoingLink {
  targetPath: string;
  ordinal: number;
  occurrenceCount: number;
  firstContext: string | null;
  resolved: boolean;
}

export interface Backlink {
  fromPath: string;
  firstContext: string | null;
  updatedAt: Date;
}

export interface BacklinkPage {
  items: Backlink[];
  nextCursor?: string;
}

export interface OutgoingCounts {
  resolved: number;
  ghost: number;
}

export interface LinkTargetReferrer {
  path: string;
  firstContext?: string | undefined;
}

export interface LinkTargetResolvedDoc {
  id: string;
  docType: string;
  updatedAt: Date;
  summary?: string | undefined;
}

export interface LinkTarget {
  targetPath: string;
  resolved: boolean;
  referenceCount: number;
  referrers: LinkTargetReferrer[];
  resolvedDoc?: LinkTargetResolvedDoc | undefined;
  /** Keyset cursor positioned immediately after this item, for byte-trim recompute. */
  cursor: string;
}

export interface LinkTargetPage {
  items: LinkTarget[];
  nextCursor?: string;
}

export interface LinkTargetsOptions {
  pathPrefix?: string | undefined;
  unresolvedOnly?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface LinkEdge {
  fromPath: string;
  occurrenceCount: number;
  firstContext?: string | undefined;
  updatedAt: Date;
  /** Keyset cursor positioned immediately after this item, for byte-trim recompute. */
  cursor: string;
}

export interface LinkEdgePage {
  items: LinkEdge[];
  nextCursor?: string;
}

export interface LinkEdgesOptions {
  pathPrefix?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ExpansionDirection = 'out' | 'both';

export interface Neighbor {
  path: string;
  direction: 'out' | 'in';
}

export interface MemoryLinkRepository {
  /**
   * Rebuild the outgoing-link set for a source doc: delete all rows for
   * `fromDocId`, then bulk-insert the provided links (rebuild-on-write).
   */
  replaceLinksForDoc(fromDocId: string, spaceId: string, links: LinkInput[]): Promise<void>;

  /**
   * Outgoing links of a doc, ordered by ordinal; `resolved` (target liveness) is
   * computed at read. This is the "this specific doc" view — it does NOT join
   * source liveness, so a caller viewing a soft-deleted/expired doc still sees
   * the links it authored. The both-endpoint invariant lives on the graph-facing
   * views (getBacklinks/countBacklinks/getLinkTargets/getLinkEdges/expansion),
   * which are reached without a resolved source doc in hand.
   */
  getOutgoingLinks(fromDocId: string, spaceId: string): Promise<OutgoingLink[]>;

  /** Incoming links to `toPath` from LIVE source docs; keyset paginated. */
  getBacklinks(
    toPath: string,
    spaceId: string,
    opts?: { limit?: number | undefined; cursor?: string | undefined },
  ): Promise<BacklinkPage>;

  /**
   * Count of a doc's outgoing links split into resolved vs ghost targets. Like
   * getOutgoingLinks this is the "this specific doc" view — source liveness is
   * the caller's concern, only target liveness is computed here.
   */
  countOutgoing(fromDocId: string, spaceId: string): Promise<OutgoingCounts>;

  /** Count of incoming links to `toPath` from live source docs. */
  countBacklinks(toPath: string, spaceId: string): Promise<number>;

  /** Aggregated hub/agenda view over distinct targets; keyset paginated. */
  getLinkTargets(spaceId: string, opts: LinkTargetsOptions): Promise<LinkTargetPage>;

  /** Complete edge listing for one target (live sources only); keyset paginated. */
  getLinkEdges(targetPath: string, spaceId: string, opts: LinkEdgesOptions): Promise<LinkEdgePage>;

  /** Per-seed capped neighbor lists for graph expansion (both endpoints live). */
  getNeighborsForExpansion(
    seedDocIds: string[],
    spaceId: string,
    direction: ExpansionDirection,
    perSeedCap: number,
  ): Promise<Map<string, Neighbor[]>>;

  withTransaction<T>(fn: (txRepo: MemoryLinkRepository) => Promise<T>): Promise<T>;
}

// ============================================================================
// Helpers
// ============================================================================

type QueryRunner = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>) => Promise<T>;

/** Live-doc predicate over an aliased memory_docs row. */
function liveDocPredicate(alias: string): ReturnType<typeof sql.raw> {
  return sql.raw(
    `${alias}.deleted_at IS NULL AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > now())`,
  );
}

function asString(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? JSON.stringify(value)
    : String(value as string | number);
}

function asStringOrUndefined(value: unknown): string | undefined {
  if (value == null) return undefined;
  return asString(value);
}

function asStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  return asString(value);
}

/**
 * Fixed-width microsecond token for keyset ordering by updated_at. postgres-js
 * decodes timestamptz to a millisecond-precision JS Date, so the raw column
 * value cannot round-trip a Postgres microsecond timestamp — a same-millisecond
 * boundary would silently drop or duplicate rows. The queries therefore order by
 * and compare against this `to_char` token (lexical order == chronological order
 * for the pinned format) so the cursor is exact to the microsecond.
 */
const UPDATED_AT_TOKEN_SQL = `to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/**
 * Keyset cursor for (updated_at DESC, fromDocId ASC) orderings. Encodes the
 * boundary row's microsecond token and fromDocId so the next page starts
 * strictly after it. base64 to keep it opaque and URL-safe.
 */
interface UpdatedAtCursor {
  updatedAtToken: string;
  fromDocId: string;
}

function encodeUpdatedAtCursor(c: UpdatedAtCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeUpdatedAtCursor(raw: string): UpdatedAtCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { updatedAtToken?: unknown }).updatedAtToken === 'string' &&
      typeof (parsed as { fromDocId?: unknown }).fromDocId === 'string'
    ) {
      const p = parsed as { updatedAtToken: string; fromDocId: string };
      return { updatedAtToken: p.updatedAtToken, fromDocId: p.fromDocId };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Keyset cursor for (referenceCount DESC, targetPath ASC) — the getLinkTargets
 * ordering. referenceCount is the live-source aggregate count.
 */
interface TargetCursor {
  referenceCount: number;
  targetPath: string;
}

function encodeTargetCursor(c: TargetCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeTargetCursor(raw: string): TargetCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { referenceCount?: unknown }).referenceCount === 'number' &&
      typeof (parsed as { targetPath?: unknown }).targetPath === 'string'
    ) {
      const p = parsed as { referenceCount: number; targetPath: string };
      return { referenceCount: p.referenceCount, targetPath: p.targetPath };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * @param options.inTransaction - When true, `db` is already a Drizzle tx with
 *   search_path set. Methods use it directly, skipping withTenantSchema.
 */
export function createMemoryLinkRepository(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  options?: { inTransaction?: boolean },
): MemoryLinkRepository {
  const run: QueryRunner = options?.inTransaction
    ? async (fn) => fn(db)
    : async (fn) => withTenantSchema(db, tenantContext, fn);

  return {
    async replaceLinksForDoc(fromDocId, spaceId, links) {
      return run(async (tx) => {
        await tx
          .delete(memoryLinks)
          .where(and(eq(memoryLinks.fromDocId, fromDocId), eq(memoryLinks.spaceId, spaceId)));

        if (links.length === 0) return;

        await tx.insert(memoryLinks).values(
          links.map((l) => ({
            spaceId,
            fromDocId,
            targetPath: l.targetPath,
            ordinal: l.ordinal,
            occurrenceCount: l.occurrenceCount,
            firstContext: l.firstContext ?? null,
          })),
        );
      });
    },

    async getOutgoingLinks(fromDocId, spaceId) {
      return run(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT
            l.target_path,
            l.ordinal,
            l.occurrence_count,
            l.first_context,
            EXISTS (
              SELECT 1 FROM memory_docs t
              WHERE t.space_id = ${spaceId}
                AND t.path = l.target_path
                AND ${liveDocPredicate('t')}
            ) AS resolved
          FROM memory_links l
          WHERE l.space_id = ${spaceId}
            AND l.from_doc_id = ${fromDocId}::uuid
          ORDER BY l.ordinal ASC
        `);

        return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
          targetPath: asString(r['target_path']),
          ordinal: Number(r['ordinal']),
          occurrenceCount: Number(r['occurrence_count']),
          firstContext: asStringOrNull(r['first_context']),
          resolved: r['resolved'] === true,
        }));
      });
    },

    async getBacklinks(toPath, spaceId, opts) {
      const limit = opts?.limit ?? 50;
      const cursor = opts?.cursor ? decodeUpdatedAtCursor(opts.cursor) : null;

      return run(async (tx) => {
        const cursorClause = cursor
          ? sql`AND (${sql.raw(UPDATED_AT_TOKEN_SQL)} < ${cursor.updatedAtToken}
              OR (${sql.raw(UPDATED_AT_TOKEN_SQL)} = ${cursor.updatedAtToken}
                  AND l.from_doc_id > ${cursor.fromDocId}::uuid))`
          : sql``;

        const rows = await tx.execute(sql`
          SELECT
            s.path AS from_path,
            l.first_context,
            s.updated_at,
            ${sql.raw(UPDATED_AT_TOKEN_SQL)} AS updated_at_token,
            l.from_doc_id
          FROM memory_links l
          JOIN memory_docs s ON s.id = l.from_doc_id
          WHERE l.space_id = ${spaceId}
            AND l.target_path = ${toPath}
            AND s.space_id = ${spaceId}
            AND ${liveDocPredicate('s')}
            ${cursorClause}
          ORDER BY ${sql.raw(UPDATED_AT_TOKEN_SQL)} DESC, l.from_doc_id ASC
          LIMIT ${limit + 1}
        `);

        const list = rows as unknown as Array<Record<string, unknown>>;
        const hasMore = list.length > limit;
        const page = hasMore ? list.slice(0, limit) : list;

        const items: Backlink[] = page.map((r) => ({
          fromPath: asString(r['from_path']),
          firstContext: asStringOrNull(r['first_context']),
          updatedAt: new Date(asString(r['updated_at'])),
        }));

        if (!hasMore) return { items };
        const last = page[page.length - 1]!;
        return {
          items,
          nextCursor: encodeUpdatedAtCursor({
            updatedAtToken: asString(last['updated_at_token']),
            fromDocId: asString(last['from_doc_id']),
          }),
        };
      });
    },

    async countOutgoing(fromDocId, spaceId) {
      return run(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE resolved) AS resolved,
            COUNT(*) FILTER (WHERE NOT resolved) AS ghost
          FROM (
            SELECT EXISTS (
              SELECT 1 FROM memory_docs t
              WHERE t.space_id = ${spaceId}
                AND t.path = l.target_path
                AND ${liveDocPredicate('t')}
            ) AS resolved
            FROM memory_links l
            WHERE l.space_id = ${spaceId}
              AND l.from_doc_id = ${fromDocId}::uuid
          ) counted
        `);

        const row = (rows as unknown as Array<Record<string, unknown>>)[0];
        return {
          resolved: Number(row?.['resolved'] ?? 0),
          ghost: Number(row?.['ghost'] ?? 0),
        };
      });
    },

    async countBacklinks(toPath, spaceId) {
      return run(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT COUNT(*)::int AS c
          FROM memory_links l
          JOIN memory_docs s ON s.id = l.from_doc_id
          WHERE l.space_id = ${spaceId}
            AND l.target_path = ${toPath}
            AND s.space_id = ${spaceId}
            AND ${liveDocPredicate('s')}
        `);
        const row = (rows as unknown as Array<Record<string, unknown>>)[0];
        return Number(row?.['c'] ?? 0);
      });
    },

    async getLinkTargets(spaceId, opts) {
      const limit = opts.limit ?? 50;
      const cursor = opts.cursor ? decodeTargetCursor(opts.cursor) : null;

      return run(async (tx) => {
        const prefixClause = opts.pathPrefix
          ? sql`AND s.path LIKE ${opts.pathPrefix + '%'}`
          : sql``;
        const unresolvedClause = opts.unresolvedOnly
          ? sql`AND NOT EXISTS (
              SELECT 1 FROM memory_docs t
              WHERE t.space_id = ${spaceId}
                AND t.path = agg.target_path
                AND ${liveDocPredicate('t')}
            )`
          : sql``;
        const cursorClause = cursor
          ? sql`AND (agg.reference_count < ${cursor.referenceCount}
              OR (agg.reference_count = ${cursor.referenceCount}
                  AND agg.target_path > ${cursor.targetPath}))`
          : sql``;

        const rows = await tx.execute(sql`
          WITH agg AS (
            SELECT
              l.target_path,
              COUNT(*)::int AS reference_count
            FROM memory_links l
            JOIN memory_docs s ON s.id = l.from_doc_id
            WHERE l.space_id = ${spaceId}
              AND s.space_id = ${spaceId}
              AND ${liveDocPredicate('s')}
              ${prefixClause}
            GROUP BY l.target_path
          )
          SELECT
            agg.target_path,
            agg.reference_count,
            EXISTS (
              SELECT 1 FROM memory_docs t
              WHERE t.space_id = ${spaceId}
                AND t.path = agg.target_path
                AND ${liveDocPredicate('t')}
            ) AS resolved,
            rd.id AS resolved_id,
            rd.doc_type AS resolved_doc_type,
            rd.updated_at AS resolved_updated_at,
            rd.summary AS resolved_summary
          FROM agg
          LEFT JOIN LATERAL (
            SELECT t.id, t.doc_type, t.updated_at, t.summary
            FROM memory_docs t
            WHERE t.space_id = ${spaceId}
              AND t.path = agg.target_path
              AND ${liveDocPredicate('t')}
            LIMIT 1
          ) rd ON true
          WHERE TRUE
            ${unresolvedClause}
            ${cursorClause}
          ORDER BY agg.reference_count DESC, agg.target_path ASC
          LIMIT ${limit + 1}
        `);

        const list = rows as unknown as Array<Record<string, unknown>>;
        const hasMore = list.length > limit;
        const page = hasMore ? list.slice(0, limit) : list;

        const items: LinkTarget[] = [];
        for (const r of page) {
          const targetPath = asString(r['target_path']);
          const referrerRows = await tx.execute(sql`
            SELECT s.path, l.first_context
            FROM memory_links l
            JOIN memory_docs s ON s.id = l.from_doc_id
            WHERE l.space_id = ${spaceId}
              AND l.target_path = ${targetPath}
              AND s.space_id = ${spaceId}
              AND ${liveDocPredicate('s')}
              ${prefixClause}
            ORDER BY s.updated_at DESC, l.from_doc_id ASC
            LIMIT 5
          `);
          const referrers: LinkTargetReferrer[] = (
            referrerRows as unknown as Array<Record<string, unknown>>
          ).map((rr) => {
            const ctx = asStringOrUndefined(rr['first_context']);
            return ctx === undefined
              ? { path: asString(rr['path']) }
              : { path: asString(rr['path']), firstContext: ctx };
          });

          const resolved = r['resolved'] === true;
          const target: LinkTarget = {
            targetPath,
            resolved,
            referenceCount: Number(r['reference_count']),
            referrers,
            cursor: encodeTargetCursor({
              referenceCount: Number(r['reference_count']),
              targetPath,
            }),
          };
          if (resolved && r['resolved_id'] != null) {
            const summary = asStringOrUndefined(r['resolved_summary']);
            target.resolvedDoc = {
              id: asString(r['resolved_id']),
              docType: asString(r['resolved_doc_type']),
              updatedAt: new Date(asString(r['resolved_updated_at'])),
              ...(summary === undefined ? {} : { summary }),
            };
          }
          items.push(target);
        }

        if (!hasMore) return { items };
        const last = page[page.length - 1]!;
        return {
          items,
          nextCursor: encodeTargetCursor({
            referenceCount: Number(last['reference_count']),
            targetPath: asString(last['target_path']),
          }),
        };
      });
    },

    async getLinkEdges(targetPath, spaceId, opts) {
      const limit = opts.limit ?? 50;
      const cursor = opts.cursor ? decodeUpdatedAtCursor(opts.cursor) : null;

      return run(async (tx) => {
        const prefixClause = opts.pathPrefix
          ? sql`AND s.path LIKE ${opts.pathPrefix + '%'}`
          : sql``;
        const cursorClause = cursor
          ? sql`AND (${sql.raw(UPDATED_AT_TOKEN_SQL)} < ${cursor.updatedAtToken}
              OR (${sql.raw(UPDATED_AT_TOKEN_SQL)} = ${cursor.updatedAtToken}
                  AND l.from_doc_id > ${cursor.fromDocId}::uuid))`
          : sql``;

        const rows = await tx.execute(sql`
          SELECT
            s.path AS from_path,
            l.occurrence_count,
            l.first_context,
            s.updated_at,
            ${sql.raw(UPDATED_AT_TOKEN_SQL)} AS updated_at_token,
            l.from_doc_id
          FROM memory_links l
          JOIN memory_docs s ON s.id = l.from_doc_id
          WHERE l.space_id = ${spaceId}
            AND l.target_path = ${targetPath}
            AND s.space_id = ${spaceId}
            AND ${liveDocPredicate('s')}
            ${prefixClause}
            ${cursorClause}
          ORDER BY ${sql.raw(UPDATED_AT_TOKEN_SQL)} DESC, l.from_doc_id ASC
          LIMIT ${limit + 1}
        `);

        const list = rows as unknown as Array<Record<string, unknown>>;
        const hasMore = list.length > limit;
        const page = hasMore ? list.slice(0, limit) : list;

        const items: LinkEdge[] = page.map((r) => {
          const ctx = asStringOrUndefined(r['first_context']);
          return {
            fromPath: asString(r['from_path']),
            occurrenceCount: Number(r['occurrence_count']),
            updatedAt: new Date(asString(r['updated_at'])),
            ...(ctx === undefined ? {} : { firstContext: ctx }),
            cursor: encodeUpdatedAtCursor({
              updatedAtToken: asString(r['updated_at_token']),
              fromDocId: asString(r['from_doc_id']),
            }),
          };
        });

        if (!hasMore) return { items };
        const last = page[page.length - 1]!;
        return {
          items,
          nextCursor: encodeUpdatedAtCursor({
            updatedAtToken: asString(last['updated_at_token']),
            fromDocId: asString(last['from_doc_id']),
          }),
        };
      });
    },

    async getNeighborsForExpansion(seedDocIds, spaceId, direction, perSeedCap) {
      const result = new Map<string, Neighbor[]>();
      if (seedDocIds.length === 0) return result;
      for (const id of seedDocIds) result.set(id, []);

      return run(async (tx) => {
        const seedArray = sql`ARRAY[${sql.join(
          seedDocIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]::uuid[]`;

        const outRows = await tx.execute(sql`
          SELECT seed_id, path FROM (
            SELECT
              l.from_doc_id AS seed_id,
              t.path AS path,
              ROW_NUMBER() OVER (PARTITION BY l.from_doc_id ORDER BY l.ordinal ASC) AS rn
            FROM memory_links l
            JOIN memory_docs s ON s.id = l.from_doc_id
            JOIN memory_docs t
              ON t.space_id = ${spaceId} AND t.path = l.target_path AND ${liveDocPredicate('t')}
            WHERE l.space_id = ${spaceId}
              AND l.from_doc_id = ANY(${seedArray})
              AND s.space_id = ${spaceId}
              AND ${liveDocPredicate('s')}
          ) ranked
          WHERE rn <= ${perSeedCap}
        `);
        for (const r of outRows as unknown as Array<Record<string, unknown>>) {
          const seedId = asString(r['seed_id']);
          const arr = result.get(seedId);
          if (arr) arr.push({ path: asString(r['path']), direction: 'out' });
        }

        if (direction === 'both') {
          const inRows = await tx.execute(sql`
            SELECT seed_id, path FROM (
              SELECT
                t.id AS seed_id,
                s.path AS path,
                ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY s.updated_at DESC, l.from_doc_id ASC) AS rn
              FROM memory_links l
              JOIN memory_docs s ON s.id = l.from_doc_id
              JOIN memory_docs t
                ON t.space_id = ${spaceId} AND t.path = l.target_path AND ${liveDocPredicate('t')}
              WHERE l.space_id = ${spaceId}
                AND t.id = ANY(${seedArray})
                AND s.space_id = ${spaceId}
                AND ${liveDocPredicate('s')}
            ) ranked
            WHERE rn <= ${perSeedCap}
          `);
          for (const r of inRows as unknown as Array<Record<string, unknown>>) {
            const seedId = asString(r['seed_id']);
            const arr = result.get(seedId);
            if (arr) arr.push({ path: asString(r['path']), direction: 'in' });
          }
        }

        return result;
      });
    },

    async withTransaction<T>(fn: (txRepo: MemoryLinkRepository) => Promise<T>): Promise<T> {
      if (options?.inTransaction) {
        return fn(this);
      }
      return withTenantSchema(db, tenantContext, async (tx) => {
        const txRepo = createMemoryLinkRepository(tx, tenantContext, { inTransaction: true });
        return fn(txRepo);
      });
    },
  };
}
