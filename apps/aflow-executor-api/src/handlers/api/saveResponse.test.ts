import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { TenantId, SessionId, StepExecutionId, EgressPolicy } from '@aflow/schemas';
import { ApiCallInputSchema, ApiHttpDownloadInputSchema } from '@aflow/schemas';
import type { ResolvedCall } from './types.js';
import { buildDownloadApiCallInput } from './download.js';

const mockPut = vi.fn();
const mockEnsureParentDirs = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  const linkRepo = {
    replaceLinksForDoc: vi.fn().mockResolvedValue(undefined),
    getOutgoingLinks: vi.fn().mockResolvedValue([]),
    countBacklinks: vi.fn().mockResolvedValue(0),
  };
  const repo = {
    put: mockPut,
    getLatestVersion: vi.fn().mockResolvedValue({ id: 'ver-1', version: 1 }),
    deleteChunksForDoc: vi.fn().mockResolvedValue(undefined),
    insertChunks: vi.fn().mockResolvedValue(undefined),
    updateDocEmbeddingStatus: vi.fn().mockResolvedValue(undefined),
    updateDerivedFields: vi.fn().mockResolvedValue(undefined),
    resolveEmbeddingModel: vi
      .fn()
      .mockResolvedValue({ model: 'text-embedding-3-small', column: 'embedding_1536', dims: 1536 }),
    withTransaction: async (fn: (r: unknown, l: unknown) => Promise<unknown>) => fn(repo, linkRepo),
  };
  return {
    ...actual,
    createTenantContext: () => ({}),
    createMemoryDocRepository: () => repo,
    createMemoryLinkRepository: () => linkRepo,
    createMemoryDirRepository: () => ({ ensureParentDirs: mockEnsureParentDirs }),
  };
});

const { saveResponseBodyToMemory } = await import('./saveResponse.js');
const { processResponse } = await import('./response.js');

const TENANT = 'tenant-1' as TenantId;
const db = {} as never;

function makeCtx(): ExecutorContext {
  return {
    job: { spaceId: 'space-1' },
    tenantId: TENANT,
    runId: 'run-1' as SessionId,
    stepExecutionId: 'step-1' as StepExecutionId,
    attempt: 0,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

function makeDocRow(params: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'doc-1',
    path: params['path'],
    docType: params['docType'],
    mimeType: params['mimeType'],
    sizeBytes: params['sizeBytes'],
    contentHash: params['contentHash'],
    inlineContent: params['inlineContent'],
    payloadRef: params['payloadRef'],
    preview: params['preview'],
    tags: params['tags'],
    summary: null,
    spaceId: 'space-1',
    userId: null,
    agentId: null,
    sessionId: null,
    currentVersion: 1,
    embeddingStatus: 'pending',
    indexingMode: params['indexing'],
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  mockPut.mockReset();
  mockEnsureParentDirs.mockReset();
  mockPut.mockImplementation((params: Record<string, unknown>) =>
    Promise.resolve(makeDocRow(params)),
  );
});

describe('saveResponseBodyToMemory — text lane', () => {
  it('saves UTF-8 bytes as inline text, strips /workspace, defaults mimeType from Content-Type', async () => {
    const ctx = makeCtx();
    const result = await saveResponseBodyToMemory(ctx, {
      db,
      payloadStore: createMemoryPayloadStore(),
      spaceId: 'space-1',
      saveTo: { path: '/workspace/data/project/train.csv' },
      bytes: Buffer.from('PassengerId,Survived\n892,0\n'),
      contentType: 'text/csv; charset=utf-8',
    });

    expect(result.savedTo).toBe('/data/project/train.csv');
    expect(result.sizeBytes).toBe(27);

    const putParams = mockPut.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['path']).toBe('/data/project/train.csv');
    expect(putParams['inlineContent']).toBe('PassengerId,Survived\n892,0\n');
    expect(putParams['payloadRef']).toBeNull();
    expect(putParams['mimeType']).toBe('text/csv'); // params stripped
    expect(putParams['docType']).toBe('dataset'); // derived from text/csv
    expect(putParams['indexing']).toBe('auto');
    expect(putParams['scope']).toEqual({ spaceId: 'space-1' });
    expect(putParams['provenance']).toEqual({
      actor: 'executor',
      sessionId: 'run-1',
      stepExecutionId: 'step-1',
    });
    // Parent dirs materialized like memory.store.put does.
    expect(mockEnsureParentDirs).toHaveBeenCalledWith(
      '/data/project/train.csv',
      { spaceId: 'space-1' },
      'executor',
    );
  });
});

describe('saveResponseBodyToMemory — binary lane', () => {
  it('stores non-UTF-8 bytes via the byte lane: no inline, indexing disabled', async () => {
    const ctx = makeCtx();
    const payloadStore = createMemoryPayloadStore();
    const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]); // zip-ish, non-UTF-8
    const result = await saveResponseBodyToMemory(ctx, {
      db,
      payloadStore,
      spaceId: 'space-1',
      saveTo: { path: '/workspace/data/archive.zip' },
      bytes: raw,
      contentType: 'application/zip',
    });

    expect(result.savedTo).toBe('/data/archive.zip');
    expect(result.sizeBytes).toBe(raw.length);

    const putParams = mockPut.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['inlineContent']).toBeNull();
    expect(typeof putParams['payloadRef']).toBe('string');
    expect((putParams['payloadRef'] as string).endsWith('.bin')).toBe(true);
    expect(putParams['docType']).toBe('binary');
    expect(putParams['mimeType']).toBe('application/zip');
    expect(putParams['indexing']).toBe('disabled');
    expect(putParams['preview']).toBeNull();

    // Round-trip: the stored bytes are exact.
    const stored = await payloadStore.retrieveBytes(putParams['payloadRef'] as never);
    expect(stored.equals(raw)).toBe(true);
  });

  it('a known-binary extension forces the binary lane even for UTF-8 bytes', async () => {
    const ctx = makeCtx();
    await saveResponseBodyToMemory(ctx, {
      db,
      payloadStore: createMemoryPayloadStore(),
      spaceId: 'space-1',
      saveTo: { path: '/workspace/models/weights.pkl' },
      bytes: Buffer.from('looks like text but is a pickle'),
      contentType: null,
    });
    const putParams = mockPut.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['docType']).toBe('binary');
    expect(putParams['mimeType']).toBe('application/octet-stream');
    expect(putParams['indexing']).toBe('disabled');
  });
});

describe('saveResponseBodyToMemory — governance', () => {
  it('refuses /coach/evidence/** (evidence forgery via saveTo)', async () => {
    const ctx = makeCtx();
    await expect(
      saveResponseBodyToMemory(ctx, {
        db,
        payloadStore: createMemoryPayloadStore(),
        spaceId: 'space-1',
        saveTo: { path: '/coach/evidence/api-calls/forged.json' },
        bytes: Buffer.from('{"issuedBy":"platform:api.http.call"}'),
        contentType: 'application/json',
      }),
    ).rejects.toMatchObject({ aflowError: { code: 'VALIDATION_ERROR' } });
    expect(mockPut).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processResponse integration: output shape + size cap BEFORE write
// ---------------------------------------------------------------------------

const EGRESS: EgressPolicy = {
  allowedHosts: ['example.com'],
  allowedMethods: ['GET', 'POST'],
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 10_485_760,
  timeoutMs: 30_000,
  maxRedirects: 5,
  allowCrossHostRedirects: false,
  retryPolicy: {
    maxRetries: 2,
    retryableStatusCodes: [429, 502, 503, 504],
    retryOnlyIdempotent: true,
    backoffBaseMs: 1000,
    backoffMaxMs: 30_000,
  },
};

const RESOLVED: ResolvedCall = {
  url: 'https://example.com/file.csv',
  method: 'GET',
  headers: {},
  body: undefined,
  egressPolicy: EGRESS,
  apiId: 'example',
  endpointId: 'download',
};

function makeInput(
  saveToPath: string,
  maxBytes?: number,
): ReturnType<typeof ApiCallInputSchema.parse> {
  return ApiCallInputSchema.parse({
    apiId: 'example',
    endpointId: 'download',
    response: { saveTo: { path: saveToPath }, ...(maxBytes ? { maxBytes } : {}) },
  });
}

describe('processResponse with response.saveTo', () => {
  it('returns { savedTo, sizeBytes, statusCode, contentType } and NO data / dataRef', async () => {
    const ctx = makeCtx();
    const body = 'a,b\n1,2\n';
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });

    const result = await processResponse(
      ctx,
      makeInput('/workspace/data/out.csv'),
      response,
      12,
      RESOLVED.url,
      RESOLVED,
      { db, payloadStore: createMemoryPayloadStore() },
    );

    expect(result.savedTo).toBe('/data/out.csv');
    expect(result.sizeBytes).toBe(Buffer.byteLength(body));
    expect(result.statusCode).toBe(200);
    expect(result.parsedMeta?.contentType).toBe('text/csv');
    expect(result.data).toBeUndefined();
    expect(result.dataRef).toBeUndefined();
  });

  it('enforces the response size budget BEFORE the Memory write', async () => {
    const ctx = makeCtx();
    const big = 'x'.repeat(4096);
    const response = new Response(big, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });

    await expect(
      processResponse(
        ctx,
        makeInput('/workspace/data/too-big.txt', 1024),
        response,
        12,
        RESOLVED.url,
        RESOLVED,
        { db, payloadStore: createMemoryPayloadStore() },
      ),
    ).rejects.toMatchObject({ aflowError: { code: 'API_RESPONSE_TOO_LARGE' } });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('a saveTo download with maxBytes omitted allows a body above the 10 MB inline default', async () => {
    const ctx = makeCtx();
    const body = 'x'.repeat(11 * 1024 * 1024); // 11 MB — over the inline default, under the saveTo default
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });

    const result = await processResponse(
      ctx,
      makeInput('/workspace/data/big.csv'),
      response,
      5,
      RESOLVED.url,
      RESOLVED,
      { db, payloadStore: createMemoryPayloadStore() },
    );

    expect(result.statusCode).toBe(200);
    expect((result as { savedTo?: string }).savedTo).toBe('/data/big.csv');
    expect(mockPut).toHaveBeenCalledTimes(1);
  });

  it('an inline response with maxBytes omitted still rejects a body above the 10 MB default', async () => {
    const ctx = makeCtx();
    const body = 'x'.repeat(11 * 1024 * 1024);
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    const inlineInput = ApiCallInputSchema.parse({
      apiId: 'example',
      endpointId: 'download',
      response: { format: 'text' },
    });

    await expect(
      processResponse(ctx, inlineInput, response, 5, RESOLVED.url, RESOLVED, {
        db,
        payloadStore: createMemoryPayloadStore(),
      }),
    ).rejects.toMatchObject({ aflowError: { code: 'API_RESPONSE_TOO_LARGE' } });
  });

  it('does NOT save error responses — the error body comes back inline', async () => {
    const ctx = makeCtx();
    const response = new Response('{"error":"not found"}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });

    const result = await processResponse(
      ctx,
      makeInput('/workspace/data/out.csv'),
      response,
      12,
      RESOLVED.url,
      RESOLVED,
      { db, payloadStore: createMemoryPayloadStore() },
    );

    expect(result.savedTo).toBeUndefined();
    expect(result.statusCode).toBe(404);
    expect(result.data).toEqual({ error: 'not found' });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('fails with a misconfiguration error when saveTo deps are missing', async () => {
    const ctx = makeCtx();
    const response = new Response('ok', { status: 200 });
    await expect(
      processResponse(ctx, makeInput('/workspace/x.txt'), response, 1, RESOLVED.url, RESOLVED, {}),
    ).rejects.toMatchObject({ aflowError: { code: 'INTERNAL_ERROR' } });
  });

  it('an api.http.download-synthesized input streams a >10 MB body with indexing:disabled', async () => {
    const ctx = makeCtx();
    const body = 'a,b\n'.repeat(3 * 1024 * 1024); // ~12 MB — over the 10 MB inline default
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });

    const input = buildDownloadApiCallInput(
      ApiHttpDownloadInputSchema.parse({
        apiId: 'example',
        endpointId: 'download',
        toMemoryPath: '/workspace/data/train.csv',
      }),
    );

    const result = await processResponse(ctx, input, response, 7, RESOLVED.url, RESOLVED, {
      db,
      payloadStore: createMemoryPayloadStore(),
    });

    expect((result as { savedTo?: string }).savedTo).toBe('/data/train.csv');
    expect(result.sizeBytes).toBe(Buffer.byteLength(body));
    const putParams = mockPut.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['indexing']).toBe('disabled'); // raw data reaches the Memory write un-embedded
  });
});
