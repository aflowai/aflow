import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import type { TenantId, OperationId, PayloadRef } from '@aflow/schemas';
import { MemoryGetInputSchema } from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { writeMemoryDoc, MEMORY_INLINE_THRESHOLD } from '@aflow/memory-store';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { Redis } from 'ioredis';
import {
  createDatabase,
  createTenantContext,
  withTenantSchema,
  createMemoryDocRepository,
  createMemoryDirRepository,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  spaces,
  type MemoryDoc,
  type MemoryDocRepository,
  type MemoryDirRepository,
} from '@aflow/database';
import { MemoryHandler } from '../memory/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
/**
 * This suite's namespace, and inside it one space of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail is
 * what keeps two concurrent runs — two worktrees, a re-run started before the
 * last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = '2840000e-0000-4000-8000-';
const SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** Above the inline threshold, so the body lands in the payload store. */
function offloadedBody(marker: string, filler: string): string {
  return `${marker}:${filler.repeat(MEMORY_INLINE_THRESHOLD)}`;
}

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('memory body addressing — offloaded bodies (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);
  const dirRepo: MemoryDirRepository = createMemoryDirRepository(db, tenantCtx);
  const payloadStore = createMemoryPayloadStore();
  const redis = {} as Redis;

  const handler = new MemoryHandler(db as never, redis, payloadStore);

  let schemaReady = false;

  /**
   * The write the REST route makes: no run behind it, so every such write in a
   * tenant shares whatever identity the address is derived from.
   */
  async function writeViaApi(path: string, text: string): Promise<MemoryDoc> {
    const { doc } = await writeMemoryDoc({
      repo: docRepo,
      dirRepo,
      payloadStore,
      log: silentLog,
      tenantId: TENANT_ID as TenantId,
      origin: { kind: 'external', actor: 'api' },
      spaceId: SPACE,
      path,
      content: { kind: 'text', text },
      docType: 'text',
      mimeType: 'text/plain',
      indexing: 'disabled',
    });
    return doc;
  }

  function runGet(rawInput: unknown): Promise<{
    result: StepResult;
    output: Record<string, unknown>;
  }> {
    const input = MemoryGetInputSchema.parse(rawInput);
    let output: Record<string, unknown> = {};
    const runId = '00000000-0000-0000-0000-0000000000c1';
    const stepExecutionId = '00000000-0000-0000-0000-0000000000cf';
    const ctx = {
      job: {
        messageVersion: 1,
        tenantId: TENANT_ID,
        runId,
        stepId: 'step',
        stepExecutionId,
        stepType: 'memory',
        operationId: 'memory.store.get',
        attempt: 1,
        idempotencyKey: 'idem',
        traceId: 'trace',
        inputRef: 'input:ref' as PayloadRef,
        spaceId: SPACE,
      },
      tenantId: TENANT_ID as TenantId,
      runId,
      stepExecutionId,
      attempt: 1,
      idempotencyKey: 'idem',
      traceId: 'trace',
      operationId: 'memory.store.get' as OperationId,
      readPayload: async () => input,
      writePayload: async (kind: string, data: unknown) => {
        if (kind === 'output') output = data as Record<string, unknown>;
        return 'payload:out' as PayloadRef;
      },
      outputExists: async () => null,
      resolveAndValidateInput: async () => input,
      signal: new AbortController().signal,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as ExecutorContext;
    return handler.execute(ctx).then((result) => ({ result, output }));
  }

  /** Rows an aborted earlier run left in this namespace, never a live peer's. */
  async function sweepAbandonedRows(): Promise<void> {
    const stale = `${SPACE_NAMESPACE}%`;
    const aged = drizzleSql`created_at < now() - interval '1 hour'`;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(
        drizzleSql`DELETE FROM memory_links WHERE space_id::text LIKE ${stale} AND ${aged}`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_docs WHERE space_id::text LIKE ${stale} AND ${aged}`,
      );
      await tx.execute(
        drizzleSql`DELETE FROM memory_dirs WHERE space_id::text LIKE ${stale} AND ${aged}`,
      );
      await tx.execute(drizzleSql`DELETE FROM spaces WHERE id::text LIKE ${stale} AND ${aged}`);
    });
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE]));
    });
  }

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'memory_links'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await sweepAbandonedRows();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .insert(spaces)
        .values([
          { id: SPACE, name: 'Body Address', slug: `body-addr-${randomUUID().slice(0, 8)}` },
        ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function guard(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  it('keeps two offloaded documents written by the same non-run writer apart', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const alpha = offloadedBody('ALPHA', 'x');
    const beta = offloadedBody('BETA', 'y');

    const docA = await writeViaApi('/addressing/alpha.txt', alpha);
    const docB = await writeViaApi('/addressing/beta.txt', beta);

    expect(docA.inlineContent).toBeNull();
    expect(docB.inlineContent).toBeNull();
    expect(await payloadStore.retrieve(docA.payloadRef as PayloadRef)).toBe(alpha);
    expect(await payloadStore.retrieve(docB.payloadRef as PayloadRef)).toBe(beta);
    expect(docA.payloadRef).not.toBe(docB.payloadRef);

    const readA = await runGet({ path: '/addressing/alpha.txt', view: 'content' });
    const readB = await runGet({ path: '/addressing/beta.txt', view: 'content' });
    expect(readA.result.status).toBe('SUCCEEDED');
    expect(readB.result.status).toBe('SUCCEEDED');
    expect(String(readA.output['data']).startsWith('ALPHA:')).toBe(true);
    expect(String(readA.output['data'])).not.toContain('y');
    expect(String(readB.output['data']).startsWith('BETA:')).toBe(true);
    expect(String(readB.output['data'])).not.toContain('x');
  });

  it('returns the pinned version bytes after an offloaded document is overwritten', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const path = '/addressing/pinned.txt';
    const first = offloadedBody('FIRST', 'p');
    const second = offloadedBody('SECOND', 'q');

    const v1 = await writeViaApi(path, first);
    expect(v1.currentVersion).toBe(1);
    const v2 = await writeViaApi(path, second);
    expect(v2.currentVersion).toBe(2);

    const version1 = await docRepo.getVersion(v1.id, 1);
    expect(await payloadStore.retrieve(version1?.payloadRef as PayloadRef)).toBe(first);
    expect(version1?.payloadRef).not.toBe(v2.payloadRef);

    const pinned = await runGet({ target: { path, version: 1 }, view: 'content' });
    expect(pinned.result.status).toBe('SUCCEEDED');
    const stat = pinned.output['stat'] as Record<string, unknown>;
    expect(stat['version']).toBe(1);
    // The version row's metadata is immutable; the bytes it points at must be
    // the same ones that hash to it.
    expect(stat['contentHash']).toBe(createHash('sha256').update(first, 'utf8').digest('hex'));
    expect(String(pinned.output['data']).startsWith('FIRST:')).toBe(true);
    expect(String(pinned.output['data'])).not.toContain('q');

    const current = await runGet({ path, view: 'content' });
    expect(String(current.output['data']).startsWith('SECOND:')).toBe(true);
  });

  it('records no session for a write that no run produced', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const doc = await writeViaApi('/addressing/provenance.txt', 'a small note');
    expect(doc.createdByActor).toBe('api');
    expect(doc.createdBySessionId).toBeNull();
    expect(doc.createdByStepExecutionId).toBeNull();
  });
});
