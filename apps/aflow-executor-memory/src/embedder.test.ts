import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIClient } from '@aflow/ai-client';
import type { MemoryEmbeddingResolver, SpaceEmbedding } from '@aflow/credential-resolver';
import type { MemoryDocEmbedJob, TenantId } from '@aflow/schemas';

const repo = {
  getById: vi.fn(),
  getChunksForVersion: vi.fn(),
  updateDocEmbeddingStatus: vi.fn(),
  settleDocEmbedding: vi.fn(),
  updateChunkEmbedding: vi.fn(),
};
const ack = vi.fn();

vi.mock('@aflow/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/database')>()),
  createMemoryDocRepository: () => repo,
  createEmbeddingBudgetLimitsLoader: () => vi.fn(),
}));
vi.mock('@aflow/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/redis')>()),
  ackMemoryDocEmbedJob: (...args: unknown[]) => ack(...args) as unknown,
}));

const { MemoryDocEmbedder } = await import('./embedder.js');

const HASH = 'a'.repeat(64);
const job: MemoryDocEmbedJob = {
  messageVersion: 1,
  tenantId: 'a0000000-0000-4000-8000-000000000009' as TenantId,
  spaceId: '00000000-0000-4000-8000-000000000001',
  docId: '00000000-0000-4000-8000-000000000002',
  docVersionId: '00000000-0000-4000-8000-000000000003',
  version: 1,
  path: '/notes/a.md',
  contentHash: HASH,
  createdAt: new Date().toISOString(),
};

function embedder(resolved: SpaceEmbedding) {
  const embedding: MemoryEmbeddingResolver = {
    resolve: vi.fn().mockResolvedValue(resolved),
    choices: vi.fn(),
    pin: vi.fn().mockResolvedValue(undefined),
    embeddingModel: vi.fn(),
  };
  return {
    embedding,
    worker: new MemoryDocEmbedder({ redis: {} as never, db: {} as never, embedding }),
  };
}

const gemini = {
  id: 'gemini-embedding-001',
  dimensions: 1536,
  column: 'embedding_1536',
  definition: { contextWindow: 2048 },
} as Extract<SpaceEmbedding, { state: 'ready' }>['model'];

function client(dimensions: number): AIClient {
  return {
    generateEmbedding: vi.fn().mockResolvedValue({
      embeddings: [new Array<number>(dimensions).fill(0.1)],
      dimensions,
    }),
  } as unknown as AIClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.getById.mockResolvedValue({ contentHash: HASH, embeddingStatus: 'pending' });
  repo.settleDocEmbedding.mockResolvedValue(true);
  repo.getChunksForVersion.mockResolvedValue([
    { id: 'c-1', chunkIndex: 0, text: 'hello', skipEmbedding: false },
  ]);
});

describe('a document in a space with no embedding provider', () => {
  it('waits as unconfigured, records no failure, and is acknowledged', async () => {
    const { worker } = embedder({
      state: 'unconfigured',
      model: null,
      pinned: false,
      reason: 'no key',
    });
    await worker.processJob('m-1', job);
    expect(repo.settleDocEmbedding).toHaveBeenCalledWith(job.docId, 'unconfigured');
    expect(repo.updateChunkEmbedding).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
  });
});

describe('a document in a space that can embed', () => {
  it("stores the vector under the space's model and column", async () => {
    const { worker } = embedder({
      state: 'ready',
      model: gemini,
      pinned: true,
      funding: 'space',
      client: client(1536),
    });
    await worker.processJob('m-1', job);
    expect(repo.updateChunkEmbedding).toHaveBeenCalledWith(
      'c-1',
      expect.any(Array),
      'gemini-embedding-001',
      1536,
      'embedding_1536',
    );
    expect(repo.settleDocEmbedding).toHaveBeenLastCalledWith(job.docId, 'indexed', {
      model: 'gemini-embedding-001',
    });
  });

  it('pins a default before embedding, and embeds with the model the space then holds', async () => {
    const generate = client(1536);
    const { worker, embedding } = embedder({
      state: 'ready',
      model: gemini,
      pinned: false,
      funding: 'space',
      client: generate,
    });
    const order: string[] = [];
    vi.mocked(embedding.pin).mockImplementation(() => {
      order.push('pin');
      return Promise.resolve();
    });
    vi.mocked(generate.generateEmbedding).mockImplementation(() => {
      order.push('embed');
      return Promise.resolve({
        embeddings: [new Array<number>(1536).fill(0.1)],
        dimensions: 1536,
      } as never);
    });
    await worker.processJob('m-1', job);
    expect(embedding.pin).toHaveBeenCalledWith(
      { tenantId: job.tenantId, spaceId: job.spaceId },
      'gemini-embedding-001',
    );
    expect(order).toEqual(['pin', 'embed']);
    expect(embedding.resolve).toHaveBeenCalledTimes(2);
  });

  it('skips a document that is no longer pending, spending nothing', async () => {
    repo.getById.mockResolvedValue({ contentHash: HASH, embeddingStatus: 'indexed' });
    const generate = client(1536);
    const { worker } = embedder({
      state: 'ready',
      model: gemini,
      pinned: true,
      funding: 'space',
      client: generate,
    });
    await worker.processJob('m-1', job);
    expect(generate.generateEmbedding).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('marks indexed only while the space still holds the model it embedded with', async () => {
    const { worker } = embedder({
      state: 'ready',
      model: gemini,
      pinned: true,
      funding: 'space',
      client: client(1536),
    });
    await worker.processJob('m-1', job);
    expect(repo.settleDocEmbedding).toHaveBeenCalledWith(job.docId, 'indexed', {
      model: 'gemini-embedding-001',
    });
    expect(repo.updateDocEmbeddingStatus).not.toHaveBeenCalled();
  });

  it('fails with the reason when the provider answers at another size', async () => {
    const { worker } = embedder({
      state: 'ready',
      model: gemini,
      pinned: true,
      funding: 'space',
      client: client(3072),
    });
    await worker.processJob('m-1', job);
    expect(repo.updateChunkEmbedding).not.toHaveBeenCalled();
    expect(repo.settleDocEmbedding).toHaveBeenLastCalledWith(job.docId, 'failed', {
      error: expect.stringMatching(/3072 dimensions where 1536/) as unknown,
    });
  });
});
