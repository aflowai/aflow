/**
 * Endpoint-declared text normalization: a non-JSON response with an effective
 * text transform is normalized BEFORE the inline/reference decision, the raw
 * text is retained under an internal raw_body ref, and declared-transform
 * failures are fail-loud (never a silent raw-XML fallback).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { ApiCallInputSchema } from '@aflow/schemas';
import { processResponse } from './response.js';
import type { ResolvedCall } from './types.js';

function makeCtx(): {
  ctx: ExecutorContext;
  written: Array<{ kind: string; data: unknown }>;
} {
  const written: Array<{ kind: string; data: unknown }> = [];
  const ctx = {
    job: { spaceId: 'space-1' },
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepExecutionId: 'step-1',
    attempt: 0,
    writePayload: vi.fn(async (kind: string, data: unknown) => {
      written.push({ kind, data });
      return `payload:${kind}:${String(written.length)}`;
    }),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
  return { ctx, written };
}

function makeResolved(endpoint?: Record<string, unknown>): ResolvedCall {
  return {
    url: 'https://export.arxiv.org/api/query',
    method: 'GET',
    headers: {},
    body: undefined,
    egressPolicy: {} as never,
    apiId: 'arxiv',
    endpointId: 'searchPapers',
    ...(endpoint !== undefined ? { endpoint: endpoint as never } : {}),
  } as ResolvedCall;
}

const ARXIV_ENDPOINT = {
  endpointId: 'searchPapers',
  name: 'Search papers',
  method: 'GET',
  pathTemplate: '/api/query',
  params: [],
  tags: [],
  responseTransformPresetId: 'arxiv_atom_papers',
};

function atomFeed(entryCount: number, abstractPad = ''): string {
  const entries = Array.from(
    { length: entryCount },
    (_, i) => `  <entry>
    <id>http://arxiv.org/abs/2400.${String(10000 + i)}v1</id>
    <title>Paper ${String(i)}</title>
    <summary>Abstract ${String(i)}. ${abstractPad}</summary>
    <author><name>Author ${String(i)}</name></author>
    <link href="http://arxiv.org/abs/2400.${String(10000 + i)}v1" rel="alternate" type="text/html"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${String(entryCount)}</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">${String(entryCount)}</opensearch:itemsPerPage>
${entries}
</feed>`;
}

function atomResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
  });
}

const INPUT = ApiCallInputSchema.parse({ apiId: 'arxiv', endpointId: 'searchPapers' });

type Normalized = { totalResults?: number; papers: Array<{ arxivId: string; title: string }> };

describe('processResponse — endpoint-declared text transform', () => {
  it('normalizes a sub-64K Atom body inline with JSON contentType + source media type', async () => {
    const { ctx, written } = makeCtx();
    const result = await processResponse(
      ctx,
      INPUT,
      atomResponse(atomFeed(3)),
      10,
      'https://export.arxiv.org/api/query',
      makeResolved(ARXIV_ENDPOINT),
    );

    const data = result.data as Normalized;
    expect(data.totalResults).toBe(3);
    expect(data.papers).toHaveLength(3);
    expect(data.papers[0]!.arxivId).toBe('2400.10000v1');
    expect(result.dataRef).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.parsedMeta).toEqual({
      contentType: 'application/json',
      sourceContentType: 'application/atom+xml',
    });
    // Raw text retained under the internal raw_body kind.
    expect(result.rawBodyRef).toBe('payload:raw_body:1');
    expect(written[0]!.kind).toBe('raw_body');
    expect(written[0]!.data).toContain('<feed');
  });

  it('an over-64K Atom body normalizes BEFORE the inline/reference split — dataRef is normalized data', async () => {
    const { ctx, written } = makeCtx();
    // ~1.5K per entry × 60 entries ≈ 90K of XML; normalized JSON also > 64K.
    const result = await processResponse(
      ctx,
      INPUT,
      atomResponse(atomFeed(60, 'x'.repeat(1200))),
      10,
      'https://export.arxiv.org/api/query',
      makeResolved(ARXIV_ENDPOINT),
    );

    expect(result.truncated).toBe(true);
    expect(result.dataRef).toBeDefined();
    const stored = written.find((w) => w.kind === 'body');
    expect(stored).toBeDefined();
    const storedData = stored!.data as Normalized;
    expect(storedData.papers).toHaveLength(60);
    expect(storedData.papers[59]!.title).toBe('Paper 59');
    // The inline data is a structural summary of the NORMALIZED value, not raw XML.
    expect(JSON.stringify(result.data)).not.toContain('<entry');
    expect(result.parsedMeta?.contentType).toBe('application/json');
    expect(result.rawBodyRef).toBeDefined();
  });

  it('malformed Atom fails loud with API_RESPONSE_TRANSFORM_FAILED — never a raw-XML fallback', async () => {
    const { ctx } = makeCtx();
    await expect(
      processResponse(
        ctx,
        INPUT,
        atomResponse('<feed><entry></feed>'),
        10,
        'https://export.arxiv.org/api/query',
        makeResolved(ARXIV_ENDPOINT),
      ),
    ).rejects.toMatchObject({ aflowError: { code: 'API_RESPONSE_TRANSFORM_FAILED' } });
  });

  it('a non-OK response skips the transform and keeps the raw error body', async () => {
    const { ctx } = makeCtx();
    const result = await processResponse(
      ctx,
      INPUT,
      atomResponse('<html>rate limited</html>', 503),
      10,
      'https://export.arxiv.org/api/query',
      makeResolved(ARXIV_ENDPOINT),
    );
    expect(result.statusCode).toBe(503);
    expect(result.data).toBe('<html>rate limited</html>');
    expect(result.rawBodyRef).toBeUndefined();
    expect(result.parsedMeta?.contentType).toBe('application/atom+xml; charset=UTF-8');
  });

  it('an explicit call-level transformPresetId takes precedence over the endpoint default', async () => {
    const { ctx } = makeCtx();
    const input = ApiCallInputSchema.parse({
      apiId: 'arxiv',
      endpointId: 'searchPapers',
      response: { transformPresetId: 'unwrap_data' },
    });
    // unwrap_data is not a text preset, so the declared text transform must NOT run.
    const result = await processResponse(
      ctx,
      input,
      atomResponse(atomFeed(1)),
      10,
      'https://export.arxiv.org/api/query',
      makeResolved(ARXIV_ENDPOINT),
    );
    expect(typeof result.data).toBe('string');
    expect(result.data as string).toContain('<feed');
    expect(result.rawBodyRef).toBeUndefined();
  });

  it('an explicit text preset works without any endpoint declaration', async () => {
    const { ctx } = makeCtx();
    const input = ApiCallInputSchema.parse({
      apiId: 'arxiv',
      endpointId: 'searchPapers',
      response: { transformPresetId: 'arxiv_atom_papers' },
    });
    const result = await processResponse(
      ctx,
      input,
      atomResponse(atomFeed(2)),
      10,
      'https://export.arxiv.org/api/query',
      makeResolved(),
    );
    expect((result.data as Normalized).papers).toHaveLength(2);
    expect(result.rawBodyRef).toBeDefined();
  });

  it('an endpoint declaring an UNKNOWN preset fails loud — typo/deploy-skew is never a silent raw fallback', async () => {
    const { ctx } = makeCtx();
    const endpoint = { ...ARXIV_ENDPOINT, responseTransformPresetId: 'arxiv_atom_paper' };
    await expect(
      processResponse(
        ctx,
        INPUT,
        atomResponse(atomFeed(1)),
        10,
        'https://export.arxiv.org/api/query',
        makeResolved(endpoint),
      ),
    ).rejects.toMatchObject({
      aflowError: {
        code: 'API_RESPONSE_TRANSFORM_FAILED',
        message: expect.stringContaining('arxiv_atom_paper'),
      },
    });
  });

  it('saveTo with a declared text transform fails loud instead of persisting the raw body', async () => {
    const { ctx } = makeCtx();
    const input = ApiCallInputSchema.parse({
      apiId: 'arxiv',
      endpointId: 'searchPapers',
      response: { saveTo: { path: '/papers/batch1.json' } },
    });
    await expect(
      processResponse(
        ctx,
        input,
        atomResponse(atomFeed(1)),
        10,
        'https://export.arxiv.org/api/query',
        makeResolved(ARXIV_ENDPOINT),
        { db: {} as never, payloadStore: {} as never },
      ),
    ).rejects.toMatchObject({
      aflowError: {
        code: 'API_RESPONSE_TRANSFORM_FAILED',
        message: expect.stringContaining('saveTo'),
      },
    });
  });

  it('a transform failure carries the stored raw-body ref in its error details', async () => {
    const { ctx, written } = makeCtx();
    await expect(
      processResponse(
        ctx,
        INPUT,
        atomResponse('<feed><entry></feed>'),
        10,
        'https://export.arxiv.org/api/query',
        makeResolved(ARXIV_ENDPOINT),
      ),
    ).rejects.toMatchObject({
      aflowError: {
        code: 'API_RESPONSE_TRANSFORM_FAILED',
        details: { rawBodyRef: 'payload:raw_body:1' },
      },
    });
    expect(written[0]!.kind).toBe('raw_body');
  });

  it('a text response without any transform keeps the existing preview/dataRef behavior', async () => {
    const { ctx } = makeCtx();
    const body = 'plain '.repeat(20_000); // 120K > inline threshold
    const result = await processResponse(
      ctx,
      INPUT,
      new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }),
      10,
      'https://export.arxiv.org/api/query',
      makeResolved(),
    );
    expect(result.truncated).toBe(true);
    expect(result.dataRef).toBeDefined();
    expect(result.rawBodyRef).toBeUndefined();
    expect((result.data as string).endsWith('…[truncated]')).toBe(true);
  });
});
