/**
 * An over-threshold JSON body is offloaded to the PayloadStore, and the inline
 * `data` becomes a shape summary. The summary carries a `_note` for the agent
 * that names no field it never receives (it never sees `dataRef`).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { ApiCallInputSchema } from '@aflow/schemas';
import { INLINE_BODY_THRESHOLD } from './config.js';
import { OFFLOADED_BODY_NOTE, processResponse } from './response.js';
import type { ResolvedCall } from './types.js';

function makeCtx(): { ctx: ExecutorContext; written: Array<{ kind: string; data: unknown }> } {
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

const RESOLVED = {
  url: 'https://api.example.com/bars',
  method: 'GET',
  headers: {},
  body: undefined,
  egressPolicy: {} as never,
  apiId: 'example',
  endpointId: 'getBars',
} as ResolvedCall;

const INPUT = ApiCallInputSchema.parse({ apiId: 'example', endpointId: 'getBars' });

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function bars(count: number): Array<{ t: number; o: number; c: number; pad: string }> {
  return Array.from({ length: count }, (_, i) => ({ t: i, o: i, c: i, pad: 'x'.repeat(100) }));
}

async function run(value: unknown): Promise<{
  result: Awaited<ReturnType<typeof processResponse>>;
  written: Array<{ kind: string; data: unknown }>;
}> {
  const { ctx, written } = makeCtx();
  const result = await processResponse(ctx, INPUT, jsonResponse(value), 10, RESOLVED.url, RESOLVED);
  return { result, written };
}

describe('processResponse — offloaded JSON body summary', () => {
  it('names no field the agent never receives', () => {
    expect(OFFLOADED_BODY_NOTE).not.toContain('dataRef');
  });

  it('summarizes an offloaded array body with the note, its length, keys and sample', async () => {
    const body = bars(1000);
    expect(JSON.stringify(body).length).toBeGreaterThan(INLINE_BODY_THRESHOLD);
    const { result, written } = await run(body);

    expect(result.truncated).toBe(true);
    expect(result.dataRef).toBe('payload:body:1');
    expect(written).toEqual([{ kind: 'body', data: body }]);
    expect(result.data).toEqual({
      _note: OFFLOADED_BODY_NOTE,
      _type: 'array',
      _length: 1000,
      _keys: ['t', 'o', 'c', 'pad'],
      _sample: body.slice(0, 3),
    });
  });

  it('summarizes an offloaded object body with the note, its keys and a shallow sample', async () => {
    const body = { symbol: 'SPY', count: 1000, bars: bars(1000), meta: { source: 'x' } };
    const { result, written } = await run(body);

    expect(result.truncated).toBe(true);
    expect(result.dataRef).toBe('payload:body:1');
    expect(written[0]!.data).toEqual(body);
    expect(result.data).toEqual({
      _note: OFFLOADED_BODY_NOTE,
      _type: 'object',
      _keys: ['symbol', 'count', 'bars', 'meta'],
      _sample: {
        symbol: 'SPY',
        count: 1000,
        bars: '[Array(1000)]',
        meta: '{Object(1 keys)}',
      },
    });
  });

  it('summarizes an offloaded scalar body with the note and a preview', async () => {
    const body = 'y'.repeat(INLINE_BODY_THRESHOLD + 10);
    const { result } = await run(body);

    expect(result.truncated).toBe(true);
    expect(result.data).toEqual({
      _note: OFFLOADED_BODY_NOTE,
      _type: 'string',
      _preview: 'y'.repeat(200),
    });
  });

  it('keeps an inline body as is, with no note', async () => {
    const body = bars(3);
    const { result, written } = await run(body);

    expect(result.truncated).toBeUndefined();
    expect(result.dataRef).toBeUndefined();
    expect(written).toEqual([]);
    expect(result.data).toEqual(body);
  });
});
