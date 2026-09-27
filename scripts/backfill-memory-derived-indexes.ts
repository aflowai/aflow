#!/usr/bin/env npx tsx
/**
 * Backfill link/property/derivation indexes for pre-authority linkable docs.
 *
 * Per tenant schema, iterate live docs whose docType is linkable and whose
 * stored derivation does not already match the current content+schema, then
 * re-derive links + properties + chunks through the SAME write authority
 * (commitDerivedIndexes). Each apply re-reads the doc FOR UPDATE inside a short
 * transaction and only writes when currentVersion AND contentHash still match
 * the prepared snapshot (apply-time CAS) — the row lock serializes a concurrent
 * live write so it is always observed: it either commits before the lock (the
 * re-read sees its bumped version → skip) or blocks until this tx commits (the
 * live write wins next). The backfill never clobbers a newer live derivation.
 *
 * A rebuilt auto-indexed doc drops its embedded chunks, so the returned embed
 * job is published (mirroring writeMemoryDoc) — otherwise the doc would read
 * 'indexed' with zero embeddings and the periodic re-embed scan (pending-only)
 * would not heal it.
 *
 * Reads are NEVER gated on this backfill: a missed doc simply has no links until
 * its next write. Resumable (doc-id ordered), idempotent (the sourceHash skip),
 * per-doc failures logged and skipped.
 *
 *   npx tsx scripts/backfill-memory-derived-indexes.ts [--dry-run]
 */
import { pathToFileURL } from 'node:url';
import { and, asc, gt, inArray, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createDatabase,
  getDatabaseConfig,
  createTenantContext,
  createMemoryDocRepository,
  listTenantSchemas,
  withTenantSchema,
  memoryDocs,
  type TenantContext,
  type MemoryDoc,
  type MemoryDocRepository,
} from '@aflow/database';
import {
  createPayloadStore,
  createRedisPayloadStore,
  getPayloadStoreConfig,
  type PayloadStore,
} from '@aflow/payload-store';
import {
  createRedisConnection,
  getExecutorRedisConfig,
  publishMemoryDocEmbedJob,
} from '@aflow/redis';
import {
  LINKABLE_DOC_TYPES,
  computeContentHash,
  prepareDerivedIndexes,
  commitDerivedIndexes,
} from '@aflow/memory-store';
import type { MemoryDocEmbedJob, TenantId } from '@aflow/schemas';
import type { Redis } from 'ioredis';

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE_SIZE = 500;

/** The schema version this backfill produces — must track prepareDerivedIndexes. */
const CURRENT_SCHEMA_VERSION = 1;

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

export interface TenantCounts {
  scanned: number;
  wouldDerive: number;
  derived: number;
  skippedMatching: number;
  skippedCas: number;
  wouldGainProperties: number;
  failures: number;
}

export function emptyCounts(): TenantCounts {
  return {
    scanned: 0,
    wouldDerive: 0,
    derived: 0,
    skippedMatching: 0,
    skippedCas: 0,
    wouldGainProperties: 0,
    failures: 0,
  };
}

async function resolveContent(doc: MemoryDoc, payloadStore: PayloadStore): Promise<string> {
  if (doc.inlineContent !== null) return doc.inlineContent;
  if (doc.payloadRef) {
    const payload = await payloadStore.retrieve(doc.payloadRef);
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
  }
  return '';
}

/** Cheap skip: the stored derivation already reflects this content and schema. */
function derivationIsCurrent(doc: MemoryDoc, contentHash: string): boolean {
  const d = doc.derivation;
  return d !== null && d.schemaVersion === CURRENT_SCHEMA_VERSION && d.sourceHash === contentHash;
}

/**
 * Outcome of a single CAS-guarded apply. `applied` false with no embedJob is the
 * CAS-lost skip (a concurrent live write moved the doc). `embedJob` non-null when
 * the rebuilt doc owes a (re-)embed the caller must publish.
 */
export interface ApplyOutcome {
  applied: boolean;
  embedJob: MemoryDocEmbedJob | null;
}

/**
 * Apply the prepared derivation to one doc under apply-time CAS. Re-reads the
 * doc FOR UPDATE inside the caller's short transaction and commits the derived
 * indexes ONLY IF currentVersion AND contentHash still match the snapshot. The
 * row lock forces a concurrent live write to be observed (it commits before the
 * lock → version bumped → skip; or blocks until we commit → it wins next), so a
 * newer live derivation is never clobbered.
 *
 * Exported so the shipped apply path is the one tests exercise (no re-implement).
 */
export async function applyDocDerivation(
  repo: MemoryDocRepository,
  tenantId: TenantId,
  snapshot: { id: string; spaceId: string; currentVersion: number; contentHash: string | null },
  prepared: ReturnType<typeof prepareDerivedIndexes>,
  payloadStore: PayloadStore,
): Promise<ApplyOutcome> {
  return repo.withTransaction(async (txRepo, txLinkRepo) => {
    const fresh = await txRepo.getById(snapshot.id, snapshot.spaceId, { forUpdate: true });
    if (fresh === null) {
      return { applied: false, embedJob: null };
    }
    if (
      fresh.currentVersion !== snapshot.currentVersion ||
      fresh.contentHash !== snapshot.contentHash
    ) {
      return { applied: false, embedJob: null };
    }
    const { embedJob } = await commitDerivedIndexes(txRepo, txLinkRepo, fresh, prepared, {
      payloadStore,
      log: noopLog,
      tenantId,
    });
    return { applied: true, embedJob };
  });
}

/** One page of candidate doc-id/space-id pairs, ordered by id for a stable cursor. */
async function fetchCandidatePage(
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  afterId: string | null,
): Promise<Array<{ id: string; spaceId: string }>> {
  const linkableTypes = [...LINKABLE_DOC_TYPES];
  return withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({ id: memoryDocs.id, spaceId: memoryDocs.spaceId })
      .from(memoryDocs)
      .where(
        and(
          inArray(memoryDocs.docType, linkableTypes),
          isNull(memoryDocs.deletedAt),
          afterId ? gt(memoryDocs.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(memoryDocs.id))
      .limit(PAGE_SIZE),
  );
}

async function backfillTenant(
  tenantId: TenantId,
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  repo: MemoryDocRepository,
  payloadStore: PayloadStore,
  redis: Redis | null,
): Promise<TenantCounts> {
  const counts = emptyCounts();
  let cursor: string | null = null;

  for (;;) {
    const candidates = await fetchCandidatePage(db, tenantCtx, cursor);
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      cursor = candidate.id;
      counts.scanned += 1;

      let doc: MemoryDoc | null;
      try {
        doc = await repo.getById(candidate.id, candidate.spaceId);
      } catch (err) {
        counts.failures += 1;
        console.warn(`    [${tenantId}] failed to load ${candidate.id}: ${errMsg(err)}`);
        continue;
      }
      if (!doc) continue;

      let content: string;
      try {
        content = await resolveContent(doc, payloadStore);
      } catch (err) {
        counts.failures += 1;
        console.warn(`    [${tenantId}] failed to resolve content for ${doc.path}: ${errMsg(err)}`);
        continue;
      }

      const contentHash = computeContentHash(content);
      if (derivationIsCurrent(doc, contentHash)) {
        counts.skippedMatching += 1;
        continue;
      }

      counts.wouldDerive += 1;

      let prepared: ReturnType<typeof prepareDerivedIndexes>;
      try {
        prepared = prepareDerivedIndexes(content, doc.docType, doc.path);
      } catch (err) {
        counts.failures += 1;
        console.warn(`    [${tenantId}] prepare failed for ${doc.path}: ${errMsg(err)}`);
        continue;
      }

      if (prepared.hadFrontmatter && Object.keys(prepared.properties).length > 0) {
        counts.wouldGainProperties += 1;
      }

      if (DRY_RUN) continue;

      try {
        const outcome = await applyDocDerivation(
          repo,
          tenantId,
          {
            id: doc.id,
            spaceId: doc.spaceId,
            currentVersion: doc.currentVersion,
            contentHash: doc.contentHash,
          },
          prepared,
          payloadStore,
        );
        if (outcome.applied) {
          counts.derived += 1;
          // The rebuilt doc dropped its embedded chunks; publish the (re-)embed
          // job so vector search recovers — mirrors writeMemoryDoc's post-commit
          // publish. Without a transport the doc stays 'indexed' with no vectors.
          if (outcome.embedJob) {
            if (redis) {
              try {
                await publishMemoryDocEmbedJob(redis, outcome.embedJob);
              } catch (err) {
                console.warn(
                  `    [${tenantId}] embed publish failed for ${doc.path}: ${errMsg(err)}`,
                );
              }
            } else {
              console.warn(
                `    [${tenantId}] re-embed owed for ${doc.path} but no Redis transport`,
              );
            }
          }
        } else {
          counts.skippedCas += 1;
        }
      } catch (err) {
        counts.failures += 1;
        console.warn(`    [${tenantId}] apply failed for ${doc.path}: ${errMsg(err)}`);
      }
    }

    if (candidates.length < PAGE_SIZE) break;
  }

  return counts;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

function addCounts(total: TenantCounts, t: TenantCounts): void {
  total.scanned += t.scanned;
  total.wouldDerive += t.wouldDerive;
  total.derived += t.derived;
  total.skippedMatching += t.skippedMatching;
  total.skippedCas += t.skippedCas;
  total.wouldGainProperties += t.wouldGainProperties;
  total.failures += t.failures;
}

function summarize(label: string, c: TenantCounts): string {
  return (
    `scanned ${String(c.scanned)}, ` +
    `${DRY_RUN ? 'would-derive' : 'derived'} ${String(DRY_RUN ? c.wouldDerive : c.derived)}, ` +
    `skip-matching ${String(c.skippedMatching)}` +
    (DRY_RUN ? '' : `, skip-cas ${String(c.skippedCas)}`) +
    `, would-gain-properties ${String(c.wouldGainProperties)}` +
    `, failures ${String(c.failures)} ${label}`
  );
}

async function main(): Promise<void> {
  console.log(
    `backfill-memory-derived-indexes: starting${DRY_RUN ? ' (--dry-run — no writes)' : ''}`,
  );

  const handle = createDatabase(getDatabaseConfig());

  // Content resolution must read payloads through the SAME store the writers
  // used, so mirror the executor's GCS → Redis → in-memory fallback chain. A
  // Redis connection is always opened for embed-job publishing (even on GCS).
  let payloadRedis: Redis | null = null;
  let embedRedis: Redis | null = null;
  let payloadStore: PayloadStore;
  try {
    payloadStore = createPayloadStore(getPayloadStoreConfig());
    console.log('  payload store: GCS');
  } catch {
    payloadRedis = createRedisConnection({
      ...getExecutorRedisConfig(),
      connectionName: `backfill-derived-indexes-payload-${String(process.pid)}`,
    });
    payloadStore = createRedisPayloadStore(payloadRedis);
    console.log('  payload store: Redis (GCS not configured)');
  }

  if (!DRY_RUN) {
    embedRedis =
      payloadRedis ??
      createRedisConnection({
        ...getExecutorRedisConfig(),
        connectionName: `backfill-derived-indexes-embed-${String(process.pid)}`,
      });
  }

  const total = emptyCounts();

  try {
    const tenantSchemas = await listTenantSchemas(handle.sql);
    for (const schema of tenantSchemas) {
      const tenantCtx = createTenantContext(schema.tenantId);
      const repo = createMemoryDocRepository(handle.db, tenantCtx);
      const counts = await backfillTenant(
        schema.tenantId,
        handle.db,
        tenantCtx,
        repo,
        payloadStore,
        embedRedis,
      );
      addCounts(total, counts);
      if (counts.scanned > 0) {
        console.log(`  ${summarize(`[${schema.tenantId}]`, counts)}`);
      }
    }
  } finally {
    await handle.close();
    if (payloadRedis) await payloadRedis.quit();
    if (embedRedis && embedRedis !== payloadRedis) await embedRedis.quit();
  }

  console.log(`\nbackfill complete: ${summarize('(all tenants)', total)}`);
}

const isEntrypoint =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error('backfill-memory-derived-indexes failed:', err);
    process.exit(1);
  });
}
