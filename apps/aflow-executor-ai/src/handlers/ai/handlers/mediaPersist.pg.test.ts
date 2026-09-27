/**
 * Where a render's bytes actually land, against the real memory tables.
 *
 * The addressing, the same-path refusal and the all-or-nothing production are
 * all properties of what the database ends up holding, so a fake repository
 * could not tell any of them apart from their absence.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  createMemoryDocRepository,
  withTenantSchema,
  type MemoryDoc,
  type MemoryDocRepository,
  type TenantContext,
} from '@aflow/database';
import { saveBytesToMemoryDoc, runOrigin, MemoryWriteDeniedError } from '@aflow/memory-store';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { deriveMediaAssetId, type MediaGenerationReceipt, type TenantId } from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  persistMediaProduction,
  type MediaCandidateBytes,
  type MediaPersistenceTarget,
} from './mediaPersist.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
/**
 * This suite's namespace, and inside it one space of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail is
 * what keeps two concurrent runs — two worktrees, a re-run started before the
 * last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = 'd0000000-0000-0000-284b-';
const SPACE_ID = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const OTHER_PNG = Buffer.from('89504e470d0a1a0aff', 'hex');

function candidate(bytes: Buffer, mimeType = 'image/png'): MediaCandidateBytes {
  return {
    bytes,
    mimeType,
    providerNative: { status: 'none', reason: 'route_issues_none' },
  };
}

function receiptFor(
  requestKey: string,
  runId: string,
  logicalExecutionId: string,
): MediaGenerationReceipt {
  return {
    execution: { runId, logicalExecutionId, attempt: 1, requestKey },
    request: {
      prompt: 'Ada at the workbench',
      parameters: { size: '1024x1024' },
      boundEntityVersions: [],
    },
    provider: 'openai',
    model: 'gpt-image-1.5',
    capabilityRoute: { routeId: 'openai:gpt-image-1.5:sync' },
    cost: {},
    rendered: {},
    createdAt: '2026-08-16T10:00:00.000Z',
  };
}

function fakeCtx(runId: string, stepExecutionId: string): ExecutorContext {
  return {
    job: {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      stepExecutionId,
      attempt: 1,
      stepId: 'render',
      stepType: 'ai',
    },
    tenantId: TENANT_ID as TenantId,
    spaceId: SPACE_ID,
    runId,
    stepExecutionId,
    logicalExecutionId: `step:${stepExecutionId}`,
    attempt: 1,
    operationId: 'ai.media.image',
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as unknown as ExecutorContext;
}

describeDb('persistMediaProduction — the library a render leaves behind (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as TenantId);
  const docs: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);
  const target: MediaPersistenceTarget = {
    db,
    payloadStore: createMemoryPayloadStore(),
    spaceId: SPACE_ID,
  };

  let schemaReady = false;
  let tenantPresent = false;

  /** The space is this execution's alone, so it is the whole handle. */
  async function clearOwnRows(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM memory_links WHERE space_id = ${SPACE_ID}::uuid`);
      await tx.execute(drizzleSql`DELETE FROM memory_docs WHERE space_id = ${SPACE_ID}::uuid`);
      await tx.execute(drizzleSql`DELETE FROM memory_dirs WHERE space_id = ${SPACE_ID}::uuid`);
    });
  }

  /**
   * What earlier executions of this suite left behind. Only rows old enough
   * that no live execution could still be writing them — an execution running
   * right now in another checkout is not this one's to clean up.
   */
  async function sweepAbandonedRows(): Promise<void> {
    const stale = `${SPACE_NAMESPACE}%`;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(
        drizzleSql`DELETE FROM memory_links WHERE space_id::text LIKE ${stale}
                   AND created_at < now() - interval '1 hour'`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_docs WHERE space_id::text LIKE ${stale}
                   AND created_at < now() - interval '1 hour'`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_dirs WHERE space_id::text LIKE ${stale}
                   AND created_at < now() - interval '1 hour'`,
      );
    });
  }

  /**
   * Occupies a path with bytes of the caller's choosing, ahead of a production
   * — an earlier render of the same request, from this lane's own authority.
   */
  async function preFile(path: string, bytes: Buffer, ctx: ExecutorContext): Promise<string> {
    const stored = await saveBytesToMemoryDoc({
      db,
      payloadStore: target.payloadStore,
      log: ctx.log,
      tenantId: ctx.tenantId,
      origin: runOrigin(ctx),
      spaceId: SPACE_ID,
      path,
      docType: 'image',
      mimeType: 'image/png',
      indexing: 'disabled',
      tags: ['generated_media', 'image'],
      content: { kind: 'binary', bytes },
      contentType: null,
      governedWriter: 'generated_media',
    });
    return stored.docId;
  }

  async function liveDoc(path: string): Promise<MemoryDoc | null> {
    return await docs.getByPath(path, SPACE_ID);
  }

  /** The paths the note's wikilinks are indexed under, as the link table holds them. */
  async function noteTargets(noteDocId: string): Promise<string[]> {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.execute(
        drizzleSql`SELECT target_path FROM memory_links
                   WHERE from_doc_id = ${noteDocId}::uuid AND space_id = ${SPACE_ID}::uuid`,
      ),
    );
    return (rows as unknown as Array<Record<string, unknown>>)
      .map((row) => String(row['target_path']))
      .sort();
  }

  async function assetPathsUnder(directory: string): Promise<string[]> {
    const rows = await docs.list({
      pathPrefix: `${directory}/`,
      scope: { spaceId: SPACE_ID },
      filters: { docType: ['image'] },
    });
    return rows.map((row) => row.path).sort();
  }

  beforeAll(async () => {
    const rows = await sql<{ tenant: boolean; table: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
        ) AS tenant,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_docs'
        ) AS "table"`;
    tenantPresent = rows[0]?.tenant === true;
    schemaReady = rows[0]?.table === true;
    if (schemaReady) await sweepAbandonedRows();
  });

  // A tenant that was never created is CI, which seeds no dev schema and where a
  // database-backed suite has nothing to say. A tenant that exists without the
  // table is a checkout that has not migrated, which is worth failing on.
  beforeEach((ctx) => {
    if (!tenantPresent) {
      ctx.skip();
      return;
    }
    if (!schemaReady) throw new Error('memory_docs is missing — run yarn db:migrate');
  });

  afterAll(async () => {
    try {
      if (schemaReady) await clearOwnRows();
    } finally {
      await handle.close();
    }
  });

  it('files every candidate under the run, addressed by its position, with a receipt and a note', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;

    const output = await persistMediaProduction({
      ctx,
      target,
      kind: 'image',
      candidates: [candidate(PNG), candidate(OTHER_PNG)],
      receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
    });

    const first = deriveMediaAssetId(requestKey, 0);
    const stem = first.slice(0, first.lastIndexOf('-'));

    expect(output.assets.map((asset) => asset.assetId)).toEqual([
      first,
      deriveMediaAssetId(requestKey, 1),
    ]);
    expect(output.assets.map((asset) => asset.candidateIndex)).toEqual([0, 1]);
    expect(output.assets.map((asset) => asset.path)).toEqual([
      `/media/${runId}/take-${first}`,
      `/media/${runId}/take-${deriveMediaAssetId(requestKey, 1)}`,
    ]);
    expect(output.assets[0]?.sizeBytes).toBe(PNG.byteLength);
    expect(output.receiptRef.path).toBe(`/media/${runId}/take-${stem}.receipt.json`);

    // The bytes are never chunked or embedded; the note beside them is what a
    // search can reach, and it is the only linkable half of the render.
    const note = await liveDoc(`/media/${runId}/take-${stem}.md`);
    expect(note?.docType).toBe('markdown');
    expect((await liveDoc(output.assets[0]?.path ?? ''))?.docType).toBe('image');
    expect((await liveDoc(output.receiptRef.path))?.docType).toBe('json');

    // An asset is filed without an extension, so the note's link to it is
    // indexed at that exact path or at no path at all — a completed
    // `…-0.md` target names a document that cannot exist, and the asset it was
    // supposed to make reachable has no backlink to it either.
    expect(await noteTargets(note?.id ?? '')).toEqual(
      [...output.assets.map((asset) => asset.path), output.receiptRef.path].sort(),
    );
  });

  it('resolves one paid request to one document, whatever container the provider delivers', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;
    const directory = `/media/${runId}`;

    const png = await persistMediaProduction({
      ctx,
      target,
      kind: 'image',
      candidates: [candidate(PNG, 'image/png')],
      receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
    });
    const address = png.assets[0]?.path ?? '';

    // The same request, re-delivered as a different container with different
    // bytes. The address is the request's, so this is the same document being
    // replaced — refused — rather than a second one appearing beside it.
    await expect(
      persistMediaProduction({
        ctx,
        target,
        kind: 'image',
        candidates: [candidate(OTHER_PNG, 'image/jpeg')],
        receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
      }),
    ).rejects.toThrow(/MEMORY_HASH_MISMATCH/);

    expect(await assetPathsUnder(directory)).toEqual([address]);

    // The same bytes announced as a different container resolve to the one
    // document too, and the container it was delivered as rides the row.
    const rerun = await persistMediaProduction({
      ctx,
      target,
      kind: 'image',
      candidates: [candidate(PNG, 'image/jpeg')],
      receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
    });

    expect(rerun.assets[0]?.path).toBe(address);
    expect(rerun.assets[0]?.docId).toBe(png.assets[0]?.docId);
    expect(await assetPathsUnder(directory)).toEqual([address]);
    expect((await liveDoc(address))?.mimeType).toBe('image/jpeg');
  });

  it('refuses a path that already holds different bytes rather than replacing them', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;
    const path = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 0)}`;

    await preFile(path, OTHER_PNG, ctx);

    await expect(
      persistMediaProduction({
        ctx,
        target,
        kind: 'image',
        candidates: [candidate(PNG)],
        receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
      }),
    ).rejects.toThrow(/MEMORY_HASH_MISMATCH/);

    const held = await liveDoc(path);
    expect(held?.currentVersion).toBe(1);
    expect(held?.sizeBytes).toBe(OTHER_PNG.byteLength);
  });

  it('refuses a deleted path that holds different bytes rather than reviving and replacing it', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;
    const path = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 0)}`;

    const docId = await preFile(path, OTHER_PNG, ctx);
    expect(await docs.softDelete(docId, SPACE_ID)).toBe(true);

    await expect(
      persistMediaProduction({
        ctx,
        target,
        kind: 'image',
        candidates: [candidate(PNG)],
        receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
      }),
    ).rejects.toThrow(/MEMORY_HASH_MISMATCH/);

    const held = await docs.getByPath(path, SPACE_ID, { includeDeleted: true });
    expect(held?.currentVersion).toBe(1);
    expect(held?.sizeBytes).toBe(OTHER_PNG.byteLength);
    expect(held?.deletedAt).not.toBeNull();
  });

  it('leaves no asset behind when the production cannot complete', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;
    const firstPath = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 0)}`;
    const secondPath = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 1)}`;

    // The second candidate cannot be filed, so the first one — already written,
    // never receipted, never linked — has nothing left that could name it.
    await preFile(secondPath, Buffer.from('a different second candidate'), ctx);

    await expect(
      persistMediaProduction({
        ctx,
        target,
        kind: 'image',
        candidates: [candidate(PNG), candidate(OTHER_PNG)],
        receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
      }),
    ).rejects.toThrow(/MEMORY_HASH_MISMATCH/);

    expect(await liveDoc(firstPath)).toBeNull();
    expect(await docs.getByPath(firstPath, SPACE_ID, { includeDeleted: true })).toBeNull();
  });

  it('puts a deleted path it revived back the way it found it, versions intact', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;
    const firstPath = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 0)}`;
    const secondPath = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 1)}`;

    // The first candidate's path holds exactly its bytes, deleted — an earlier
    // production's asset, and its receipt still names version 1. This one
    // revives it at version 2 and then cannot finish, so what it undoes is its
    // own revival: the document goes back to deleted, and the version the other
    // production points at is still there to restore.
    const revived = await preFile(firstPath, PNG, ctx);
    expect(await docs.softDelete(revived, SPACE_ID)).toBe(true);
    await preFile(secondPath, Buffer.from('a different second candidate'), ctx);

    await expect(
      persistMediaProduction({
        ctx,
        target,
        kind: 'image',
        candidates: [candidate(PNG), candidate(OTHER_PNG)],
        receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
      }),
    ).rejects.toThrow(/MEMORY_HASH_MISMATCH/);

    expect(await liveDoc(firstPath)).toBeNull();
    const held = await docs.getByPath(firstPath, SPACE_ID, { includeDeleted: true });
    expect(held?.id).toBe(revived);
    expect(held?.deletedAt).not.toBeNull();
    // The version the earlier production's receipt pins is what a restore has
    // to be able to hand back.
    expect(await docs.getVersion(revived, 1)).not.toBeNull();
  });

  it('keeps a document an earlier production already filed when a later one rolls back', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;
    const firstPath = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 0)}`;
    const secondPath = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 1)}`;

    await preFile(firstPath, PNG, ctx);
    await preFile(secondPath, Buffer.from('a different second candidate'), ctx);

    await expect(
      persistMediaProduction({
        ctx,
        target,
        kind: 'image',
        candidates: [candidate(PNG), candidate(OTHER_PNG)],
        receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
      }),
    ).rejects.toThrow(/MEMORY_HASH_MISMATCH/);

    // Re-filed at version 2 by this production, so the bytes under it belong to
    // the one that completed — removing them would break its references.
    const held = await liveDoc(firstPath);
    expect(held?.currentVersion).toBe(2);
  });

  it('refuses every writer but the media lane at an asset path, so no render can be pre-empted', async () => {
    const runId = randomUUID();
    const ctx = fakeCtx(runId, randomUUID());
    const requestKey = `aj_${randomUUID()}`;
    const path = `/media/${runId}/take-${deriveMediaAssetId(requestKey, 0)}`;

    await expect(
      saveBytesToMemoryDoc({
        db,
        payloadStore: target.payloadStore,
        log: ctx.log,
        tenantId: ctx.tenantId,
        origin: runOrigin(ctx),
        spaceId: SPACE_ID,
        path,
        tags: [],
        content: { kind: 'binary', bytes: OTHER_PNG },
        contentType: null,
      }),
    ).rejects.toBeInstanceOf(MemoryWriteDeniedError);

    expect(await docs.getByPath(path, SPACE_ID, { includeDeleted: true })).toBeNull();

    const output = await persistMediaProduction({
      ctx,
      target,
      kind: 'image',
      candidates: [candidate(PNG)],
      receipt: receiptFor(requestKey, runId, ctx.logicalExecutionId),
    });
    expect(output.assets[0]?.path).toBe(path);
  });
});
