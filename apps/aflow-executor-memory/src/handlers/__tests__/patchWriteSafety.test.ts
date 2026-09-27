/**
 * `memory.store.patch` is the repository's only incremental write, and both of
 * its safety properties were absent: the hash it checked never reached the
 * write, and a large body was stored at the step's own output address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePatch } from '../memory/handlers/patch.js';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { PayloadRef, TenantId, SessionId, StepExecutionId, OperationId } from '@aflow/schemas';

const TENANT_ID = 'tenant-1' as TenantId;

vi.mock('@aflow/redis', () => ({ publishMemoryDocEmbedJob: vi.fn() }));

const put = vi.fn(async (p: Record<string, unknown>) => ({
  id: 'doc-1',
  path: p['path'],
  version: 2,
}));
const storeContentAddressed = vi.fn(async () => 'payload:body' as PayloadRef);
const store = vi.fn(async () => 'payload:step-output' as PayloadRef);

const doc = (content: string) => ({
  id: 'doc-1',
  path: '/notes/a.json',
  spaceId: 'space-1',
  docType: 'json' as const,
  mimeType: 'application/json',
  inlineContent: content,
  payloadRef: null,
  contentHash: 'hash-of-current',
  tags: [] as string[],
  summary: null,
  indexingMode: 'disabled' as const,
  userId: null,
  agentId: null,
  sessionId: null,
});

function repoWith(content: string) {
  return {
    getByPath: vi.fn(async () => doc(content)),
    getById: vi.fn(async () => doc(content)),
    put,
    withTransaction: async (fn: (r: unknown, l: unknown) => Promise<unknown>) =>
      await fn(
        {
          put,
          listByPaths: vi.fn(async () => []),
          updateDerivedFields: vi.fn(async () => undefined),
          updateDocEmbeddingStatus: vi.fn(async () => undefined),
          getLatestVersion: vi.fn(async () => 1),
          deleteChunksForDoc: vi.fn(async () => undefined),
          insertChunks: vi.fn(async () => undefined),
          resolveEmbeddingModel: vi.fn(async () => ({
            model: 'text-embedding-3-small',
            dimensions: 1536,
          })),
        },
        { replaceLinksForDoc: vi.fn(async () => ({ added: 0, removed: 0, unresolved: 0 })) },
      ),
  } as never;
}

function ctx(): ExecutorContext {
  return {
    tenantId: TENANT_ID,
    runId: 'run-1' as SessionId,
    stepExecutionId: 'step-1' as StepExecutionId,
    attempt: 1,
    operationId: 'memory.store.patch' as OperationId,
    writePayload: vi.fn(async () => 'payload:out' as PayloadRef),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
}

const deps = () =>
  ({
    payloadStore: { store, storeContentAddressed, retrieve: vi.fn() },
    redis: {},
    spaceId: 'space-1',
    linkRepo: {},
  }) as never;

describe('memory.store.patch write safety', () => {
  beforeEach(() => {
    put.mockClear();
    store.mockClear();
    storeContentAddressed.mockClear();
  });

  it('carries expectedHash into the write, not just the pre-check', async () => {
    // Checking on read and writing unconditionally is check-then-act: a writer
    // landing between the two is overwritten with no error anywhere.
    await handlePatch(
      ctx(),
      repoWith('{"n":1}'),
      {
        target: { path: '/notes/a.json' },
        expectedHash: 'hash-of-current',
        patch: { type: 'json_patch', operations: [{ op: 'replace', path: '/n', value: 2 }] },
      } as never,
      deps(),
    );
    expect(put).toHaveBeenCalled();
    expect(put.mock.calls[0]?.[0]).toMatchObject({ expectedHash: 'hash-of-current' });
  });

  it('stores a large body content-addressed, never at the step output address', async () => {
    // `kind: 'output'` at (stepExecutionId, attempt) is where the step's own
    // result is written, and a doc body outliving its run needs retention a
    // step output has not got.
    await handlePatch(
      ctx(),
      repoWith(JSON.stringify({ big: 'x'.repeat(70_000) })),
      {
        target: { path: '/notes/a.json' },
        patch: {
          type: 'json_patch',
          operations: [{ op: 'replace', path: '/big', value: 'y'.repeat(70_000) }],
        },
      } as never,
      deps(),
    );
    expect(store).not.toHaveBeenCalled();
    expect(storeContentAddressed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'body', persist: true }),
    );
  });
});
