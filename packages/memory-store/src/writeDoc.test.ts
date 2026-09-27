import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  MemoryDocRepository,
  MemoryDirRepository,
  MemoryDoc,
  MemoryLinkRepository,
} from '@aflow/database';
import {
  contentAddressForJson,
  createMemoryPayloadStore,
  type PayloadStore,
} from '@aflow/payload-store';
import type { PayloadRef, TenantId, SessionId, StepExecutionId } from '@aflow/schemas';
import type { Redis } from 'ioredis';

const mockPublishEmbedJob = vi.fn();
vi.mock('@aflow/redis', () => ({
  publishMemoryDocEmbedJob: (...args: unknown[]) => mockPublishEmbedJob(...args) as unknown,
}));

const { writeMemoryDoc, writeStructuralDoc, MemoryWriteDeniedError, MEMORY_INLINE_THRESHOLD } =
  await import('./writeDoc.js');

const TENANT = 'tenant-1' as TenantId;
const RUN = 'run-1' as SessionId;
const STEP = 'step-1' as StepExecutionId;

function makeDoc(overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  return {
    id: 'doc-1',
    path: '/data/x.txt',
    docType: 'text',
    mimeType: 'text/plain',
    sizeBytes: 5,
    contentHash: 'h',
    inlineContent: 'hello',
    payloadRef: null,
    preview: 'hello',
    tags: [],
    summary: null,
    spaceId: 'space-1',
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
  } as MemoryDoc;
}

interface RepoMocks {
  repo: MemoryDocRepository;
  put: ReturnType<typeof vi.fn>;
  replaceLinksForDoc: ReturnType<typeof vi.fn>;
  getOutgoingLinks: ReturnType<typeof vi.fn>;
  countBacklinks: ReturnType<typeof vi.fn>;
  updateDerivedFields: ReturnType<typeof vi.fn>;
}

function makeRepo(docOverrides: Partial<MemoryDoc> = {}): RepoMocks {
  const put = vi.fn().mockImplementation((params: { path: string }) =>
    Promise.resolve({
      ...makeDoc({ ...docOverrides, path: params.path }),
      created: true,
      revived: false,
    }),
  );
  const replaceLinksForDoc = vi.fn().mockResolvedValue(undefined);
  const getOutgoingLinks = vi.fn().mockResolvedValue([]);
  const countBacklinks = vi.fn().mockResolvedValue(0);
  const updateDerivedFields = vi.fn().mockResolvedValue(undefined);
  const linkRepo = {
    replaceLinksForDoc,
    getOutgoingLinks,
    countBacklinks,
  } as unknown as MemoryLinkRepository;
  const repo = {
    put,
    listByPaths: vi.fn().mockResolvedValue([]),
    getLatestVersion: vi.fn().mockResolvedValue({ id: 'ver-1', version: 1 }),
    deleteChunksForDoc: vi.fn().mockResolvedValue(undefined),
    insertChunks: vi.fn().mockResolvedValue(undefined),
    updateDocEmbeddingStatus: vi.fn().mockResolvedValue(undefined),
    updateDerivedFields,
    resolveEmbeddingModel: vi
      .fn()
      .mockResolvedValue({ model: 'text-embedding-3-small', column: 'embedding_1536', dims: 1536 }),
    withTransaction: vi.fn(
      async (fn: (r: MemoryDocRepository, l: MemoryLinkRepository) => Promise<unknown>) =>
        fn(repo as MemoryDocRepository, linkRepo),
    ),
  } as unknown as MemoryDocRepository;
  return { repo, put, replaceLinksForDoc, getOutgoingLinks, countBacklinks, updateDerivedFields };
}

function makePayloadStore(): PayloadStore & {
  storeContentAddressed: ReturnType<typeof vi.fn>;
  storeBytesContentAddressed: ReturnType<typeof vi.fn>;
} {
  return {
    storeContentAddressed: vi.fn(async () => 'gs://b/x/body.json' as PayloadRef),
    storeBytesContentAddressed: vi.fn(async () => 'gs://b/x/body.bin' as PayloadRef),
    retrieve: vi.fn(async () => ''),
  } as unknown as PayloadStore & {
    storeContentAddressed: ReturnType<typeof vi.fn>;
    storeBytesContentAddressed: ReturnType<typeof vi.fn>;
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function baseParams(repo: MemoryDocRepository, payloadStore: PayloadStore) {
  return {
    repo,
    payloadStore,
    log,
    tenantId: TENANT,
    origin: { kind: 'run' as const, runId: RUN, stepExecutionId: STEP },
    spaceId: 'space-1',
    docType: 'text',
    mimeType: 'text/plain',
  };
}

beforeEach(() => {
  mockPublishEmbedJob.mockReset();
  log.warn.mockReset();
});

describe('writeMemoryDoc — text lane', () => {
  it('inlines small text, stamps scope + server-derived provenance, and chunks for indexing', async () => {
    const { repo, put } = makeRepo();
    const payloadStore = makePayloadStore();
    const result = await writeMemoryDoc({
      ...baseParams(repo, payloadStore),
      origin: { kind: 'run', runId: RUN, stepExecutionId: STEP, stepId: 'flow-step-7' },
      path: '/data/x.txt',
      content: { kind: 'text', text: 'hello' },
    });

    expect(result.inlineContent).toBe('hello');
    expect(result.payloadRef).toBeNull();
    expect(result.sizeBytes).toBe(5);
    expect(result.preview).toBe('hello');
    expect(payloadStore.storeContentAddressed).not.toHaveBeenCalled();

    const putParams = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['inlineContent']).toBe('hello');
    expect(putParams['payloadRef']).toBeNull();
    expect(putParams['scope']).toEqual({ spaceId: 'space-1' });
    // Provenance is derived from the execution context, never caller-supplied.
    expect(putParams['provenance']).toEqual({
      actor: 'executor',
      sessionId: RUN,
      stepExecutionId: STEP,
      stepId: 'flow-step-7',
    });
    expect(putParams['indexing']).toBe('auto');
  });

  it('offloads text above the 64KB threshold to the JSON payload lane (persist: true)', async () => {
    const { repo, put } = makeRepo();
    const payloadStore = makePayloadStore();
    const big = 'a'.repeat(MEMORY_INLINE_THRESHOLD + 1);

    const result = await writeMemoryDoc({
      ...baseParams(repo, payloadStore),
      path: '/data/big.txt',
      content: { kind: 'text', text: big },
    });

    expect(result.inlineContent).toBeNull();
    expect(result.payloadRef).toBe('gs://b/x/body.json');
    expect(result.preview).toBeNull(); // preview only exists for inline content
    // The body is addressed by the digest of the bytes the store writes, which
    // the store verifies; the doc row stays hashed by the raw text, so a doc
    // above the threshold and one below it hash the same content the same way.
    expect(payloadStore.storeContentAddressed).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'body',
        persist: true,
        data: big,
        contentHash: contentAddressForJson(big),
      }),
    );
    expect(result.contentHash).toBe(createHash('sha256').update(big, 'utf8').digest('hex'));
    const putParams = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['inlineContent']).toBeNull();
    expect(putParams['payloadRef']).toBe('gs://b/x/body.json');
  });

  it('claims an address a verifying store accepts, and the body reads back from it', async () => {
    const { repo } = makeRepo();
    const payloadStore = createMemoryPayloadStore();
    const big = 'a'.repeat(MEMORY_INLINE_THRESHOLD + 1);

    const result = await writeMemoryDoc({
      ...baseParams(repo, payloadStore),
      path: '/data/big.txt',
      content: { kind: 'text', text: big },
    });

    expect(result.payloadRef).not.toBeNull();
    expect(await payloadStore.retrieve(result.payloadRef as PayloadRef)).toBe(big);
  });

  it('publishes the embed job when redis is provided', async () => {
    const { repo } = makeRepo();
    const payloadStore = makePayloadStore();
    await writeMemoryDoc({
      ...baseParams(repo, payloadStore),
      redis: {} as Redis,
      path: '/data/x.txt',
      content: { kind: 'text', text: 'hello world, this is indexable text' },
    });
    expect(mockPublishEmbedJob).toHaveBeenCalledTimes(1);
  });
});

describe('writeMemoryDoc — derivation report', () => {
  it('stamps derivation.sourceVersion from the just-put doc currentVersion', async () => {
    const { repo, updateDerivedFields } = makeRepo({ currentVersion: 3 });
    await writeMemoryDoc({
      ...baseParams(repo, makePayloadStore()),
      path: '/notes/note.md',
      docType: 'markdown',
      mimeType: 'text/markdown',
      content: { kind: 'text', text: 'Body.' },
    });
    const stored = updateDerivedFields.mock.calls[0]?.[2] as {
      derivation: { sourceVersion?: number };
    };
    expect(stored.derivation.sourceVersion).toBe(3);
  });

  it('splits outgoing links into resolved vs ghost with a capped ghost sample and total', async () => {
    const { repo, getOutgoingLinks } = makeRepo();
    getOutgoingLinks.mockResolvedValue([
      { targetPath: '/notes/live.md', resolved: true },
      { targetPath: '/ghost.md', resolved: false },
      { targetPath: '/ghost2.md', resolved: false },
    ]);
    const result = await writeMemoryDoc({
      ...baseParams(repo, makePayloadStore()),
      path: '/notes/note.md',
      docType: 'markdown',
      mimeType: 'text/markdown',
      content: { kind: 'text', text: 'See [[/notes/live.md]] [[/ghost.md]] [[/ghost2.md]].' },
    });
    expect(result.derivationReport?.links).toEqual({
      resolved: 1,
      ghostCount: 2,
      ghosts: ['/ghost.md', '/ghost2.md'],
      clamped: false,
    });
  });

  it('reports incomingLinkCount only on create (version 1)', async () => {
    const create = makeRepo({ currentVersion: 1 });
    create.countBacklinks.mockResolvedValue(4);
    const created = await writeMemoryDoc({
      ...baseParams(create.repo, makePayloadStore()),
      path: '/notes/fresh.md',
      docType: 'markdown',
      mimeType: 'text/markdown',
      content: { kind: 'text', text: 'Fresh note.' },
    });
    expect(created.derivationReport?.incomingLinkCount).toBe(4);
    expect(create.countBacklinks).toHaveBeenCalledWith('/notes/fresh.md', 'space-1');

    const update = makeRepo({ currentVersion: 2 });
    update.countBacklinks.mockResolvedValue(9);
    const updated = await writeMemoryDoc({
      ...baseParams(update.repo, makePayloadStore()),
      path: '/notes/existing.md',
      docType: 'markdown',
      mimeType: 'text/markdown',
      content: { kind: 'text', text: 'Existing note.' },
    });
    expect(updated.derivationReport?.incomingLinkCount).toBeUndefined();
    expect(update.countBacklinks).not.toHaveBeenCalled();
  });

  it('surfaces frontmatter properties with a diagnostic total when the doc had frontmatter', async () => {
    const { repo } = makeRepo();
    const body = ['---', 'status: active', 'tags: [x, y]', '---', '', 'Body.'].join('\n');
    const result = await writeMemoryDoc({
      ...baseParams(repo, makePayloadStore()),
      path: '/notes/meta.md',
      docType: 'markdown',
      mimeType: 'text/markdown',
      content: { kind: 'text', text: body },
    });
    expect(result.derivationReport?.properties?.derived).toEqual({
      status: 'active',
      tags: ['x', 'y'],
    });
    expect(result.derivationReport?.properties?.diagnosticCount).toBe(0);
  });

  it('omits the links/properties blocks for a non-linkable put', async () => {
    const { repo } = makeRepo({ docType: 'json' });
    const result = await writeMemoryDoc({
      ...baseParams(repo, makePayloadStore()),
      path: '/data/config.json',
      docType: 'json',
      mimeType: 'application/json',
      content: { kind: 'text', text: '{"a":1}' },
    });
    expect(result.derivationReport?.links).toBeUndefined();
    expect(result.derivationReport?.properties).toBeUndefined();
    expect(result.derivationReport?.incomingLinkCount).toBeUndefined();
  });

  it('the structural lane carries no derivation report at all', async () => {
    const { repo } = makeRepo({ docType: 'json' });
    const result = await writeStructuralDoc({
      ...baseParams(repo, makePayloadStore()),
      path: '/data/config.json',
      docType: 'json',
      mimeType: 'application/json',
      content: { kind: 'text', text: '{"a":1}' },
    });
    expect(result.derivationReport).toBeUndefined();
  });
});

describe('writeMemoryDoc — binary lane', () => {
  it('stores raw bytes via storeBytes, no inline/preview, indexing forced disabled', async () => {
    const { repo, put } = makeRepo({ docType: 'binary', indexingMode: 'disabled' });
    const payloadStore = makePayloadStore();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01]);

    const result = await writeMemoryDoc({
      ...baseParams(repo, payloadStore),
      path: '/data/blob.bin',
      content: { kind: 'binary', bytes },
      docType: 'binary',
      mimeType: 'application/octet-stream',
      indexing: 'auto', // must be overridden to disabled
    });

    expect(result.inlineContent).toBeNull();
    expect(result.payloadRef).toBe('gs://b/x/body.bin');
    expect(result.preview).toBeNull();
    expect(result.sizeBytes).toBe(4);
    expect(payloadStore.storeBytesContentAddressed).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'body',
        persist: true,
        data: bytes,
        contentType: 'application/octet-stream',
        contentHash: createHash('sha256').update(bytes).digest('hex'),
      }),
    );
    expect(payloadStore.storeContentAddressed).not.toHaveBeenCalled();

    const putParams = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['indexing']).toBe('disabled');
    expect(putParams['preview']).toBeNull();
    expect(mockPublishEmbedJob).not.toHaveBeenCalled();
  });

  it('stores derivation.sourceHash as the bytes hash, not sha256 of an empty string', async () => {
    const { repo, put, updateDerivedFields } = makeRepo({
      docType: 'binary',
      indexingMode: 'disabled',
    });
    const payloadStore = makePayloadStore();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01]);
    const emptyHash = createHash('sha256').update('', 'utf8').digest('hex');
    const bytesHash = createHash('sha256').update(bytes).digest('hex');

    await writeMemoryDoc({
      ...baseParams(repo, payloadStore),
      path: '/data/blob.bin',
      content: { kind: 'binary', bytes },
      docType: 'binary',
      mimeType: 'application/octet-stream',
    });

    const putParams = put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putParams['contentHash']).toBe(bytesHash);
    const derived = updateDerivedFields.mock.calls[0]?.[2] as {
      derivation: { sourceHash: string };
    };
    expect(derived.derivation.sourceHash).toBe(bytesHash);
    expect(derived.derivation.sourceHash).not.toBe(emptyHash);
  });
});

describe('writeMemoryDoc — atomicity (no swallow)', () => {
  it('propagates a link-commit failure instead of swallowing it (rejects the write)', async () => {
    const { repo, replaceLinksForDoc } = makeRepo();
    replaceLinksForDoc.mockRejectedValueOnce(new Error('forced link failure'));
    await expect(
      writeMemoryDoc({
        ...baseParams(repo, makePayloadStore()),
        path: '/data/note.md',
        docType: 'markdown',
        mimeType: 'text/markdown',
        content: { kind: 'text', text: 'Body with [[/x.md]].' },
      }),
    ).rejects.toThrow('forced link failure');
  });

  it('propagates a chunk-insert failure instead of swallowing it (rejects the write)', async () => {
    const { repo } = makeRepo();
    (repo.insertChunks as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('forced chunk failure'),
    );
    await expect(
      writeMemoryDoc({
        ...baseParams(repo, makePayloadStore()),
        path: '/data/note.md',
        docType: 'markdown',
        mimeType: 'text/markdown',
        content: { kind: 'text', text: 'Indexable body that produces chunks.' },
      }),
    ).rejects.toThrow('forced chunk failure');
  });
});

describe('writeMemoryDoc — governance guards', () => {
  it('refuses governed eval suite paths', async () => {
    const { repo, put } = makeRepo();
    await expect(
      writeMemoryDoc({
        ...baseParams(repo, makePayloadStore()),
        path: '/evals/my-skill/suite.json',
        content: { kind: 'text', text: '{}' },
      }),
    ).rejects.toBeInstanceOf(MemoryWriteDeniedError);
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses platform evidence paths (forgery guard applies to every writer)', async () => {
    const { repo, put } = makeRepo();
    await expect(
      writeMemoryDoc({
        ...baseParams(repo, makePayloadStore()),
        path: '/coach/evidence/api-calls/fake.json',
        content: { kind: 'text', text: '{"issuedBy":"platform:api.http.call"}' },
      }),
    ).rejects.toBeInstanceOf(MemoryWriteDeniedError);
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses generated-media paths to every writer but the media operations', async () => {
    const { repo, put } = makeRepo();
    await expect(
      writeMemoryDoc({
        ...baseParams(repo, makePayloadStore()),
        path: '/media/run-1/take-abc-0',
        content: { kind: 'binary', bytes: Buffer.from([1, 2, 3]) },
      }),
    ).rejects.toBeInstanceOf(MemoryWriteDeniedError);
    expect(put).not.toHaveBeenCalled();
  });

  it('names the media operations in the refusal, so the caller learns where renders come from', async () => {
    const { repo } = makeRepo();
    await expect(
      writeMemoryDoc({
        ...baseParams(repo, makePayloadStore()),
        path: '/media/anything.png',
        content: { kind: 'text', text: 'x' },
      }),
    ).rejects.toThrow(/ai\.media\.image/);
  });

  it('lets the writer that owns the prefix through', async () => {
    const { repo, put } = makeRepo();
    await writeMemoryDoc({
      ...baseParams(repo, makePayloadStore()),
      path: '/media/run-1/take-abc-0',
      docType: 'image',
      mimeType: 'image/png',
      governedWriter: 'generated_media',
      content: { kind: 'binary', bytes: Buffer.from([1, 2, 3]) },
    });
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe('writeMemoryDoc — parent dirs', () => {
  it('materializes parent directories when a dirRepo is provided', async () => {
    const { repo } = makeRepo();
    const ensureParentDirs = vi.fn().mockResolvedValue(undefined);
    await writeMemoryDoc({
      ...baseParams(repo, makePayloadStore()),
      dirRepo: { ensureParentDirs } as unknown as MemoryDirRepository,
      path: '/data/nested/deep/x.txt',
      content: { kind: 'text', text: 'hello' },
    });
    expect(ensureParentDirs).toHaveBeenCalledWith(
      '/data/nested/deep/x.txt',
      { spaceId: 'space-1' },
      'executor',
    );
  });
});
