import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryHandler } from '../memory/index.js';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { MemoryDocRepository, MemoryDoc, MemoryDocVersion } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';
import {
  toAgentToolError,
  type PayloadRef,
  type TenantId,
  type SessionId,
  type StepExecutionId,
  type OperationId,
} from '@aflow/schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-1' as TenantId;
const RUN_ID = 'run-1' as SessionId;
const STEP_EXEC_ID = 'step-1' as StepExecutionId;
const SPACE_ID = '00000000-0000-0000-0000-0000000000aa';

function makeDoc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  return {
    id: 'doc-1',
    path: '/test/hello.txt',
    docType: 'text',
    mimeType: 'text/plain',
    sizeBytes: 35,
    contentHash: 'abc123',
    inlineContent: 'Hello from the memory v2 test flow!',
    payloadRef: null,
    preview: 'Hello from the memory v2...',
    tags: ['test'],
    summary: null,
    semanticType: null,
    properties: {},
    derivation: null,
    spaceId: SPACE_ID,
    userId: null,
    agentId: null,
    sessionId: null,
    createdByActor: null,
    createdBySessionId: null,
    createdByStepId: null,
    createdByStepExecutionId: null,
    currentVersion: 1,
    embeddingStatus: 'pending',
    indexingMode: 'auto',
    expiresAt: null,
    deletedAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makeVersion(overrides: Partial<MemoryDocVersion> = {}): MemoryDocVersion {
  return {
    id: 'ver-1',
    docId: 'doc-1',
    version: 1,
    inlineContent: 'Hello from the memory v2 test flow!',
    payloadRef: null,
    contentHash: 'abc123',
    sizeBytes: 35,
    createdByActor: null,
    createdBySessionId: null,
    createdByStepExecutionId: null,
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function createMockRepo(overrides: Partial<MemoryDocRepository> = {}): MemoryDocRepository {
  return {
    getById: vi.fn().mockResolvedValue(null),
    getByPath: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    listByPaths: vi.fn().mockResolvedValue([]),
    grep: vi.fn().mockResolvedValue([]),
    put: vi.fn().mockResolvedValue(makeDoc()),
    getVersion: vi.fn().mockResolvedValue(null),
    getLatestVersion: vi.fn().mockResolvedValue(makeVersion()),
    softDelete: vi.fn().mockResolvedValue(true),
    insertChunks: vi.fn().mockResolvedValue(undefined),
    deleteChunksForDoc: vi.fn().mockResolvedValue(undefined),
    searchFts: vi.fn().mockResolvedValue([]),
    searchVector: vi.fn().mockResolvedValue([]),
    getChunksForVersion: vi.fn().mockResolvedValue([]),
    updateChunkEmbedding: vi.fn().mockResolvedValue(undefined),
    updateDocEmbeddingStatus: vi.fn().mockResolvedValue(undefined),
    updateDerivedFields: vi.fn().mockResolvedValue(undefined),
    resolveEmbeddingModel: vi.fn().mockResolvedValue({
      model: 'text-embedding-3-small',
      column: 'embed_1536',
      dims: 1536,
    }),
    getEmbedConfig: vi.fn().mockResolvedValue(null),
    setEmbedConfig: vi.fn().mockResolvedValue({}),
    markDocsStaleForScope: vi.fn().mockResolvedValue([]),
    withTransaction: vi.fn(
      async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) => {
        return fn(mockRepo, mockLinkRepo);
      },
    ),
    ...overrides,
  } as MemoryDocRepository;
}

/** Link repo bound to the same (mocked) transaction as the doc repo. */
const mockLinkRepo = {
  replaceLinksForDoc: vi.fn().mockResolvedValue(undefined),
  getOutgoingLinks: vi.fn().mockResolvedValue([]),
  getBacklinks: vi.fn().mockResolvedValue({ items: [] }),
  countOutgoing: vi.fn().mockResolvedValue({ resolved: 0, ghost: 0 }),
  countBacklinks: vi.fn().mockResolvedValue(0),
  getLinkTargets: vi.fn().mockResolvedValue({ items: [] }),
  getLinkEdges: vi.fn().mockResolvedValue({ items: [] }),
  getNeighborsForExpansion: vi.fn().mockResolvedValue(new Map()),
  withTransaction: vi.fn(async (fn: (repo: unknown) => Promise<unknown>) => fn(mockLinkRepo)),
};

let mockRepo: MemoryDocRepository;

function createMockPayloadStore(): PayloadStore {
  let counter = 0;
  return {
    store: vi.fn(async () => `payload:${String(++counter)}` as PayloadRef),
    retrieve: vi.fn(async () => ({})),
    exists: vi.fn(async () => false),
    buildRef: vi.fn(() => 'payload:ref' as PayloadRef),
  } as unknown as PayloadStore;
}

function createMockRedis(): Redis {
  return {} as Redis;
}

function createMockContext(
  operationId: string,
  input: unknown,
  opts?: { spaceId?: string | undefined },
): ExecutorContext {
  const written: Array<{ kind: string; data: unknown }> = [];
  let payloadCounter = 0;
  const spaceId = opts && 'spaceId' in opts ? opts.spaceId : SPACE_ID;

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
      ...(spaceId !== undefined ? { spaceId } : {}),
    },
    tenantId: TENANT_ID,
    runId: RUN_ID,
    stepExecutionId: STEP_EXEC_ID,
    attempt: 1,
    idempotencyKey: 'idem-1',
    traceId: 'trace-1',
    operationId: operationId as OperationId,
    readPayload: vi.fn(async () => input),
    writePayload: vi.fn(async (kind: string, data: unknown) => {
      written.push({ kind, data });
      return `payload:${String(++payloadCounter)}` as PayloadRef;
    }),
    outputExists: vi.fn(async () => null),
    resolveAndValidateInput: vi.fn(),
    signal: new AbortController().signal,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as ExecutorContext;
}

/** The data passed to the last writePayload('output', …) — the tool's output. */
function writtenOutput(ctx: ExecutorContext): Record<string, unknown> {
  const calls = (ctx.writePayload as ReturnType<typeof vi.fn>).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]?.[0] === 'output') return (calls[i]?.[1] ?? {}) as Record<string, unknown>;
  }
  return {};
}

// Mock the database module
const mockDirRepo = {
  getDir: vi.fn().mockResolvedValue(null),
  mkdir: vi.fn().mockResolvedValue({ id: 'dir-1', path: '/', created: true }),
  ensureParentDirs: vi.fn().mockResolvedValue(undefined),
  listDir: vi.fn().mockResolvedValue([]),
  deleteDir: vi.fn().mockResolvedValue(true),
  withTransaction: vi.fn(async (fn: (repo: unknown) => Promise<unknown>) => fn(mockDirRepo)),
};

vi.mock('@aflow/database', async (importOriginal) => {
  // Keep the real pure helpers (canonicalizePath, …) — only the repo factories
  // are stubbed. Otherwise a real dependency added to the write path (path
  // canonicalization) hits a missing mock export.
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    createTenantContext: vi.fn(() => ({ tenantId: TENANT_ID })),
    createMemoryDocRepository: vi.fn(() => mockRepo),
    createMemoryDirRepository: vi.fn(() => mockDirRepo),
    createMemoryLinkRepository: vi.fn(() => mockLinkRepo),
    createEmbeddingBudgetLimitsLoader: vi.fn(() => () => Promise.resolve({})),
  };
});

// Mock the Redis module — publishMemoryDocEmbedJob should NOT be called
// by commitDerivedIndexes (it only returns data; publish is separate)
const mockPublishEmbedJob = vi.fn();
vi.mock('@aflow/redis', () => ({
  publishMemoryDocEmbedJob: (...args: unknown[]) => mockPublishEmbedJob(...args),
  consumeEmbeddingBudget: vi.fn(() => Promise.resolve({ allowed: true, exceededScope: null })),
  estimateEmbeddingTokens: vi.fn(() => 1),
}));

// ---------------------------------------------------------------------------
// Tests for derived-index commit + embed job (via handlePut)
// ---------------------------------------------------------------------------

describe('MemoryHandler', () => {
  let handler: MemoryHandler;
  let payloadStore: PayloadStore;
  let redis: Redis;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo = createMockRepo();
    payloadStore = createMockPayloadStore();
    redis = createMockRedis();
    handler = new MemoryHandler({} as never, redis, payloadStore);
    mockPublishEmbedJob.mockResolvedValue(undefined);
  });

  describe('derived-index commit + embed job (via memory.store.put)', () => {
    it('returns embed job with correct fields for indexing=auto', async () => {
      const doc = makeDoc({ indexingMode: 'auto', inlineContent: 'Hello world' });
      const version = makeVersion({ id: 'ver-42', docId: doc.id });

      mockRepo = createMockRepo({
        put: vi.fn().mockResolvedValue(doc),
        getLatestVersion: vi.fn().mockResolvedValue(version),
        resolveEmbeddingModel: vi.fn().mockResolvedValue({
          model: 'text-embedding-3-small',
          column: 'embed_1536',
          dims: 1536,
        }),
      });
      // withTransaction must use the updated mockRepo
      (mockRepo.withTransaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) =>
          fn(mockRepo, mockLinkRepo),
      );

      const ctx = createMockContext('memory.store.put', {
        path: '/test/hello.txt',
        docType: 'text',
        content: { inlineText: 'Hello world' },
      });

      const result = await handler.execute(ctx);
      expect(result.status).toBe('SUCCEEDED');

      // publishMemoryDocEmbedJob should have been called with the job
      expect(mockPublishEmbedJob).toHaveBeenCalledTimes(1);
      const embedJob = mockPublishEmbedJob.mock.calls[0]![1];
      expect(embedJob).toMatchObject({
        tenantId: TENANT_ID,
        docId: doc.id,
        docVersionId: version.id,
        embeddingModel: 'text-embedding-3-small',
        path: doc.path,
      });
    });

    it('returns null (no embed job) when indexing is disabled', async () => {
      const doc = makeDoc({ indexingMode: 'disabled' });

      mockRepo = createMockRepo({
        put: vi.fn().mockResolvedValue(doc),
      });
      (mockRepo.withTransaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) =>
          fn(mockRepo, mockLinkRepo),
      );

      const ctx = createMockContext('memory.store.put', {
        path: '/test/hello.txt',
        docType: 'text',
        content: { inlineText: 'Hello world' },
        indexing: 'disabled',
      });

      const result = await handler.execute(ctx);
      expect(result.status).toBe('SUCCEEDED');

      // No embed job should be published
      expect(mockPublishEmbedJob).not.toHaveBeenCalled();
    });

    it('returns null (no embed job) when doc has no content', async () => {
      const doc = makeDoc({
        indexingMode: 'auto',
        inlineContent: null,
        payloadRef: null,
      });

      mockRepo = createMockRepo({
        put: vi.fn().mockResolvedValue(doc),
      });
      (mockRepo.withTransaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) =>
          fn(mockRepo, mockLinkRepo),
      );

      // Content is in the input, so pass it with inline content
      // but mock the doc returned by put to have no content
      const ctx = createMockContext('memory.store.put', {
        path: '/test/empty.txt',
        docType: 'text',
        content: { inlineText: '' },
      });

      const result = await handler.execute(ctx);
      expect(result.status).toBe('SUCCEEDED');
    });

    it('surfaces the derivation report (links + incomingLinkCount on create) in the put output', async () => {
      const doc = makeDoc({
        indexingMode: 'auto',
        docType: 'markdown',
        path: '/notes/note.md',
        currentVersion: 1,
        inlineContent: 'See [[/ghost.md]].',
      });
      const version = makeVersion({ id: 'ver-9', docId: doc.id });

      mockRepo = createMockRepo({
        put: vi.fn().mockResolvedValue(doc),
        getLatestVersion: vi.fn().mockResolvedValue(version),
        resolveEmbeddingModel: vi
          .fn()
          .mockResolvedValue({ model: 'text-embedding-3-small', column: 'embed_1536', dims: 1536 }),
      });
      (mockRepo.withTransaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) =>
          fn(mockRepo, mockLinkRepo),
      );
      mockLinkRepo.getOutgoingLinks.mockResolvedValueOnce([
        { targetPath: '/ghost.md', resolved: false },
      ]);
      mockLinkRepo.countBacklinks.mockResolvedValueOnce(2);

      const ctx = createMockContext('memory.store.put', {
        path: '/notes/note.md',
        docType: 'markdown',
        content: { inlineText: 'See [[/ghost.md]].' },
      });

      const result = await handler.execute(ctx);
      expect(result.status).toBe('SUCCEEDED');
      const output = writtenOutput(ctx);
      expect(output['links']).toEqual({
        resolved: 0,
        ghostCount: 1,
        ghosts: ['/ghost.md'],
        clamped: false,
      });
      expect(output['incomingLinkCount']).toBe(2);
    });

    it('omits the links/properties block for a non-linkable (json) put', async () => {
      const doc = makeDoc({
        indexingMode: 'auto',
        docType: 'json',
        path: '/data/config.json',
        mimeType: 'application/json',
        inlineContent: '{"a":1}',
      });
      mockRepo = createMockRepo({
        put: vi.fn().mockResolvedValue(doc),
        getLatestVersion: vi.fn().mockResolvedValue(makeVersion({ docId: doc.id })),
        resolveEmbeddingModel: vi
          .fn()
          .mockResolvedValue({ model: 'text-embedding-3-small', column: 'embed_1536', dims: 1536 }),
      });
      (mockRepo.withTransaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) =>
          fn(mockRepo, mockLinkRepo),
      );

      const ctx = createMockContext('memory.store.put', {
        path: '/data/config.json',
        docType: 'json',
        content: { inlineJson: { a: 1 } },
      });

      const result = await handler.execute(ctx);
      expect(result.status).toBe('SUCCEEDED');
      const output = writtenOutput(ctx);
      expect(output['links']).toBeUndefined();
      expect(output['properties']).toBeUndefined();
      expect(output['incomingLinkCount']).toBeUndefined();
    });

    it('does NOT call publishMemoryDocEmbedJob inside the write transaction', async () => {
      // The function returns data only — Redis publish happens after the transaction.
      // We verify that within the withTransaction callback, no Redis calls are made.
      const doc = makeDoc({ indexingMode: 'auto', inlineContent: 'Some content' });
      const version = makeVersion();
      let publishCalledDuringTx = false;

      mockRepo = createMockRepo({
        put: vi.fn().mockResolvedValue(doc),
        getLatestVersion: vi.fn().mockResolvedValue(version),
      });

      (mockRepo.withTransaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) => {
          mockPublishEmbedJob.mockClear();
          const result = await fn(mockRepo, mockLinkRepo);
          publishCalledDuringTx = mockPublishEmbedJob.mock.calls.length > 0;
          return result;
        },
      );

      const ctx = createMockContext('memory.store.put', {
        path: '/test/hello.txt',
        docType: 'text',
        content: { inlineText: 'Some content' },
      });

      await handler.execute(ctx);
      expect(publishCalledDuringTx).toBe(false);
    });
  });

  describe('governed eval suite documents', () => {
    it('blocks direct put to eval suite documents', async () => {
      const ctx = createMockContext('memory.store.put', {
        path: '/evals/kaggle-titanic/suite.json',
        docType: 'json',
        content: { inlineJson: { version: 2 } },
      });

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('Direct changes to /evals/kaggle-titanic/suite.json');
      expect(mockRepo.put).not.toHaveBeenCalled();
    });

    it('blocks patch to eval suite documents resolved by path', async () => {
      const ctx = createMockContext('memory.store.patch', {
        target: { path: '/evals/kaggle-titanic/suite.json' },
        patch: { type: 'json_patch', operations: [{ op: 'replace', path: '/version', value: 2 }] },
      });

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('Direct changes to /evals/kaggle-titanic/suite.json');
      expect(mockRepo.getByPath).not.toHaveBeenCalled();
    });

    it('blocks patch to eval suite documents resolved by id', async () => {
      const doc = makeDoc({
        id: '00000000-0000-0000-0000-000000000001',
        path: '/evals/kaggle-titanic/suite.json',
        docType: 'json',
        mimeType: 'application/json',
        inlineContent: '{"version":1}',
      });
      mockRepo = createMockRepo({
        getById: vi.fn().mockResolvedValue(doc),
      });
      (mockRepo.withTransaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (fn: (repo: MemoryDocRepository, linkRepo: unknown) => Promise<unknown>) =>
          fn(mockRepo, mockLinkRepo),
      );

      const ctx = createMockContext('memory.store.patch', {
        target: { id: doc.id },
        patch: { type: 'json_patch', operations: [{ op: 'replace', path: '/version', value: 2 }] },
      });

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('Direct changes to /evals/kaggle-titanic/suite.json');
      expect(mockRepo.put).not.toHaveBeenCalled();
    });

    it('blocks delete of eval suite documents resolved by id', async () => {
      const doc = makeDoc({
        id: '00000000-0000-0000-0000-000000000001',
        path: '/evals/kaggle-titanic/suite.json',
        docType: 'json',
        mimeType: 'application/json',
      });
      mockRepo = createMockRepo({
        getById: vi.fn().mockResolvedValue(doc),
      });

      const ctx = createMockContext('memory.store.delete', {
        target: { id: doc.id },
      });

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('Direct changes to /evals/kaggle-titanic/suite.json');
      expect(mockRepo.softDelete).not.toHaveBeenCalled();
    });
  });

  describe('platform evidence directory', () => {
    it('blocks direct put to /coach/evidence/api-calls/<callId>.json', async () => {
      const ctx = createMockContext('memory.store.put', {
        path: '/coach/evidence/api-calls/11111111-1111-1111-1111-111111111111.json',
        docType: 'json',
        content: {
          inlineJson: {
            callId: '11111111-1111-1111-1111-111111111111',
            sourceId: 'kaggle-rest-api',
            bindingId: 'kaggle-prod',
            endpointOrTool: 'datasets.fetch',
            executedAtMs: 0,
            issuedBy: 'platform:api.http.call',
            runId: 'attacker-fabricated-run',
          },
        },
      });

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('platform-only');
      expect(result.error.message).toContain('sourceEvidenceRef');
      expect(mockRepo.put).not.toHaveBeenCalled();
    });

    it('blocks puts to any sub-path under /coach/evidence/ regardless of file shape', async () => {
      const ctx = createMockContext('memory.store.put', {
        path: '/coach/evidence/anything/somefile.txt',
        docType: 'text',
        content: { inlineText: 'hi' },
      });

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('platform-only');
    });
  });

  describe('not-found classification', () => {
    it('memory.store.get (view:stat) on a missing doc is a clean not_found, not an opaque system error', async () => {
      const ctx = createMockContext('memory.store.get', {
        target: { id: '00000000-0000-0000-0000-0000000000ff' },
        view: 'stat',
      });

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      // Classification must be not_found — NOT internal (which toAgentToolError
      // rewrites to an opaque "operation failed due to a system error").
      expect(result.error.classification).toBe('not_found');
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toContain('MEMORY_NOT_FOUND');
      // The agent-facing mapping the orchestrator applies: a legible not_found
      // the agent can reason about.
      const agentError = toAgentToolError(result.error);
      expect(agentError.error).toBe('not_found');
      expect(agentError.message).not.toBe('operation failed due to a system error');
    });
  });

  describe('fail-closed space gate', () => {
    it('memory.store.put with no space context fails closed with MEMORY_NO_SPACE', async () => {
      const ctx = createMockContext(
        'memory.store.put',
        { path: '/notes/x.txt', docType: 'text', content: { inlineText: 'hi' } },
        { spaceId: undefined },
      );

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('MEMORY_NO_SPACE');
      // Fail-closed: no repository access before the gate.
      expect(mockRepo.put).not.toHaveBeenCalled();
      expect(mockRepo.withTransaction).not.toHaveBeenCalled();
    });

    it('memory.store.get by id with no space context fails closed with MEMORY_NO_SPACE', async () => {
      const ctx = createMockContext(
        'memory.store.get',
        { target: { id: '00000000-0000-0000-0000-0000000000ff' }, view: 'stat' },
        { spaceId: undefined },
      );

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('MEMORY_NO_SPACE');
      expect(mockRepo.getById).not.toHaveBeenCalled();
    });

    it('memory.store.query with no space context fails closed with MEMORY_NO_SPACE', async () => {
      const ctx = createMockContext(
        'memory.store.query',
        { mode: 'list', pathPrefix: '/notes' },
        { spaceId: undefined },
      );

      const result = await handler.execute(ctx);

      expect(result.status).toBe('FAILED');
      expect(result.error.message).toContain('MEMORY_NO_SPACE');
      expect(mockRepo.list).not.toHaveBeenCalled();
    });

    it('memory.store.get on a virtual /run/outputs/ path stays ungated (no space needed)', async () => {
      const stateKey = `aflow:session:${TENANT_ID}:${RUN_ID}:state`;
      const runtimeState = JSON.stringify({
        variables: {
          _tool_outputs: { ref: { kind: 'inline', value: { abc_0: { ref: 'payload:out' } } } },
        },
      });
      const redis = {
        hget: vi.fn(async (key: string, field: string) =>
          key === stateKey && field === 'runtimeState' ? runtimeState : null,
        ),
      } as unknown as Redis;
      const payloadStore = {
        store: vi.fn(async () => 'payload:written' as PayloadRef),
        retrieve: vi.fn(async (ref: string) =>
          ref === 'payload:out' ? { data: 'hello reread' } : {},
        ),
        exists: vi.fn(async () => false),
        buildRef: vi.fn(() => 'payload:ref' as PayloadRef),
      } as unknown as PayloadStore;
      const virtualHandler = new MemoryHandler({} as never, redis, payloadStore);

      const ctx = createMockContext(
        'memory.store.get',
        { target: { path: '/run/outputs/abc_0/data' }, view: 'content' },
        { spaceId: undefined },
      );

      const result = await virtualHandler.execute(ctx);

      expect(result.status).toBe('SUCCEEDED');
      expect(mockRepo.getById).not.toHaveBeenCalled();
      expect(mockRepo.getByPath).not.toHaveBeenCalled();
    });

    it('memory.store.get view="links" on a virtual /run/ path returns an empty link block, not content', async () => {
      const stateKey = `aflow:session:${TENANT_ID}:${RUN_ID}:state`;
      const runtimeState = JSON.stringify({
        variables: {
          _tool_outputs: { ref: { kind: 'inline', value: { abc_0: { ref: 'payload:out' } } } },
        },
      });
      const redis = {
        hget: vi.fn(async (key: string, field: string) =>
          key === stateKey && field === 'runtimeState' ? runtimeState : null,
        ),
      } as unknown as Redis;
      const payloadStore = {
        store: vi.fn(async () => 'payload:written' as PayloadRef),
        retrieve: vi.fn(async (ref: string) =>
          ref === 'payload:out' ? { data: 'raw output body' } : {},
        ),
        exists: vi.fn(async () => false),
        buildRef: vi.fn(() => 'payload:ref' as PayloadRef),
      } as unknown as PayloadStore;
      const virtualHandler = new MemoryHandler({} as never, redis, payloadStore);

      const ctx = createMockContext(
        'memory.store.get',
        { target: { path: '/run/outputs/abc_0/data' }, view: 'links' },
        { spaceId: undefined },
      );

      const result = await virtualHandler.execute(ctx);

      expect(result.status).toBe('SUCCEEDED');
      const output = writtenOutput(ctx);
      expect(output['links']).toEqual({
        outgoing: [],
        backlinks: [],
        outgoingTotal: 0,
        backlinkTotal: 0,
      });
      // The raw output body must NOT be returned for a links view.
      expect(output['data']).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('accepts valid operations', async () => {
      for (const op of [
        'memory.store.query',
        'memory.store.get',
        'memory.store.put',
        'memory.store.patch',
        'memory.store.delete',
        'memory.store.mkdir',
      ]) {
        const ctx = createMockContext(op, {});
        const err = await handler.validate(ctx);
        expect(err).toBeNull();
      }
    });

    it('rejects unknown operations', async () => {
      const ctx = createMockContext('memory.unknown', {});
      const err = await handler.validate(ctx);
      expect(err).not.toBeNull();
      expect(err!.message).toContain('Unknown memory v2 operation');
    });
  });
});

// ---------------------------------------------------------------------------
// memory.run_output.get — run-scoped reread surface (Plan 233)
// ---------------------------------------------------------------------------

describe('memory.run_output.get', () => {
  beforeEach(() => {
    mockRepo = createMockRepo();
  });

  it('validate() accepts the operation', async () => {
    const handler = new MemoryHandler({} as never, createMockRedis(), createMockPayloadStore());
    const ctx = createMockContext('memory.run_output.get', {
      path: '/run/outputs/abc_0/data',
    });
    expect(await handler.validate(ctx)).toBeNull();
  });

  it('rejects a non-run-output path even if it slips past input validation', async () => {
    const handler = new MemoryHandler({} as never, createMockRedis(), createMockPayloadStore());
    const ctx = createMockContext('memory.run_output.get', {
      path: '/notes/secret.md',
      view: 'content',
    });
    const result = (await handler.execute(ctx)) as StepResult & {
      error?: { message?: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error?.message).toMatch(/run\/outputs/);
    // The persistent repo must never be consulted.
    expect(mockRepo.getByPath).not.toHaveBeenCalled();
    expect(mockRepo.getById).not.toHaveBeenCalled();
  });

  it('reads a run output through the virtual-path resolver (reshape {path}→{target:{path}})', async () => {
    // Model the run's tool-output index in hot state + the stored payload.
    const stateKey = `aflow:session:${TENANT_ID}:${RUN_ID}:state`;
    const runtimeState = JSON.stringify({
      variables: {
        _tool_outputs: { ref: { kind: 'inline', value: { abc_0: { ref: 'payload:out' } } } },
      },
    });
    const redis = {
      hget: vi.fn(async (key: string, field: string) =>
        key === stateKey && field === 'runtimeState' ? runtimeState : null,
      ),
    } as unknown as Redis;
    const payloadStore = {
      store: vi.fn(async () => 'payload:written' as PayloadRef),
      retrieve: vi.fn(async (ref: string) =>
        ref === 'payload:out' ? { data: 'hello reread' } : {},
      ),
      exists: vi.fn(async () => false),
      buildRef: vi.fn(() => 'payload:ref' as PayloadRef),
    } as unknown as PayloadStore;

    const handler = new MemoryHandler({} as never, redis, payloadStore);
    const ctx = createMockContext('memory.run_output.get', {
      path: '/run/outputs/abc_0/data',
      view: 'content',
    });
    const result = (await handler.execute(ctx)) as StepResult & {
      output?: { fields?: Record<string, unknown> };
    };

    expect(result.status).toBe('SUCCEEDED');
    // The persistent repo is bypassed entirely — the reshape routed to the
    // virtual-path resolver, which read the run's own output index.
    expect(mockRepo.getByPath).not.toHaveBeenCalled();
    expect(mockRepo.getById).not.toHaveBeenCalled();
    expect(redis.hget).toHaveBeenCalledWith(stateKey, 'runtimeState');
  });
});
