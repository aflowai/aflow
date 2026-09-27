import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { inArray, sql as drizzleSql } from 'drizzle-orm';
import type { TenantId, SessionId, StepExecutionId, OperationId, PayloadRef } from '@aflow/schemas';
import { MemoryGetInputSchema, MemoryPatchInputSchema } from '@aflow/schemas';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { writeMemoryDoc } from '@aflow/memory-store';
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
const SPACE_NAMESPACE = '2840000b-0000-4000-8000-';
const SPACE = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const RUN_ID = randomUUID();

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** A tiny but real PNG — the point is that these bytes are not valid UTF-8 or JSON. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('memory binary doc read — executor lane (real DB)', () => {
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

  async function writeDoc(
    path: string,
    content: { kind: 'text'; text: string } | { kind: 'binary'; bytes: Buffer },
    docType: string,
    mimeType: string,
  ): Promise<{ id: string; payloadRef: string | null }> {
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
    });
    return { id: doc.id, payloadRef: doc.payloadRef };
  }

  function runOp(
    operationId: string,
    rawInput: unknown,
  ): Promise<{
    result: StepResult;
    output: Record<string, unknown>;
  }> {
    const input =
      operationId === 'memory.store.patch'
        ? MemoryPatchInputSchema.parse(rawInput)
        : MemoryGetInputSchema.parse(rawInput);
    let output: Record<string, unknown> = {};
    const stepExecutionId = '00000000-0000-0000-0000-0000000000bf';
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

  function runGet(rawInput: unknown): Promise<{
    result: StepResult;
    output: Record<string, unknown>;
  }> {
    return runOp('memory.store.get', rawInput);
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
        .values([
          { id: SPACE, name: 'Binary Read', slug: `binary-read-${randomUUID().slice(0, 8)}` },
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

  it('returns a binary doc by reference and the referenced bytes round-trip', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const written = await writeDoc(
      '/assets/pixel.png',
      { kind: 'binary', bytes: PNG_BYTES },
      'image',
      'image/png',
    );
    expect(written.payloadRef?.endsWith('.bin')).toBe(true);

    const { result, output } = await runGet({ path: '/assets/pixel.png', view: 'content' });
    expect(result.status).toBe('SUCCEEDED');

    expect(output['binary']).toBe(true);
    expect(output['data']).toBeUndefined();
    expect(output['dataJson']).toBeUndefined();
    expect(output['dataRef']).toBe(written.payloadRef);

    const stat = output['stat'] as Record<string, unknown>;
    expect(stat['mimeType']).toBe('image/png');
    expect(stat['sizeBytes']).toBe(PNG_BYTES.length);

    const bytes = await payloadStore.retrieveBytes(output['dataRef'] as PayloadRef);
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });

  it('does not inline the bytes into the turn', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await writeDoc('/assets/clip.mp4', { kind: 'binary', bytes: PNG_BYTES }, 'video', 'video/mp4');

    const { output } = await runGet({ path: '/assets/clip.mp4', view: 'content' });
    expect(output['binary']).toBe(true);
    expect(output['data']).toBeUndefined();
    expect(output['dataJson']).toBeUndefined();
  });

  it('routes a docType-"binary" doc on the .bin lane, not through the JSON lane', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // What api.http.download and the sandbox workspace flush produce: the bytes
    // pick the lane, and the docType stays the generic 'binary'.
    const written = await writeDoc(
      '/downloads/logo.png',
      { kind: 'binary', bytes: PNG_BYTES },
      'binary',
      'application/octet-stream',
    );
    expect(written.payloadRef?.endsWith('.bin')).toBe(true);

    const { result, output } = await runGet({ path: '/downloads/logo.png', view: 'content' });
    expect(result.status).toBe('SUCCEEDED');
    expect(output['binary']).toBe(true);
    expect(output['data']).toBeUndefined();
    expect(output['dataRef']).toBe(written.payloadRef);
  });

  it('returns a docType-"image" doc that lives on the JSON lane as text', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    // An SVG over the inline threshold: docType says image, the body is text on
    // the .json lane, and the caller wants the markup.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect />'.repeat(9000)}</svg>`;
    const written = await writeDoc(
      '/assets/diagram.svg',
      { kind: 'text', text: svg },
      'image',
      'image/svg+xml',
    );
    expect(written.payloadRef?.endsWith('.json')).toBe(true);

    const { result, output } = await runGet({
      path: '/assets/diagram.svg',
      view: 'content',
      maxBytes: 1_000_000,
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(output['binary']).toBeUndefined();
    expect(output['dataRef']).toBeUndefined();
    expect(output['data']).toBe(svg);
  });

  it('refuses to patch a binary-lane doc instead of dumping the bytes back as text', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const written = await writeDoc(
      '/assets/patchable.png',
      { kind: 'binary', bytes: PNG_BYTES },
      'image',
      'image/png',
    );

    const { result } = await runOp('memory.store.patch', {
      target: { path: '/assets/patchable.png' },
      patch: { type: 'text_patch', lineRange: { startLine: 0, endLine: 1 }, replacement: 'nope' },
    });
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.message).toContain('MEMORY_BINARY_NOT_PATCHABLE');
    expect(result.error.message).toContain('memory.store.put');

    const after = await runGet({ path: '/assets/patchable.png', view: 'content' });
    expect(after.output['dataRef']).toBe(written.payloadRef);
    const bytes = await payloadStore.retrieveBytes(after.output['dataRef'] as PayloadRef);
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });

  it('answers preview and outline views for a binary doc without touching the bytes', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    await writeDoc('/assets/tone.mp3', { kind: 'binary', bytes: PNG_BYTES }, 'audio', 'audio/mpeg');

    const preview = await runGet({ path: '/assets/tone.mp3', view: 'preview' });
    expect(preview.result.status).toBe('SUCCEEDED');
    expect(preview.output['binary']).toBe(true);
    expect(preview.output['content']).toBeUndefined();

    const outline = await runGet({ path: '/assets/tone.mp3', view: 'outline' });
    expect(outline.result.status).toBe('SUCCEEDED');
    expect(outline.output['binary']).toBe(true);
    expect(outline.output['outline']).toBeUndefined();
  });

  it('still returns text bodies inline from both the inline column and the JSON lane', async (ctx: TestContext) => {
    if (!guard(ctx)) return;
    const small = 'a short note';
    await writeDoc('/text/small.md', { kind: 'text', text: small }, 'markdown', 'text/markdown');

    const inline = await runGet({ path: '/text/small.md', view: 'content' });
    expect(inline.result.status).toBe('SUCCEEDED');
    expect(inline.output['data']).toBe(small);
    expect(inline.output['binary']).toBeUndefined();

    const large = 'x'.repeat(70_000);
    await writeDoc('/text/large.md', { kind: 'text', text: large }, 'markdown', 'text/markdown');

    const offloaded = await runGet({ path: '/text/large.md', view: 'content' });
    expect(offloaded.result.status).toBe('SUCCEEDED');
    const data = offloaded.output['data'];
    expect(typeof data).toBe('string');
    expect(String(data).replace(/x/g, '')).toBe('');
    expect(offloaded.output['binary']).toBeUndefined();
  });
});
