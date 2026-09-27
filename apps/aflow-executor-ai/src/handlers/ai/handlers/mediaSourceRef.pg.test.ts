/**
 * One render feeding the next, against the real memory tables.
 *
 * The pin a media step returns is only worth anything if the next step can read
 * it and refuses when it no longer holds. Both halves are properties of what
 * the database contains — a stubbed repository would accept a version it never
 * wrote and a hash it never computed — so this suite drives the handlers over
 * a real database with only the provider route stubbed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  createMemoryDocRepository,
  withTenantSchema,
  type MemoryDocRepository,
  type TenantContext,
} from '@aflow/database';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { runOrigin, saveBytesToMemoryDoc } from '@aflow/memory-store';
import {
  AiImageEditInputSchema,
  AiImageGenerateInputSchema,
  AiVideoFromImageInputSchema,
  type AiMediaOutput,
  type MediaAsset,
  type TenantId,
} from '@aflow/schemas';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { handleImageGenerate } from './imageGenerate.js';
import { handleImageEdit } from './imageEdit.js';
import type { HandlerDeps } from './types.js';
import { getAIClientForContext } from '../aiClient.js';

vi.mock('../aiClient.js', () => ({ getAIClientForContext: vi.fn() }));

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
/**
 * This suite's namespace, and inside it one space of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail is
 * what keeps two concurrent runs — two worktrees, a re-run started before the
 * last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = 'd0000000-0000-0000-284c-';
const SPACE_ID = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

const REFERENCE_CAPABLE = 'google-pro-image';

/** A PNG whose IHDR is real, so the receipt's probed format is real too. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR', 'latin1'),
    header,
    Buffer.from([8, 6, 0, 0, 0]),
  ]);
}

const RENDERED = png(1024, 1024);
const EDITED = png(512, 512);

const generateImage = vi.fn();
const editImage = vi.fn();

function stubRoute(): void {
  vi.mocked(getAIClientForContext).mockResolvedValue({
    resolveModelId: () => 'gemini-3-pro-image',
    getAdapter: () => Promise.resolve({ provider: 'google', generateImage, editImage }),
    getModel: () => ({
      capabilities: { imageGeneration: true, imageReferences: { character: 5, style: 3 } },
    }),
    modelCatalog: { getModel: () => undefined, calculateCost: () => undefined },
    listModels: () => [
      {
        id: 'gemini-3-pro-image',
        aliases: [REFERENCE_CAPABLE],
        capabilities: { imageReferences: { character: 5, style: 3 } },
      },
    ],
  } as never);
}

describeDb('a render feeding the next render (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as TenantId);
  const docs: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);
  const payloadStore = createMemoryPayloadStore();

  let schemaReady = false;
  let tenantPresent = false;

  function makeCtx(runId: string, operationId: string): ExecutorContext {
    const outputs = new Map<string, unknown>();
    const stepExecutionId = randomUUID();
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
      operationId,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      readPayload: (ref: string) => Promise.resolve(outputs.get(ref)),
      writePayload: (_kind: string, data: unknown) => {
        const ref = `inline:${randomUUID()}`;
        outputs.set(ref, data);
        return Promise.resolve(ref);
      },
    } as unknown as ExecutorContext;
  }

  function makeDeps(): HandlerDeps {
    return {
      payloadStore,
      db,
      handleError: (_c: ExecutorContext, _l: string, error: unknown) => {
        throw error;
      },
      validateToolArgs: () => null,
    } as unknown as HandlerDeps;
  }

  async function outputOf(ctx: ExecutorContext, result: StepResult): Promise<AiMediaOutput> {
    if (result.status !== 'SUCCEEDED') {
      throw new Error(`expected a delivered render, got ${JSON.stringify(result)}`);
    }
    return (await ctx.readPayload(result.outputRef)) as AiMediaOutput;
  }

  /** Renders one image through the real lane and returns the pin it hands back. */
  async function render(prompt: string): Promise<MediaAsset> {
    const ctx = makeCtx(randomUUID(), 'ai.media.image');
    generateImage.mockResolvedValue({
      images: [{ data: RENDERED.toString('base64'), mimeType: 'image/png' }],
      model: 'gemini-3-pro-image',
      provider: 'google',
    });
    const result = await handleImageGenerate(ctx, { prompt }, makeDeps());
    const output = await outputOf(ctx, result);
    const asset = output.assets[0];
    if (!asset) throw new Error('a delivered render has at least one asset');
    return asset;
  }

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

  afterAll(async () => {
    try {
      if (schemaReady) await clearOwnRows();
    } finally {
      await handle.close();
    }
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

  beforeEach(() => {
    vi.mocked(getAIClientForContext).mockReset();
    generateImage.mockReset();
    editImage.mockReset();
    editImage.mockResolvedValue({
      images: [{ data: EDITED.toString('base64'), mimeType: 'image/png' }],
      model: 'gemini-3-pro-image',
      provider: 'google',
    });
    stubRoute();
  });

  it('takes the asset a render returns as an edit input, unmodified', () => {
    const asset = {
      path: '/media/run/take-abc-0',
      version: 1,
      contentHash: 'a'.repeat(64),
      assetId: 'abc-0',
      candidateIndex: 0,
      docId: randomUUID(),
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 29,
      providerNative: { status: 'none', reason: 'route_issues_none' },
    };
    expect(
      AiImageEditInputSchema.safeParse({ prompt: 'brighten it', imageRef: asset }).success,
    ).toBe(true);
    expect(
      AiVideoFromImageInputSchema.safeParse({ prompt: 'zoom out', imageRef: asset }).success,
    ).toBe(true);
    expect(
      AiImageGenerateInputSchema.safeParse({
        prompt: 'the same person, from behind',
        referenceRefs: [{ ref: asset, role: 'character' }],
      }).success,
    ).toBe(true);
  });

  it('edits the exact bytes the pin names, and records what it read', async () => {
    const asset = await render('Ada at the workbench');

    const ctx = makeCtx(randomUUID(), 'ai.media.edit_image');
    const result = await handleImageEdit(
      ctx,
      { prompt: 'brighten the background', imageRef: asset, model: REFERENCE_CAPABLE },
      makeDeps(),
    );

    expect(editImage).toHaveBeenCalledTimes(1);
    const sent = editImage.mock.calls[0]?.[0] as { imageData: string; imageMimeType: string };
    expect(Buffer.from(sent.imageData, 'base64')).toEqual(RENDERED);
    expect(sent.imageMimeType).toBe('image/png');

    const output = await outputOf(ctx, result);
    expect(output.receipt.request.boundEntityVersions).toEqual([
      {
        path: asset.path,
        version: asset.version,
        contentHash: asset.contentHash,
        role: 'source',
      },
    ]);

    const note = await docs.getByPath(
      `${output.receiptRef.path.replace(/\.receipt\.json$/, '')}.md`,
      SPACE_ID,
    );
    expect(note?.inlineContent).toContain('## References');
    expect(note?.inlineContent).toContain(`source — [[${asset.path}]] (version 1)`);
  });

  it('conditions a generation on a pinned reference, labelled and role-tagged', async () => {
    const asset = await render('Ada, three-quarter portrait');

    const ctx = makeCtx(randomUUID(), 'ai.media.image');
    generateImage.mockClear();
    generateImage.mockResolvedValue({
      images: [{ data: EDITED.toString('base64'), mimeType: 'image/png' }],
      model: 'gemini-3-pro-image',
      provider: 'google',
    });
    const result = await handleImageGenerate(
      ctx,
      {
        prompt: 'the same person, from behind',
        model: REFERENCE_CAPABLE,
        referenceRefs: [{ ref: asset, role: 'character', label: 'Ada' }],
      },
      makeDeps(),
    );

    const sent = generateImage.mock.calls[0]?.[0] as {
      references: { data: string; mimeType: string; role: string; label?: string }[];
    };
    expect(Buffer.from(sent.references[0]?.data ?? '', 'base64')).toEqual(RENDERED);
    expect(sent.references[0]?.role).toBe('character');

    const output = await outputOf(ctx, result);
    expect(output.receipt.request.boundEntityVersions).toEqual([
      {
        path: asset.path,
        version: asset.version,
        contentHash: asset.contentHash,
        role: 'character',
        label: 'Ada',
      },
    ]);
  });

  it('refuses a version the document does not have, before paying for anything', async () => {
    const asset = await render('Ada at the lathe');

    const ctx = makeCtx(randomUUID(), 'ai.media.edit_image');
    const result = await handleImageEdit(
      ctx,
      {
        prompt: 'brighten the background',
        imageRef: { ...asset, version: asset.version + 1 },
        model: REFERENCE_CAPABLE,
      },
      makeDeps(),
    );

    expect(result.status).toBe('FAILED');
    expect(editImage).not.toHaveBeenCalled();
    const message = result.status === 'FAILED' ? result.error.message : '';
    expect(message).toContain(`has no version ${String(asset.version + 1)}`);
    expect(message).toContain('never falls back to the current version');
  });

  it('refuses a hash that disagrees, naming both', async () => {
    const asset = await render('Ada by the window');
    const wrong = 'f'.repeat(64);

    const ctx = makeCtx(randomUUID(), 'ai.media.edit_image');
    const result = await handleImageEdit(
      ctx,
      {
        prompt: 'brighten the background',
        imageRef: { ...asset, contentHash: wrong },
        model: REFERENCE_CAPABLE,
      },
      makeDeps(),
    );

    expect(result.status).toBe('FAILED');
    expect(editImage).not.toHaveBeenCalled();
    const message = result.status === 'FAILED' ? result.error.message : '';
    expect(message).toContain(asset.contentHash);
    expect(message).toContain(wrong);
  });

  it('reads the pinned version after the path moves on', async () => {
    const asset = await render('Ada, first take');
    const ctx = makeCtx(randomUUID(), 'ai.media.edit_image');

    const successor = await saveBytesToMemoryDoc({
      db,
      payloadStore,
      log: ctx.log,
      tenantId: TENANT_ID as TenantId,
      origin: runOrigin(ctx),
      spaceId: SPACE_ID,
      path: asset.path,
      docType: 'image',
      mimeType: 'image/png',
      indexing: 'disabled',
      tags: ['generated_media', 'image'],
      content: { kind: 'binary', bytes: png(640, 480) },
      contentType: null,
      governedWriter: 'generated_media',
    });
    expect(successor.version).toBe(asset.version + 1);

    await handleImageEdit(
      ctx,
      { prompt: 'brighten the background', imageRef: asset, model: REFERENCE_CAPABLE },
      makeDeps(),
    );

    const sent = editImage.mock.calls[0]?.[0] as { imageData: string };
    expect(Buffer.from(sent.imageData, 'base64')).toEqual(RENDERED);
  });
});
