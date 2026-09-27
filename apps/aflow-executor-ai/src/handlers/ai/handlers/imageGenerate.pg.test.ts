/**
 * The image lane end to end, against the real memory tables.
 *
 * A mocked storage module can return a shape the output schema rejects and
 * still report success, so the schema and the candidate-addressing check would
 * never run on this lane at all. Here the handler files real bytes and the
 * assertions are made against what it returned and what the database holds.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
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
import {
  AiMediaOutputSchema,
  deriveMediaAssetId,
  type AiImageGenerateInput,
  type AiMediaOutput,
  type TenantId,
} from '@aflow/schemas';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { GenerateImageRequest } from '@aflow/ai-client';
import { handleImageGenerate } from './imageGenerate.js';
import type { HandlerDeps } from './types.js';
import { getAIClientForContext } from '../aiClient.js';

vi.mock('../aiClient.js', () => ({
  getAIClientForContext: vi.fn(),
}));

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
/**
 * This suite's namespace, and inside it a space of this execution's own. The
 * namespace is the handle a later run sweeps an aborted one by; the random tail
 * is what keeps two concurrent runs — two worktrees, a re-run started before
 * the last finished — out of each other's rows.
 */
const SPACE_NAMESPACE = 'd0000000-0000-0000-284c-';
const SPACE_ID = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

const REFERENCE_CAPABLE = 'google-pro-image';
const RENDERED_BASE64 = 'BBBB';

const generateImage = vi.fn();

function stubClient(): void {
  vi.mocked(getAIClientForContext).mockResolvedValue({
    resolveModelId: () => 'gemini-3-pro-image',
    getAdapter: () => Promise.resolve({ generateImage, provider: 'google' }),
    getModel: () => ({
      capabilities: { imageGeneration: true, imageReferences: { character: 5, style: 3 } },
    }),
    modelCatalog: { getModel: () => undefined, calculateCost: () => undefined },
    listModels: () => [
      {
        id: 'gemini-3-pro-image',
        aliases: ['pro-image', REFERENCE_CAPABLE],
        capabilities: { imageReferences: { character: 5, style: 3 } },
      },
    ],
  } as never);
}

interface Capture {
  ctx: ExecutorContext;
  runId: string;
  outputs: unknown[];
}

function fakeCtx(): Capture {
  const runId = randomUUID();
  const stepExecutionId = randomUUID();
  const capture: Capture = { ctx: {} as ExecutorContext, runId, outputs: [] };
  capture.ctx = {
    job: {
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      stepId: 'render',
      stepExecutionId,
      attempt: 1,
    },
    tenantId: TENANT_ID as TenantId,
    spaceId: SPACE_ID,
    runId,
    stepExecutionId,
    logicalExecutionId: `step:${stepExecutionId}`,
    attempt: 1,
    operationId: 'ai.media.image',
    log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    writePayload: (kind: string, data: unknown) => {
      if (kind !== 'error') capture.outputs.push(data);
      return Promise.resolve('inline:ref' as never);
    },
    readPayload: () => Promise.resolve({ data: 'AAAA', mimeType: 'image/png' }),
  } as unknown as ExecutorContext;
  return capture;
}

function input(overrides: Partial<AiImageGenerateInput> = {}): AiImageGenerateInput {
  return { prompt: 'Ada at the workbench', model: REFERENCE_CAPABLE, ...overrides };
}

describeDb('ai.media.image — a render lands in Memory (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as TenantId);
  const docs: MemoryDocRepository = createMemoryDocRepository(db, tenantCtx);

  let schemaReady = false;
  let tenantPresent = false;

  function deps(): HandlerDeps {
    return {
      payloadStore: createMemoryPayloadStore(),
      db,
      handleError: (_ctx, label, error) => {
        const message = error instanceof Error ? error.message : String(error);
        return Promise.resolve({
          status: 'FAILED',
          error: { message: `${label}: ${message}` },
        } as unknown as StepResult);
      },
      validateToolArgs: () => null,
    };
  }

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
    // A run that aborts never reaches its own cleanup, so every run also clears
    // what earlier ones left behind.
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
    generateImage.mockResolvedValue({
      images: [{ data: RENDERED_BASE64, mimeType: 'image/png', revisedPrompt: 'Ada, seated' }],
      model: 'gemini-3-pro-image',
      provider: 'google',
    });
    stubClient();
  });

  it('returns assets addressed by their position, pinned to the documents holding the bytes', async () => {
    const capture = fakeCtx();
    const result = await handleImageGenerate(capture.ctx, input(), deps());
    expect(result.status).toBe('SUCCEEDED');

    // Parsed rather than cast: the returned shape is only worth asserting on if
    // it is the shape the operation contract accepts.
    const output: AiMediaOutput = AiMediaOutputSchema.parse(capture.outputs[0]);
    const asset = output.assets[0];

    expect(output.assets).toHaveLength(1);
    expect(asset?.candidateIndex).toBe(0);
    expect(asset?.assetId).toBe(deriveMediaAssetId(output.receipt.execution.requestKey, 0));
    // The leaf is the request's identity and nothing else — `image/png` reaches
    // the reader as the document's mimeType.
    expect(asset?.path).toBe(`/media/${capture.runId}/take-${asset?.assetId ?? ''}`);
    expect(asset?.mimeType).toBe('image/png');
    expect(asset?.sizeBytes).toBe(Buffer.from(RENDERED_BASE64, 'base64').byteLength);
    expect(asset?.revisedPrompt).toBe('Ada, seated');
    expect(output.receipt.request.prompt).toBe('Ada at the workbench');

    const stored = await docs.getByPath(asset?.path ?? '', SPACE_ID);
    expect(stored?.id).toBe(asset?.docId);
    expect(stored?.currentVersion).toBe(asset?.version);
    expect(stored?.contentHash).toBe(asset?.contentHash);

    const receiptDoc = await docs.getByPath(output.receiptRef.path, SPACE_ID);
    const receiptBody = JSON.parse(receiptDoc?.inlineContent ?? '{}') as {
      assets: Array<{ assetId: string }>;
    };
    expect(receiptBody.assets[0]?.assetId).toBe(asset?.assetId);
  });

  it('hands the adapter the resolved reference payloads in order', async () => {
    const capture = fakeCtx();
    const result = await handleImageGenerate(
      capture.ctx,
      input({
        referenceRefs: [
          { ref: 'inline:ada', role: 'character', label: 'Ada' },
          { ref: 'inline:plate', role: 'style' },
        ],
      }),
      deps(),
    );

    expect(result.status).toBe('SUCCEEDED');
    const request = generateImage.mock.calls[0]?.[0] as GenerateImageRequest;
    expect(request.references).toEqual([
      { data: 'AAAA', mimeType: 'image/png', role: 'character', label: 'Ada' },
      { data: 'AAAA', mimeType: 'image/png', role: 'style' },
    ]);
  });

  it('omits the reference field entirely when none are supplied', async () => {
    const capture = fakeCtx();
    await handleImageGenerate(capture.ctx, input(), deps());
    expect(generateImage.mock.calls[0]?.[0]).not.toHaveProperty('references');
  });

  it('says the render was paid for when its bytes cannot be stored', async () => {
    const capture = fakeCtx();
    expect((await handleImageGenerate(capture.ctx, input(), deps())).status).toBe('SUCCEEDED');

    // The same execution re-dispatched: the request identity — and so the
    // address its asset resolves to — is the one already filed, and the route
    // answers with different bytes. The step has nothing to return, and the
    // render behind it has already been bought.
    generateImage.mockResolvedValue({
      images: [{ data: 'CCCC', mimeType: 'image/png' }],
      model: 'gemini-3-pro-image',
      provider: 'google',
    });

    const result = await handleImageGenerate(capture.ctx, input(), deps());
    expect(result.status).toBe('FAILED');

    const error = (result as { error?: { message?: string; retryable?: boolean } }).error;
    expect(error?.retryable).toBe(false);
    expect(error?.message).toMatch(/paid for/);
    expect(error?.message).toMatch(/buys a second render/);
    // The generic handler would report the storage error as the whole story.
    expect(error?.message).not.toMatch(/^Image generation failed/);
  });
});
