/**
 * Honest bounded ranges for memory reads (get + run_output.get):
 * line windows cut on complete lines with the ACTUAL range reported, item
 * windows always return valid JSON with the actual count, oversized single
 * units teach a narrower read, and /run/outputs/<id>/data reads carry the
 * API response MIME type.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryHandler } from '../memory/index.js';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import type { PayloadRef, TenantId, SessionId, StepExecutionId, OperationId } from '@aflow/schemas';

const TENANT_ID = 'tenant-1' as TenantId;
const RUN_ID = 'run-1' as SessionId;
const STEP_EXEC_ID = 'step-1' as StepExecutionId;

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    createTenantContext: vi.fn(() => ({ tenantId: TENANT_ID })),
    createMemoryDocRepository: vi.fn(() => ({})),
    createMemoryDirRepository: vi.fn(() => ({})),
    createMemoryLinkRepository: vi.fn(() => ({})),
    createEmbeddingBudgetLimitsLoader: vi.fn(() => () => Promise.resolve({})),
  };
});

vi.mock('@aflow/redis', () => ({
  publishMemoryDocEmbedJob: vi.fn(),
  consumeEmbeddingBudget: vi.fn(() => Promise.resolve({ allowed: true, exceededScope: null })),
  estimateEmbeddingTokens: vi.fn(() => 1),
}));

function createMockContext(operationId: string, input: unknown): ExecutorContext {
  let payloadCounter = 0;
  return {
    job: {
      messageVersion: 1,
      tenantId: TENANT_ID,
      runId: RUN_ID,
      stepId: 'test-step',
      stepExecutionId: STEP_EXEC_ID,
      stepType: 'memory',
      operationId,
      attempt: 1,
      idempotencyKey: 'idem-1',
      traceId: 'trace-1',
      inputRef: 'input:ref' as PayloadRef,
    },
    tenantId: TENANT_ID,
    runId: RUN_ID,
    stepExecutionId: STEP_EXEC_ID,
    attempt: 1,
    idempotencyKey: 'idem-1',
    traceId: 'trace-1',
    operationId: operationId as OperationId,
    readPayload: vi.fn(async () => input),
    writePayload: vi.fn(async () => `payload:${String(++payloadCounter)}` as PayloadRef),
    outputExists: vi.fn(async () => null),
    resolveAndValidateInput: vi.fn(),
    signal: new AbortController().signal,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

function writtenOutput(ctx: ExecutorContext): Record<string, unknown> {
  const calls = (ctx.writePayload as ReturnType<typeof vi.fn>).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.[0] === 'output') return (calls[i]?.[1] ?? {}) as Record<string, unknown>;
  }
  return {};
}

/** A handler whose run has one tool output (toolCallId api_0) with the given payload. */
function makeVirtualHandler(outputPayload: unknown): MemoryHandler {
  const stateKey = `aflow:session:${TENANT_ID}:${RUN_ID}:state`;
  const runtimeState = JSON.stringify({
    variables: {
      _tool_outputs: { ref: { kind: 'inline', value: { api_0: { ref: 'payload:out' } } } },
    },
  });
  const redis = {
    hget: vi.fn(async (key: string, field: string) =>
      key === stateKey && field === 'runtimeState' ? runtimeState : null,
    ),
  } as unknown as Redis;
  const payloadStore = {
    store: vi.fn(async () => 'payload:written' as PayloadRef),
    retrieve: vi.fn(async (ref: string) => (ref === 'payload:out' ? outputPayload : {})),
    exists: vi.fn(async () => false),
    buildRef: vi.fn(() => 'payload:ref' as PayloadRef),
  } as unknown as PayloadStore;
  return new MemoryHandler({} as never, redis, payloadStore);
}

async function runRead(
  handler: MemoryHandler,
  input: Record<string, unknown>,
): Promise<{ result: StepResult; output: Record<string, unknown> }> {
  const ctx = createMockContext('memory.run_output.get', {
    path: '/run/outputs/api_0/data',
    ...input,
  });
  const result = await handler.execute(ctx);
  return { result, output: writtenOutput(ctx) };
}

type LineRangeMeta = {
  kind: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMore: boolean;
};

describe('memory.run_output.get — honest line windows', () => {
  const LINES = Array.from({ length: 400 }, (_, i) => `line-${String(i)}-${'x'.repeat(80)}`);
  const CONTENT = LINES.join('\n');

  let handler: MemoryHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = makeVirtualHandler({ statusCode: 200, data: CONTENT });
  });

  it('cuts an over-budget line window at the last complete line and reports the actual range', async () => {
    const { result, output } = await runRead(handler, {
      lineRange: { startLine: 0, endLine: 400 },
    });
    expect(result.status).toBe('SUCCEEDED');
    const range = output['range'] as LineRangeMeta;
    const data = output['data'] as string;

    expect(range.kind).toBe('lines');
    expect(range.startLine).toBe(0);
    expect(range.endLine).toBeLessThan(400);
    expect(range.totalLines).toBe(400);
    expect(range.hasMore).toBe(true);
    // The data is EXACTLY the reported window — complete lines, no cut tail.
    expect(data).toBe(LINES.slice(0, range.endLine).join('\n'));
    expect(data.length).toBeLessThanOrEqual(15_000);
    // The window is honest, so nothing was hidden — no truncated flag.
    expect(output['truncated']).toBeUndefined();
  });

  it('line continuations cover every line exactly once', async () => {
    const collected: string[] = [];
    let start = 0;
    for (let guard = 0; guard < 20; guard++) {
      const { output } = await runRead(handler, {
        lineRange: { startLine: start, endLine: 400 },
      });
      const range = output['range'] as LineRangeMeta;
      const data = output['data'] as string;
      if (data.length > 0) collected.push(data);
      if (!range.hasMore) break;
      expect(range.endLine).toBeGreaterThan(start);
      start = range.endLine;
    }
    expect(collected.join('\n')).toBe(CONTENT);
  });

  it('a window that fits is returned whole with the requested-clamped end', async () => {
    const { output } = await runRead(handler, { lineRange: { startLine: 390, endLine: 500 } });
    const range = output['range'] as LineRangeMeta;
    expect(range.endLine).toBe(400);
    expect(range.hasMore).toBe(false);
    expect(output['data']).toBe(LINES.slice(390).join('\n'));
  });

  it('a single line larger than the whole budget returns a bounded prefix as a chars window', async () => {
    const bigLine = 'A'.repeat(50_000);
    const content = `short-0\n${bigLine}\nshort-2`;
    const h = makeVirtualHandler({ statusCode: 200, data: content });
    const { result, output } = await runRead(h, { lineRange: { startLine: 1, endLine: 2 } });
    expect(result.status).toBe('SUCCEEDED');
    expect(output['truncated']).toBe(true);
    const range = output['range'] as { kind: string; start: number; end: number; hasMore: boolean };
    expect(range.kind).toBe('chars');
    expect(range.start).toBe('short-0\n'.length);
    expect(range.end).toBe(range.start + 15_000);
    expect(range.hasMore).toBe(true);
    expect(output['data']).toBe(bigLine.slice(0, 15_000));
  });

  it('a byteRange wider than the budget is clamped with the actual end reported', async () => {
    const { output } = await runRead(handler, { byteRange: { start: 100, end: 30_000 } });
    const range = output['range'] as { kind: string; start: number; end: number; hasMore: boolean };
    expect(range.kind).toBe('chars');
    expect(range.start).toBe(100);
    expect(range.end).toBe(100 + 15_000);
    expect(range.hasMore).toBe(true);
    expect(output['data']).toBe(CONTENT.slice(100, 100 + 15_000));
  });

  it('a whole-document read over the budget reports an honest chars window', async () => {
    const { output } = await runRead(handler, { view: 'content' });
    expect(output['truncated']).toBe(true);
    const range = output['range'] as {
      kind: string;
      start: number;
      end: number;
      totalChars: number;
      hasMore: boolean;
    };
    expect(range).toEqual({
      kind: 'chars',
      start: 0,
      end: 15_000,
      totalChars: CONTENT.length,
      hasMore: true,
    });
    expect(output['data']).toBe(CONTENT.slice(0, 15_000));
  });
});

type ItemRangeMeta = {
  kind: string;
  start: number;
  count: number;
  totalItems: number;
  hasMore: boolean;
  jsonPath?: string;
};

describe('memory.run_output.get — honest item windows', () => {
  const ITEMS = Array.from({ length: 200 }, (_, i) => ({ id: i, pad: 'y'.repeat(180) }));

  let handler: MemoryHandler;
  beforeEach(() => {
    vi.clearAllMocks();
    handler = makeVirtualHandler({ statusCode: 200, data: { papers: ITEMS } });
  });

  it('packs complete items: data parses, count matches, next start = start + count', async () => {
    const { result, output } = await runRead(handler, {
      jsonPath: 'papers',
      itemRange: { start: 0, count: 200 },
    });
    expect(result.status).toBe('SUCCEEDED');
    const range = output['range'] as ItemRangeMeta;
    const parsed: unknown = JSON.parse(output['data'] as string);

    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(range.count);
    expect(range.count).toBeGreaterThan(0);
    expect(range.count).toBeLessThan(200);
    expect(range.totalItems).toBe(200);
    expect(range.hasMore).toBe(true);
    expect(parsed).toEqual(ITEMS.slice(0, range.count));
    // A partial window carries no dataJson duplicate.
    expect(output['dataJson']).toBeUndefined();
  });

  it('item continuations cover every item exactly once', async () => {
    const collected: unknown[] = [];
    let start = 0;
    for (let guard = 0; guard < 20; guard++) {
      const { output } = await runRead(handler, {
        jsonPath: 'papers',
        itemRange: { start, count: 200 },
      });
      const range = output['range'] as ItemRangeMeta;
      collected.push(...(JSON.parse(output['data'] as string) as unknown[]));
      if (!range.hasMore) break;
      start = range.start + range.count;
    }
    expect(collected).toEqual(ITEMS);
  });

  it('a window that fits returns dataJson alongside valid data', async () => {
    const { output } = await runRead(handler, {
      jsonPath: 'papers',
      itemRange: { start: 0, count: 10 },
    });
    const range = output['range'] as ItemRangeMeta;
    expect(range.count).toBe(10);
    expect(range.hasMore).toBe(true);
    expect(output['dataJson']).toEqual(ITEMS.slice(0, 10));
  });

  it('a single item larger than the budget fails with MEMORY_ITEM_TOO_LARGE and a jsonPath hint', async () => {
    const h = makeVirtualHandler({
      statusCode: 200,
      data: { papers: [{ huge: 'z'.repeat(30_000) }] },
    });
    const { result } = await runRead(h, {
      jsonPath: 'papers',
      itemRange: { start: 0, count: 1 },
    });
    expect(result.status).toBe('FAILED');
    const message = (result as StepResult & { error?: { message?: string } }).error?.message ?? '';
    expect(message).toContain('MEMORY_ITEM_TOO_LARGE');
    expect(message).toContain('papers[0]');
    expect(message).toContain('jsonPath');
  });
});

describe('memory.run_output.get — subtree window metadata', () => {
  it('an over-budget jsonPath read reports a chars window over the SERIALIZED SUBTREE', async () => {
    const handler = makeVirtualHandler({
      statusCode: 200,
      data: {
        results: { rows: Array.from({ length: 300 }, (_, i) => ({ i, pad: 'p'.repeat(80) })) },
      },
    });
    const { result, output } = await runRead(handler, { jsonPath: 'results' });
    expect(result.status).toBe('SUCCEEDED');
    expect(output['truncated']).toBe(true);
    const range = output['range'] as {
      kind: string;
      start: number;
      end: number;
      totalChars: number;
      hasMore: boolean;
      jsonPath?: string;
    };
    expect(range.kind).toBe('chars');
    expect(range.start).toBe(0);
    expect(range.end).toBe(15_000);
    expect(range.hasMore).toBe(true);
    // The jsonPath marker tells readers these offsets index the serialized
    // subtree, so a byteRange continuation (a document offset) is invalid.
    expect(range.jsonPath).toBe('results');
    expect(range.totalChars).toBeGreaterThan(15_000);
    expect((output['data'] as string).length).toBe(15_000);
  });
});

describe('memory.run_output.get — MIME propagation from api.http.call', () => {
  it('a /data read reports the declared response content type, not octet-stream', async () => {
    const handler = makeVirtualHandler({
      statusCode: 200,
      data: '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
      parsedMeta: { contentType: 'application/atom+xml; charset=UTF-8' },
    });
    const { output } = await runRead(handler, { view: 'content' });
    const stat = output['stat'] as { mimeType: string };
    expect(stat.mimeType).toBe('application/atom+xml');
  });

  it('falls back to octet-stream when the output declares no content type', async () => {
    const handler = makeVirtualHandler({ data: 'plain body' });
    const { output } = await runRead(handler, { view: 'content' });
    const stat = output['stat'] as { mimeType: string };
    expect(stat.mimeType).toBe('application/octet-stream');
  });
});
