import { describe, it, expect, vi } from 'vitest';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import { ApiCallInputSchema, ApiHttpDownloadInputSchema } from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { TenantId, SessionId, StepExecutionId, EgressPolicy } from '@aflow/schemas';
import { buildDownloadApiCallInput, mapDownloadOutput } from './download.js';
import { processResponse } from './response.js';
import type { ResolvedCall } from './types.js';

const TENANT = 'tenant-1' as TenantId;

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

describe('buildDownloadApiCallInput — synthesis into a forced-saveTo call', () => {
  it('forces response.saveTo from toMemoryPath and threads indexing through', () => {
    const download = ApiHttpDownloadInputSchema.parse({
      apiId: 'kaggle',
      endpointId: 'download_competition_data_file',
      params: { competition: 'c', fileName: 'train.csv' },
      queryParams: { v: '2' },
      headers: { 'X-Trace': 'abc' },
      toMemoryPath: '/workspace/data/train.csv',
      docType: 'dataset',
      mimeType: 'text/csv',
    });

    const call = buildDownloadApiCallInput(download);

    expect(call.apiId).toBe('kaggle');
    expect(call.endpointId).toBe('download_competition_data_file');
    expect(call.params).toEqual({ competition: 'c', fileName: 'train.csv' });
    expect(call.queryParams).toEqual({ v: '2' });
    expect(call.headers).toEqual({ 'X-Trace': 'abc' });
    // The destination is forced; there is no inline surface.
    expect(call.response.saveTo?.path).toBe('/workspace/data/train.csv');
    expect(call.response.saveTo?.docType).toBe('dataset');
    expect(call.response.saveTo?.mimeType).toBe('text/csv');
    expect(call.response.saveTo?.indexing).toBe('disabled'); // schema default for raw data
  });

  it('preserves direct-URL mode (apiId + bindingId + url) so egress resolution is unchanged', () => {
    const download = ApiHttpDownloadInputSchema.parse({
      apiId: 'kaggle',
      bindingId: 'kaggle-default',
      url: 'https://storage.googleapis.com/bucket/train.csv',
      toMemoryPath: '/workspace/data/train.csv',
      indexing: 'auto',
    });
    const call = buildDownloadApiCallInput(download);
    expect(call.apiId).toBe('kaggle');
    expect(call.bindingId).toBe('kaggle-default');
    expect(call.url).toBe('https://storage.googleapis.com/bucket/train.csv');
    expect(call.response.saveTo?.indexing).toBe('auto');
  });
});

describe('mapDownloadOutput — destination-only output', () => {
  it('maps a saved body to { path, sizeBytes, contentType }', () => {
    const out = mapDownloadOutput({
      statusCode: 200,
      headers: {},
      data: undefined,
      durationMs: 5,
      backend: 'http',
      savedTo: '/data/train.csv',
      sizeBytes: 65_000_000,
      parsedMeta: { contentType: 'text/csv' },
    });
    expect(out).toEqual({
      path: '/data/train.csv',
      sizeBytes: 65_000_000,
      contentType: 'text/csv',
    });
  });

  it('fails with API_DOWNLOAD_FAILED when no file was streamed (non-ok response)', () => {
    expect(() =>
      mapDownloadOutput({
        statusCode: 404,
        headers: {},
        data: { error: 'not found' },
        durationMs: 5,
        backend: 'http',
      }),
    ).toThrowError(
      expect.objectContaining({
        aflowError: expect.objectContaining({ code: 'API_DOWNLOAD_FAILED' }),
      }),
    );
  });
});

describe('processResponse — teaching error on the inline over-budget path', () => {
  it('an inline over-budget response names api.http.download + toMemoryPath as the fix', async () => {
    const ctx = makeCtx();
    const big = 'x'.repeat(4096);
    const response = new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } });
    const input = ApiCallInputSchema.parse({
      apiId: 'example',
      endpointId: 'download',
      response: { format: 'text', maxBytes: 1024 },
    });

    await expect(
      processResponse(ctx, input, response, 5, RESOLVED.url, RESOLVED, {}),
    ).rejects.toMatchObject({
      aflowError: {
        code: 'API_RESPONSE_TOO_LARGE',
        message: expect.stringContaining('api.http.download'),
      },
    });
  });

  it('a saveTo download over-budget does NOT get the inline hint (it already streams to memory)', async () => {
    const ctx = makeCtx();
    const big = 'x'.repeat(4096);
    const response = new Response(big, { status: 200, headers: { 'content-type': 'text/csv' } });
    const input = ApiCallInputSchema.parse({
      apiId: 'example',
      endpointId: 'download',
      response: { saveTo: { path: '/workspace/data/train.csv' }, maxBytes: 1024 },
    });

    let thrown: unknown;
    try {
      await processResponse(ctx, input, response, 5, RESOLVED.url, RESOLVED, {
        db: {} as never,
        payloadStore: createMemoryPayloadStore(),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ aflowError: { code: 'API_RESPONSE_TOO_LARGE' } });
    const message = (thrown as { aflowError: { message: string } }).aflowError.message;
    expect(message).not.toContain('api.http.download');
  });
});
