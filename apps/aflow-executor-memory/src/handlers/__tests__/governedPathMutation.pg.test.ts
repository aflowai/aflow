/**
 * What a governed path answers when an agent tries to change it.
 *
 * Governance that only covers writes is not governance: a receipt an agent can
 * rewrite states whatever it likes about a paid render, and bytes it can delete
 * leave every reference to them dangling. Both verbs are exercised against the
 * real handler and the real tables, because the refusal has to happen before
 * the row moves.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  MemoryDeleteInputSchema,
  MemoryPatchInputSchema,
  type OperationId,
  type PayloadRef,
  type SessionId,
  type StepExecutionId,
  type TenantId,
} from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { computeContentHash, writeMemoryDoc } from '@aflow/memory-store';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  createDatabase,
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
  withTenantSchema,
  memoryDocs,
  memoryDirs,
  memoryLinks,
  spaces,
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
const SPACE_NAMESPACE = '2840000d-0000-4000-8000-';
const SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const RUN_ID = randomUUID();

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('governed paths refuse every mutation, not only the write (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const docRepo: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);
  const dirRepo: MemoryDirRepository = createMemoryDirRepository(db, tenantCtx);
  const payloadStore = createMemoryPayloadStore();
  const handler = new MemoryHandler(db as never, {} as Redis, payloadStore);

  let schemaReady = false;
  const mediaDirectory = `/media/${RUN_ID}`;
  const assetPath = `${mediaDirectory}/take-9f2c1a4b5c6d7e8f9a0b1c2d-0`;
  const receiptPath = `${mediaDirectory}/take-9f2c1a4b5c6d7e8f9a0b1c2d.receipt.json`;
  const evidencePath = '/coach/evidence/source-1.json';
  const suitePath = '/evals/skill-1/suite.json';
  const ownPath = '/notes/shot-list.md';
  let receiptId = '';
  let ownId = '';

  /** The lane's own authority — the only writer `/media/**` accepts. */
  async function fileAsMediaLane(
    path: string,
    content: { kind: 'text'; text: string } | { kind: 'binary'; bytes: Buffer },
    docType: string,
    mimeType: string,
  ): Promise<string> {
    const { doc } = await writeMemoryDoc({
      repo: docRepo,
      dirRepo,
      payloadStore,
      log: silentLog,
      tenantId: TENANT_ID as TenantId,
      origin: {
        kind: 'run',
        runId: RUN_ID as SessionId,
        stepExecutionId: randomUUID() as StepExecutionId,
      },
      spaceId: SPACE,
      path,
      content,
      docType,
      mimeType,
      indexing: 'disabled',
      governedWriter: 'generated_media',
    });
    return doc.id;
  }

  /** Platform-only prefixes have no sanctioned writer, so the row is seeded raw. */
  async function seedRow(path: string, text: string, docType: string): Promise<string> {
    const doc = await docRepo.put({
      path,
      docType,
      mimeType: 'application/json',
      inlineContent: text,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
      contentHash: computeContentHash(text),
      preview: null,
      tags: [],
      summary: null,
      indexing: 'disabled',
      scope: { spaceId: SPACE },
    });
    return doc.id;
  }

  function runOp(
    operationId: 'memory.store.delete' | 'memory.store.patch',
    rawInput: unknown,
  ): Promise<StepResult> {
    const input =
      operationId === 'memory.store.patch'
        ? MemoryPatchInputSchema.parse(rawInput)
        : MemoryDeleteInputSchema.parse(rawInput);
    const stepExecutionId = randomUUID();
    const ctx = {
      job: {
        messageVersion: 1,
        tenantId: TENANT_ID,
        runId: RUN_ID,
        stepId: 'step',
        stepExecutionId,
        stepType: 'memory',
        operationId,
        attempt: 1,
        idempotencyKey: 'idem',
        traceId: 'trace',
        inputRef: 'input:ref' as PayloadRef,
        spaceId: SPACE,
      },
      tenantId: TENANT_ID as TenantId,
      runId: RUN_ID as SessionId,
      stepExecutionId: stepExecutionId as StepExecutionId,
      attempt: 1,
      idempotencyKey: 'idem',
      traceId: 'trace',
      operationId: operationId as OperationId,
      readPayload: async () => input,
      writePayload: async () => 'payload:out' as PayloadRef,
      outputExists: async () => null,
      resolveAndValidateInput: async () => input,
      signal: new AbortController().signal,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as ExecutorContext;
    return handler.execute(ctx);
  }

  function refusal(result: StepResult): string {
    return (result as { error?: { message?: string } }).error?.message ?? '';
  }

  /** The space is this execution's alone, so it is the whole handle. */
  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(memoryLinks).where(inArray(memoryLinks.spaceId, [SPACE]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [SPACE]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [SPACE]));
      await tx.delete(spaces).where(inArray(spaces.id, [SPACE]));
    });
  }

  /**
   * What earlier executions of this suite left behind. Only rows old enough
   * that no live execution could still be writing them — an execution running
   * right now in another checkout is not this one's to clean up.
   */
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
        .values([{ id: SPACE, name: 'Governed', slug: `governed-${randomUUID().slice(0, 8)}` }]);
    });

    await fileAsMediaLane(assetPath, { kind: 'binary', bytes: PNG_BYTES }, 'image', 'image/png');
    receiptId = await fileAsMediaLane(
      receiptPath,
      { kind: 'text', text: JSON.stringify({ model: 'gpt-image-1.5' }) },
      'json',
      'application/json',
    );
    await seedRow(evidencePath, JSON.stringify({ source: 'https://example.test' }), 'json');
    await seedRow(suitePath, JSON.stringify({ criteria: [] }), 'json');

    const own = await writeMemoryDoc({
      repo: docRepo,
      dirRepo,
      payloadStore,
      log: silentLog,
      tenantId: TENANT_ID as TenantId,
      origin: {
        kind: 'run',
        runId: RUN_ID as SessionId,
        stepExecutionId: randomUUID() as StepExecutionId,
      },
      spaceId: SPACE,
      path: ownPath,
      content: { kind: 'text', text: 'one\ntwo\nthree' },
      docType: 'markdown',
      mimeType: 'text/markdown',
      indexing: 'disabled',
    });
    ownId = own.doc.id;
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

  it('refuses to delete a rendered asset, and the bytes stay live', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const result = await runOp('memory.store.delete', { target: { path: assetPath } });

    expect(result.status).toBe('FAILED');
    expect(refusal(result)).toContain('ai.media.image');
    expect(await docRepo.getByPath(assetPath, SPACE)).not.toBeNull();
  });

  it('refuses to patch a receipt, and it still states the model that ran', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const result = await runOp('memory.store.patch', {
      target: { path: receiptPath },
      patch: {
        type: 'json_patch',
        operations: [{ op: 'replace', path: '/model', value: 'a model nobody ran' }],
      },
    });

    expect(result.status).toBe('FAILED');
    const held = await docRepo.getByPath(receiptPath, SPACE);
    expect(held?.currentVersion).toBe(1);
    expect(held?.inlineContent).toContain('gpt-image-1.5');
  });

  it('refuses a receipt reached by id, where the request names no path', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const patched = await runOp('memory.store.patch', {
      target: { id: receiptId },
      patch: {
        type: 'json_patch',
        operations: [{ op: 'replace', path: '/model', value: 'a model nobody ran' }],
      },
    });
    const deleted = await runOp('memory.store.delete', { target: { id: receiptId } });

    expect(patched.status).toBe('FAILED');
    expect(deleted.status).toBe('FAILED');
    expect(await docRepo.getByPath(receiptPath, SPACE)).not.toBeNull();
  });

  it('refuses the directory that holds the renders, which would take them all', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const result = await runOp('memory.store.delete', {
      target: { path: '/media' },
      recursive: true,
    });

    expect(result.status).toBe('FAILED');
    expect(refusal(result)).toContain('/media/');
    expect(await docRepo.getByPath(assetPath, SPACE)).not.toBeNull();
  });

  it('refuses platform evidence and a governed eval suite the same way', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const evidence = await runOp('memory.store.delete', { target: { path: evidencePath } });
    const evidencePatch = await runOp('memory.store.patch', {
      target: { path: evidencePath },
      patch: { type: 'json_patch', operations: [{ op: 'add', path: '/source', value: 'mine' }] },
    });
    const suite = await runOp('memory.store.delete', { target: { path: suitePath } });

    expect(evidence.status).toBe('FAILED');
    expect(evidencePatch.status).toBe('FAILED');
    expect(suite.status).toBe('FAILED');
    expect(await docRepo.getByPath(evidencePath, SPACE)).not.toBeNull();
    expect(await docRepo.getByPath(suitePath, SPACE)).not.toBeNull();
  });

  it('leaves a document of the caller’s own patchable and deletable', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const patched = await runOp('memory.store.patch', {
      target: { id: ownId },
      patch: {
        type: 'text_patch',
        lineRange: { startLine: 0, endLine: 1 },
        replacement: 'ONE',
      },
    });
    expect(patched.status).toBe('SUCCEEDED');

    const deleted = await runOp('memory.store.delete', { target: { path: ownPath } });
    expect(deleted.status).toBe('SUCCEEDED');
    expect(await docRepo.getByPath(ownPath, SPACE)).toBeNull();
  });
});
