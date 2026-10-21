/**
 * Contract: memory.store.get with view 'content' carries `dataJson` for a JSON
 * document wherever its body is stored — the inline column or the payload
 * store — and leaves a text document as text.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemoryDoc } from '@aflow/database';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type {
  MemoryGetInput,
  OperationId,
  PayloadRef,
  SessionId,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import { handleGet } from '../memory/handlers/get.js';

const PATH = '/shepherd/aflowai/aflow/pulls/158/handoff-pin.json';
const PIN = { commentId: 4242, author: 'aflow-pr-agent[bot]' };
const PIN_TEXT = JSON.stringify(PIN);

function ctx(): ExecutorContext {
  return {
    tenantId: 'tenant-1' as TenantId,
    runId: 'run-1' as SessionId,
    stepExecutionId: 'step-1' as StepExecutionId,
    attempt: 1,
    operationId: 'memory.store.get' as OperationId,
    job: { spaceId: 'space-1' },
    writePayload: vi.fn(async () => 'payload:out' as PayloadRef),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

function written(context: ExecutorContext): Record<string, unknown> {
  const calls = (context.writePayload as ReturnType<typeof vi.fn>).mock.calls;
  return (calls.find((call) => call[0] === 'output')?.[1] ?? {}) as Record<string, unknown>;
}

function makeDoc(overrides: Partial<MemoryDoc>): MemoryDoc {
  return {
    id: 'doc-1',
    path: PATH,
    docType: 'json',
    mimeType: 'application/json',
    sizeBytes: PIN_TEXT.length,
    contentHash: 'sha256:x',
    inlineContent: null,
    payloadRef: null,
    preview: null,
    tags: [],
    summary: null,
    semanticType: null,
    properties: {},
    derivation: null,
    spaceId: 'space-1',
    userId: null,
    agentId: null,
    sessionId: null,
    createdByActor: null,
    createdBySessionId: null,
    createdByStepId: null,
    createdByStepExecutionId: null,
    currentVersion: 1,
    embeddingStatus: 'skipped',
    embeddingError: null,
    indexingMode: 'auto',
    expiresAt: null,
    deletedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as MemoryDoc;
}

async function read(
  doc: MemoryDoc,
  stored: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const context = ctx();
  const repo = { getByPath: vi.fn(async () => doc), getById: vi.fn(async () => doc) };
  const deps = {
    spaceId: 'space-1',
    linkRepo: {
      countBacklinks: vi.fn(async () => 0),
      countOutgoing: vi.fn(async () => ({ resolved: 0, ghost: 0 })),
      getBacklinks: vi.fn(async () => ({ items: [] })),
    },
    payloadStore: {
      retrieve: vi.fn(async (ref: string) => stored[ref]),
      exists: vi.fn(async () => true),
      store: vi.fn(async () => 'payload:body' as PayloadRef),
    },
  };
  const result = await handleGet(
    context,
    repo as never,
    { target: { path: PATH }, view: 'content' } as MemoryGetInput,
    deps as never,
  );
  expect(result.status).toBe('SUCCEEDED');
  return written(context);
}

describe('memory.store.get — a JSON document reads as dataJson wherever its body lives', () => {
  it('parses an inline JSON body', async () => {
    const output = await read(makeDoc({ inlineContent: PIN_TEXT }));
    expect(output['data']).toBe(PIN_TEXT);
    expect(output['dataJson']).toEqual(PIN);
  });

  it('parses an inline body declared JSON by its mimeType alone', async () => {
    const output = await read(
      makeDoc({
        docType: 'report',
        mimeType: 'application/json; charset=utf-8',
        inlineContent: PIN_TEXT,
      }),
    );
    expect(output['dataJson']).toEqual(PIN);
  });

  it('carries a payload-backed body stored as an object', async () => {
    const output = await read(makeDoc({ payloadRef: 'payload:pin' }), { 'payload:pin': PIN });
    expect(output['data']).toBe(PIN_TEXT);
    expect(output['dataJson']).toEqual(PIN);
  });

  it('parses a payload-backed body stored as text, as memory.store.put stores a large one', async () => {
    const output = await read(makeDoc({ payloadRef: 'payload:pin' }), { 'payload:pin': PIN_TEXT });
    expect(output['data']).toBe(PIN_TEXT);
    expect(output['dataJson']).toEqual(PIN);
  });

  it('keeps a text document as text even where its body parses', async () => {
    const output = await read(
      makeDoc({ docType: 'markdown', mimeType: 'text/markdown', inlineContent: PIN_TEXT }),
    );
    expect(output['data']).toBe(PIN_TEXT);
    expect(output).not.toHaveProperty('dataJson');
  });

  it('keeps a JSON document whose body does not parse as text', async () => {
    const output = await read(makeDoc({ inlineContent: '{"commentId": 42,' }));
    expect(output['data']).toBe('{"commentId": 42,');
    expect(output).not.toHaveProperty('dataJson');
  });
});
