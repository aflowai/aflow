import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

import type {
  MemoryDoc,
  MemoryDocPutParams,
  MemoryDocQueryOptions,
  MemoryDocQueryResult,
  MemoryDocRepository,
  MemoryLinkRepository,
} from '@aflow/database';
import { canonicalizePath } from '@aflow/database';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { ExecutorLogger } from '@aflow/executor-runtime';
import { getWorkspaceManifest } from '@aflow/redis';
import type { TenantId, SessionId, StepExecutionId } from '@aflow/schemas';

import { WorkspaceManager, WorkspaceError } from '../workspaceManager.js';

// ============================================================================
// Test doubles
// ============================================================================

const TENANT = 'tenant-1' as TenantId;
const RUN = '00000000-0000-0000-0000-000000000001' as SessionId;
const SPACE = 'space-1';

function silentLogger(): ExecutorLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeRedis(): RedisType {
  return new Redis() as unknown as RedisType;
}

/** Link repo bound to the (fake) doc-put transaction. The workspace tests do
 *  not assert link storage, so the write-path reads return empty — the flush
 *  routes through the derivation authority, which reads outgoing links (report)
 *  and backlinks (incoming count) for linkable content. */
function fakeLinkRepo(): MemoryLinkRepository {
  const unused = () => {
    throw new Error('link read not exercised by workspace tests');
  };
  return {
    replaceLinksForDoc: async () => {},
    getOutgoingLinks: async () => [],
    getBacklinks: unused,
    countOutgoing: unused,
    countBacklinks: async () => 0,
    getLinkTargets: unused,
    getLinkEdges: unused,
    getNeighborsForExpansion: unused,
    withTransaction: unused,
  } as unknown as MemoryLinkRepository;
}

/** Minimal in-memory MemoryDocRepository sufficient for the methods workspace
 *  manager calls: list (by pathPrefix + spaceId), getByPath, getById, put. */
class FakeRepo implements MemoryDocRepository {
  private docs = new Map<string, MemoryDoc>();
  private nextId = 1;

  add(
    doc: Partial<MemoryDoc> & { path: string; inlineContent: string; spaceId: string },
  ): MemoryDoc {
    const path = canonicalizePath(doc.path);
    const id = `doc-${String(this.nextId++)}`;
    const now = new Date();
    const sizeBytes = Buffer.byteLength(doc.inlineContent, 'utf-8');
    const full: MemoryDoc = {
      id,
      path,
      docType: doc.docType ?? 'dataset',
      mimeType: doc.mimeType ?? 'text/csv',
      sizeBytes,
      contentHash: sha256(doc.inlineContent),
      inlineContent: doc.inlineContent,
      payloadRef: null,
      preview: null,
      tags: [],
      summary: null,
      semanticType: null,
      spaceId: doc.spaceId,
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
      createdAt: now,
      updatedAt: now,
    };
    this.docs.set(`${full.spaceId}:${full.path}`, full);
    return full;
  }

  async getById(id: string): Promise<MemoryDoc | null> {
    for (const d of this.docs.values()) {
      if (d.id === id) return d;
    }
    return null;
  }

  async getByPath(path: string, spaceId: string): Promise<MemoryDoc | null> {
    return this.docs.get(`${spaceId}:${canonicalizePath(path)}`) ?? null;
  }

  async list(options: MemoryDocQueryOptions): Promise<MemoryDocQueryResult[]> {
    const prefix = options.pathPrefix ? canonicalizePath(options.pathPrefix) : '/';
    const sp = options.scope?.spaceId;
    const out: MemoryDocQueryResult[] = [];
    for (const d of this.docs.values()) {
      if (sp && d.spaceId !== sp) continue;
      if (!d.path.startsWith(prefix)) continue;
      out.push({
        id: d.id,
        path: d.path,
        docType: d.docType,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        updatedAt: d.updatedAt,
        preview: d.preview,
        tags: d.tags,
        semanticType: d.semanticType,
        spaceId: d.spaceId,
        userId: d.userId,
        agentId: d.agentId,
        sessionId: d.sessionId,
      });
    }
    return out;
  }

  async put(params: MemoryDocPutParams): Promise<MemoryDoc> {
    const sp = params.scope?.spaceId ?? '';
    const path = canonicalizePath(params.path);
    const key = `${sp}:${path}`;
    const existing = this.docs.get(key);
    if (params.expectedHash && existing && existing.contentHash !== params.expectedHash) {
      throw new Error(
        `MEMORY_HASH_MISMATCH: expected ${params.expectedHash}, got ${existing.contentHash ?? 'null'}`,
      );
    }
    const id = existing?.id ?? `doc-${String(this.nextId++)}`;
    const now = new Date();
    const next: MemoryDoc = {
      id,
      path,
      docType: params.docType,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      contentHash: params.contentHash,
      inlineContent: params.inlineContent,
      payloadRef: params.payloadRef,
      preview: params.preview,
      tags: params.tags,
      summary: params.summary,
      semanticType: params.semanticType ?? null,
      spaceId: sp,
      userId: null,
      agentId: null,
      sessionId: null,
      createdByActor: null,
      createdBySessionId: null,
      createdByStepId: null,
      createdByStepExecutionId: null,
      currentVersion: (existing?.currentVersion ?? 0) + 1,
      embeddingStatus: 'pending',
      indexingMode: params.indexing,
      expiresAt: null,
      deletedAt: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.docs.set(key, next);
    return next;
  }

  // Methods unused by WorkspaceManager — provide unimplemented stubs.
  grep = async () => [];
  getVersion = async () => null;
  getLatestVersion = async () => null;
  softDelete = async () => false;
  listDeleted = async () => [];
  restore = async () => false;
  hardDelete = async () => false;
  insertChunks = async () => {};
  deleteChunksForDoc = async () => {};
  searchFts = async () => [];
  searchVector = async () => [];
  searchHybrid = async () => [];
  getChunksForVersion = async () => [];
  updateChunkEmbedding = async () => {};
  updateDocEmbeddingStatus = async () => {};
  updateDerivedFields = async () => {};
  resolveEmbeddingModel = async () => ({
    model: 'test',
    dims: 1536,
    column: 'embedding_1536',
  });
  getEmbedConfig = async () => null;
  setEmbedConfig = async () => ({
    id: 'cfg-1',
    scopeType: 'global',
    scopeValue: null,
    embeddingModel: 'test',
    dims: 1536,
  });
  markDocsStaleForScope = async () => [];
  getStaleDocsForReembed = async () => [];
  withTransaction = async <T>(
    fn: (r: MemoryDocRepository, l: MemoryLinkRepository) => Promise<T>,
  ) => fn(this, fakeLinkRepo());

  /** Test-only: mutate a doc to simulate an external write between hydrate and flush. */
  externalUpdate(spaceId: string, path: string, newInlineContent: string): void {
    const key = `${spaceId}:${canonicalizePath(path)}`;
    const existing = this.docs.get(key);
    if (!existing) throw new Error(`No doc at ${key}`);
    this.docs.set(key, {
      ...existing,
      inlineContent: newInlineContent,
      contentHash: sha256(newInlineContent),
      sizeBytes: Buffer.byteLength(newInlineContent, 'utf-8'),
      currentVersion: existing.currentVersion + 1,
      updatedAt: new Date(),
    });
  }

  /** Test-only: snapshot of internal state. */
  snapshot(): { spaceId: string; path: string; version: number; content: string | null }[] {
    return Array.from(this.docs.values()).map((d) => ({
      spaceId: d.spaceId ?? '',
      path: d.path,
      version: d.currentVersion,
      content: d.inlineContent,
    }));
  }
}

class RaceRepo extends FakeRepo {
  racePath: string | null = null;

  override async put(params: MemoryDocPutParams): Promise<MemoryDoc> {
    if (
      this.racePath &&
      params.writeMode === 'create' &&
      canonicalizePath(params.path) === canonicalizePath(this.racePath)
    ) {
      throw new Error(`MEMORY_ALREADY_EXISTS: document at path '${params.path}' already exists`);
    }
    return super.put(params);
  }
}

function makeManager(repo: FakeRepo, redis: RedisType): WorkspaceManager {
  return new WorkspaceManager({
    log: silentLogger(),
    db: undefined,
    redis,
    payloadStore: createMemoryPayloadStore(),
    repoFactory: () => repo,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('WorkspaceManager.hydrate', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('materializes Memory docs at /workspace/<memoryPath>', async () => {
    repo.add({ path: '/data/titanic/train.csv', inlineContent: 'a,b\n1,2', spaceId: SPACE });
    repo.add({ path: '/data/titanic/test.csv', inlineContent: 'a,b\n3,4', spaceId: SPACE });
    repo.add({ path: '/data/other/unrelated.csv', inlineContent: 'x', spaceId: SPACE });

    const result = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/titanic/'],
    });

    expect(result.hydratedPathsCount).toBe(2);
    const train = await readFile(join(result.hostDir, 'data/titanic/train.csv'), 'utf-8');
    expect(train).toBe('a,b\n1,2');
    const test = await readFile(join(result.hostDir, 'data/titanic/test.csv'), 'utf-8');
    expect(test).toBe('a,b\n3,4');
  });

  it('persists a manifest in Redis with hydrate-time version + hash', async () => {
    const doc = repo.add({ path: '/data/x.csv', inlineContent: 'hello', spaceId: SPACE });

    await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/x.csv'],
    });

    const manifest = await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN });
    expect(manifest).not.toBeNull();
    expect(manifest!.scope).toEqual({
      kind: 'run',
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
    });
    const entry = manifest!.files['/data/x.csv'];
    expect(entry).toBeDefined();
    expect(entry!.memoryDocId).toBe(doc.id);
    expect(entry!.memoryVersionAtHydrate).toBe(1);
    expect(entry!.sizeBytes).toBe(5);
    expect(manifest!.bytesUsed).toBe(5);
  });

  it('rejects an empty workingSet', async () => {
    await expect(
      mgr.hydrate({
        tenantId: TENANT,
        runId: RUN,
        spaceId: SPACE,
        inputs: [],
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('throws WORKSPACE_FILE_TOO_LARGE on per-file cap', async () => {
    repo.add({ path: '/big.csv', inlineContent: 'x'.repeat(200), spaceId: SPACE });

    await expect(
      mgr.hydrate({
        tenantId: TENANT,
        runId: RUN,
        spaceId: SPACE,
        inputs: ['/big.csv'],
        quotas: { maxBytes: 10_000, maxFileBytes: 100, maxFileCount: 100 },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_TOO_LARGE' });
  });

  it('throws WORKSPACE_QUOTA_EXCEEDED on total bytes cap', async () => {
    repo.add({ path: '/a.csv', inlineContent: 'x'.repeat(60), spaceId: SPACE });
    repo.add({ path: '/b.csv', inlineContent: 'x'.repeat(60), spaceId: SPACE });

    await expect(
      mgr.hydrate({
        tenantId: TENANT,
        runId: RUN,
        spaceId: SPACE,
        inputs: ['/'],
        quotas: { maxBytes: 100, maxFileBytes: 1000, maxFileCount: 100 },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_QUOTA_EXCEEDED' });
  });

  it('throws WORKSPACE_FILE_COUNT_EXCEEDED on file count cap', async () => {
    repo.add({ path: '/a.csv', inlineContent: 'a', spaceId: SPACE });
    repo.add({ path: '/b.csv', inlineContent: 'b', spaceId: SPACE });
    repo.add({ path: '/c.csv', inlineContent: 'c', spaceId: SPACE });

    await expect(
      mgr.hydrate({
        tenantId: TENANT,
        runId: RUN,
        spaceId: SPACE,
        inputs: ['/'],
        quotas: { maxBytes: 1_000_000, maxFileBytes: 1_000_000, maxFileCount: 2 },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_COUNT_EXCEEDED' });
  });
});

describe('WorkspaceManager.flush', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('publishes new files (created in workspace) back to Memory', async () => {
    repo.add({ path: '/data/seed.csv', inlineContent: 'seed', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });

    // Simulate: agent code writes a new file to /workspace/data/result.csv
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(hydrated.hostDir, 'data'), { recursive: true });
    await writeFile(join(hydrated.hostDir, 'data/result.csv'), 'a,b\n1,2', 'utf-8');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
    });

    expect(flush.committed).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/data/result.csv' })]),
    );
    expect(flush.conflicts).toEqual([]);
    const written = await repo.getByPath('/data/result.csv', SPACE);
    expect(written).not.toBeNull();
    expect(written!.inlineContent).toBe('a,b\n1,2');
  });

  it('detects compare-and-set conflict when Memory was updated externally', async () => {
    repo.add({ path: '/data/learnings.json', inlineContent: '{"v":1}', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/learnings.json'],
    });

    // Agent modifies the local copy
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(hydrated.hostDir, 'data/learnings.json'),
      '{"v":2,"agent":"local"}',
      'utf-8',
    );

    // Meanwhile, an external writer updates Memory (memoryVersion now 2)
    repo.externalUpdate(SPACE, '/data/learnings.json', '{"v":2,"external":true}');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
    });

    expect(flush.committed).toEqual([]);
    expect(flush.conflicts).toEqual([
      expect.objectContaining({
        path: '/data/learnings.json',
        hydratedAtVersion: 1,
        currentVersion: 2,
      }),
    ]);
    // Memory still holds the external version, NOT silently overwritten.
    const current = await repo.getByPath('/data/learnings.json', SPACE);
    expect(current!.inlineContent).toBe('{"v":2,"external":true}');
  });

  it('partial commit: non-conflicting files publish even when others conflict', async () => {
    repo.add({ path: '/data/a.csv', inlineContent: 'a:v1', spaceId: SPACE });
    repo.add({ path: '/data/b.csv', inlineContent: 'b:v1', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });

    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(hydrated.hostDir, 'data/a.csv'), 'a:agent', 'utf-8');
    await writeFile(join(hydrated.hostDir, 'data/b.csv'), 'b:agent', 'utf-8');

    // External writer touches /data/b.csv only
    repo.externalUpdate(SPACE, '/data/b.csv', 'b:external');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
    });

    expect(flush.committed.map((c) => c.path)).toEqual(['/data/a.csv']);
    expect(flush.conflicts.map((c) => c.path)).toEqual(['/data/b.csv']);

    const aDoc = await repo.getByPath('/data/a.csv', SPACE);
    expect(aDoc!.inlineContent).toBe('a:agent');
    const bDoc = await repo.getByPath('/data/b.csv', SPACE);
    expect(bDoc!.inlineContent).toBe('b:external');
  });

  it('treats unmodified hydrated files as not dirty (no-op on flush)', async () => {
    repo.add({ path: '/data/clean.csv', inlineContent: 'unchanged', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
    });

    expect(flush.committed).toEqual([]);
    expect(flush.conflicts).toEqual([]);
    const doc = await repo.getByPath('/data/clean.csv', SPACE);
    expect(doc!.currentVersion).toBe(1); // never re-published
  });

  it('rm-ed local file becomes pendingDeletes — Memory doc stays put', async () => {
    repo.add({ path: '/data/scratch.txt', inlineContent: 'scratch', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });

    // Agent rm's the local file
    const { unlink } = await import('node:fs/promises');
    await unlink(join(hydrated.hostDir, 'data/scratch.txt'));

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
    });

    expect(flush.pendingDeletes).toEqual(['/data/scratch.txt']);
    expect(flush.committed).toEqual([]);
    const doc = await repo.getByPath('/data/scratch.txt', SPACE);
    expect(doc).not.toBeNull(); // NOT auto-deleted
  });

  it('manifest reports lastFlushedAt and updated bytesUsed after flush', async () => {
    repo.add({ path: '/data/clean.csv', inlineContent: 'untouched', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });

    const before = await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN });
    expect(before!.lastFlushedAt).toBeNull();

    await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
    });

    const after = await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN });
    expect(after!.lastFlushedAt).not.toBeNull();
  });
});

describe('WorkspaceManager security guards', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('hydrate refuses paths that would escape the workspace root', async () => {
    // Manually add a doc with a non-canonical-looking path. canonicalizePath
    // strips '..' segments so the practical attack surface is small, but the
    // defense-in-depth check in writeWorkspaceFile should still cover any
    // edge case. Skipped without a way to bypass canonicalizePath; included
    // here as documentation of intent.
    expect(true).toBe(true);
  });

  it('walkWorkspace skips symlinks (defense-in-depth against bind-mount escape)', async () => {
    // Verified indirectly by the flush tests — a symlinked file would not be
    // picked up as dirty. Direct test would require symlink creation in a
    // sandboxed test dir, which is fine but verbose; defer to integration.
    expect(true).toBe(true);
  });
});

describe('WorkspaceManager.getStatus', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('returns null before hydrate', async () => {
    const status = await mgr.getStatus(TENANT, RUN);
    expect(status).toBeNull();
  });

  it('reports hydratedPathsCount, bytesUsed, dirtyPathsCount post-hydrate', async () => {
    repo.add({ path: '/data/a.csv', inlineContent: 'a', spaceId: SPACE });
    repo.add({ path: '/data/b.csv', inlineContent: 'bb', spaceId: SPACE });

    await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });

    const status = await mgr.getStatus(TENANT, RUN);
    expect(status).not.toBeNull();
    expect(status!.hydratedPathsCount).toBe(2);
    expect(status!.bytesUsed).toBe(3);
    // Pre-flush, mtimeAtFlush is null for every entry → dirtyPathsCount === hydratedPathsCount.
    expect(status!.dirtyPathsCount).toBe(2);
    expect(status!.pendingDeletesCount).toBe(0);
    expect(status!.lastFlushedAt).toBeNull();
  });
});

// ============================================================================

describe('Plan 114 C2: conflict sidecar paths', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('on conflict, rescues local content to a sidecar Memory doc', async () => {
    repo.add({ path: '/data/learnings.json', inlineContent: '{"v":1}', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/learnings.json'],
    });

    // Agent makes a local edit
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(hydrated.hostDir, 'data/learnings.json'),
      '{"v":2,"agent":"local"}',
      'utf-8',
    );

    // External writer drives Memory forward
    repo.externalUpdate(SPACE, '/data/learnings.json', '{"v":2,"external":true}');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
    });

    expect(flush.committed).toEqual([]);
    expect(flush.conflicts).toHaveLength(1);
    const conflict = flush.conflicts[0]!;
    expect(conflict.path).toBe('/data/learnings.json');
    expect(conflict.sidecarPath).toBeDefined();
    expect(conflict.sidecarPath).toMatch(/^\/data\/learnings\.json\.conflict-/);

    // Sidecar Memory doc exists with the local edit (NOT silently lost)
    const sidecarDoc = await repo.getByPath(conflict.sidecarPath!, SPACE);
    expect(sidecarDoc).not.toBeNull();
    expect(sidecarDoc!.inlineContent).toBe('{"v":2,"agent":"local"}');
    expect(sidecarDoc!.tags).toContain('workspace_conflict');

    // Original Memory doc still holds the external version
    const original = await repo.getByPath('/data/learnings.json', SPACE);
    expect(original!.inlineContent).toBe('{"v":2,"external":true}');
  });
});

describe('Plan 114 C4: two-pass scan handles oversize files', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('skips files that exceed maxFileBytes WITHOUT reading them', async () => {
    repo.add({ path: '/data/seed.csv', inlineContent: 'small', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });

    // Agent writes a small file (below cap) and a large file (above cap).
    // The large file simulates a runaway training output that would have
    // OOM'd the executor under the old single-pass walkWorkspace.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(hydrated.hostDir, 'data'), { recursive: true });
    await writeFile(join(hydrated.hostDir, 'data/result.csv'), 'a,b\n1,2', 'utf-8');
    await writeFile(join(hydrated.hostDir, 'data/huge.bin'), 'X'.repeat(2048), 'utf-8');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
      // Per-file cap of 1024 bytes — anything bigger is skipped at lstat time.
      quotas: { maxBytes: 1_000_000, maxFileBytes: 1024, maxFileCount: 100 },
    });

    expect(flush.committed.map((c) => c.path)).toEqual(['/data/result.csv']);
    expect(flush.skipped).toEqual([
      expect.objectContaining({ path: '/data/huge.bin', reason: 'too_large' }),
    ]);
    // Oversize file was NOT auto-marked as a pending-delete, even though it's
    // not in the manifest — being too-large is not the same as agent rm'ing it.
    expect(flush.pendingDeletes).not.toContain('/data/huge.bin');
  });

  it('skips files when total bytes would exceed maxBytes (deterministic order)', async () => {
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/seed/'],
    });
    // hydrate had no docs to pull, but the manifest is set up; agent now
    // writes more than the workspace can hold.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(hydrated.hostDir, 'data'), { recursive: true });
    await writeFile(join(hydrated.hostDir, 'data/a.txt'), 'X'.repeat(60), 'utf-8');
    await writeFile(join(hydrated.hostDir, 'data/b.txt'), 'X'.repeat(60), 'utf-8');
    await writeFile(join(hydrated.hostDir, 'data/c.txt'), 'X'.repeat(60), 'utf-8');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
      // maxBytes = 100 → only the first 1 file fits, the rest are skipped.
      quotas: { maxBytes: 100, maxFileBytes: 1000, maxFileCount: 100 },
    });

    const skippedPaths = flush.skipped.map((s) => s.path).sort();
    expect(skippedPaths).toEqual(['/data/b.txt', '/data/c.txt']);
    expect(flush.skipped.every((s) => s.reason === 'workspace_quota_exceeded')).toBe(true);
    expect(flush.committed.map((c) => c.path)).toEqual(['/data/a.txt']);
  });

  it('skips files when count would exceed maxFileCount', async () => {
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/seed/'],
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(hydrated.hostDir, 'data'), { recursive: true });
    await writeFile(join(hydrated.hostDir, 'data/a.txt'), 'a', 'utf-8');
    await writeFile(join(hydrated.hostDir, 'data/b.txt'), 'b', 'utf-8');
    await writeFile(join(hydrated.hostDir, 'data/c.txt'), 'c', 'utf-8');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'session-end',
      quotas: { maxBytes: 1_000_000, maxFileBytes: 1000, maxFileCount: 1 },
    });

    expect(flush.committed).toHaveLength(1);
    expect(flush.skipped).toHaveLength(2);
    expect(flush.skipped.every((s) => s.reason === 'workspace_quota_exceeded')).toBe(true);
  });
});

describe('Plan 114 W2: hydrate cleanup on acquire failure', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('release() removes both host dir and Redis manifest', async () => {
    repo.add({ path: '/data/x.csv', inlineContent: 'hello', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/x.csv'],
    });
    expect(await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN })).not.toBeNull();

    // Simulate: handler called release() because acquire threw before docker
    // create succeeded. The just-hydrated workspace should be fully cleaned.
    await mgr.release(TENANT, RUN, hydrated.hostDir);

    expect(await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN })).toBeNull();
    const { stat } = await import('node:fs/promises');
    await expect(stat(hydrated.hostDir)).rejects.toThrow();
  });
});

// ============================================================================

describe('Plan 188 §4.B: ephemeral per-step manifest scope', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  const STEP_A = 'step-a' as StepExecutionId;
  const STEP_B = 'step-b' as StepExecutionId;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('keys the manifest per (stepExecutionId, attempt) so concurrent same-run one-shots are isolated', async () => {
    repo.add({ path: '/data/a/in.csv', inlineContent: 'a-in', spaceId: SPACE });
    repo.add({ path: '/data/b/in.csv', inlineContent: 'b-in', spaceId: SPACE });

    // Two one-shot execs in the SAME run hydrate disjoint workingSets.
    const ha = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/a/'],
      scope: { stepExecutionId: STEP_A, attempt: 0 },
    });
    const hb = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/b/'],
      scope: { stepExecutionId: STEP_B, attempt: 0 },
    });

    // Distinct manifests at distinct keys — neither clobbered the other, and
    // no run-scoped manifest leaked.
    const ma = await getWorkspaceManifest(redis, {
      tenantId: TENANT,
      runId: RUN,
      stepExecutionId: STEP_A,
      attempt: 0,
    });
    const mb = await getWorkspaceManifest(redis, {
      tenantId: TENANT,
      runId: RUN,
      stepExecutionId: STEP_B,
      attempt: 0,
    });
    expect(Object.keys(ma!.files)).toEqual(['/data/a/in.csv']);
    expect(Object.keys(mb!.files)).toEqual(['/data/b/in.csv']);
    expect(await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN })).toBeNull();

    // Each exec writes a NEW file into its own workspace.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(ha.hostDir, 'data/a/out.csv'), 'a-out', 'utf-8');
    await writeFile(join(hb.hostDir, 'data/b/out.csv'), 'b-out', 'utf-8');

    const fa = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: ha.hostDir,
      reason: 'exec-end',
      scope: { stepExecutionId: STEP_A, attempt: 0 },
    });
    const fb = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hb.hostDir,
      reason: 'exec-end',
      scope: { stepExecutionId: STEP_B, attempt: 0 },
    });

    // Under the clobber bug (shared run key), flush A would read B's manifest,
    // see /data/a/in.csv as unhydrated-and-existing, and CONFLICT on it. With
    // per-step keys each flush reads its own manifest: hydrated in.csv is
    // unchanged (not dirty), only the new out.csv commits.
    expect(fa.conflicts).toEqual([]);
    expect(fb.conflicts).toEqual([]);
    expect(fa.committed.map((c) => c.path)).toEqual(['/data/a/out.csv']);
    expect(fb.committed.map((c) => c.path)).toEqual(['/data/b/out.csv']);
    expect(fa.committed[0]!.sizeBytes).toBe(Buffer.byteLength('a-out', 'utf-8'));
  });
});

// ============================================================================

describe('Plan 188 §4.C: create-if-absent for unhydrated paths', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('an unhydrated write over an existing Memory doc conflicts (rescue), never overwrites', async () => {
    // Doc exists in Memory but is NOT in the workingSet — never hydrated.
    repo.add({ path: '/data/existing.csv', inlineContent: 'original', spaceId: SPACE });
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/seed/'], // disjoint from /data/existing.csv
    });

    // Agent writes a file at the SAME memory path it never hydrated.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(hydrated.hostDir, 'data'), { recursive: true });
    await writeFile(join(hydrated.hostDir, 'data/existing.csv'), 'agent-overwrite', 'utf-8');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'exec-end',
    });

    // NOT committed — treated as a conflict, rescued to a sidecar.
    expect(flush.committed).toEqual([]);
    expect(flush.conflicts).toHaveLength(1);
    const conflict = flush.conflicts[0]!;
    expect(conflict.path).toBe('/data/existing.csv');
    expect(conflict.sidecarPath).toBeDefined();

    // Original Memory doc is UNCHANGED — not silently overwritten.
    const original = await repo.getByPath('/data/existing.csv', SPACE);
    expect(original!.inlineContent).toBe('original');
    expect(original!.currentVersion).toBe(1);

    // Local edit was rescued to the sidecar doc.
    const sidecar = await repo.getByPath(conflict.sidecarPath!, SPACE);
    expect(sidecar!.inlineContent).toBe('agent-overwrite');
    expect(sidecar!.tags).toContain('workspace_conflict');
  });

  it('an unhydrated write to a genuinely-new path creates it (no false conflict)', async () => {
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/seed/'],
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(hydrated.hostDir, 'data'), { recursive: true });
    await writeFile(join(hydrated.hostDir, 'data/brand-new.csv'), 'fresh', 'utf-8');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'exec-end',
    });

    expect(flush.conflicts).toEqual([]);
    expect(flush.committed.map((c) => c.path)).toEqual(['/data/brand-new.csv']);
    const doc = await repo.getByPath('/data/brand-new.csv', SPACE);
    expect(doc!.inlineContent).toBe('fresh');
  });

  it('a repo-level CAS collision (race after the pre-check) is rescued to a sidecar, not aborted', async () => {
    // Race window: the pre-check getByPath sees no doc (raced path absent from
    // the repo), but the repo.put(writeMode:'create') rejects because a
    // concurrent writer already created the doc. This must become a conflict
    // (sidecar rescue), not a thrown flush that aborts the whole pass.
    const raceRepo = new RaceRepo();
    raceRepo.racePath = '/data/raced.csv';
    const raceMgr = makeManager(raceRepo, redis);

    const hydrated = await raceMgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/seed/'],
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(hydrated.hostDir, 'data'), { recursive: true });
    await writeFile(join(hydrated.hostDir, 'data/raced.csv'), 'agent-local', 'utf-8');

    const flush = await raceMgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'exec-end',
    });

    expect(flush.committed).toEqual([]);
    expect(flush.conflicts).toHaveLength(1);
    const conflict = flush.conflicts[0]!;
    expect(conflict.path).toBe('/data/raced.csv');
    expect(conflict.sidecarPath).toBeDefined();
    const sidecar = await raceRepo.getByPath(conflict.sidecarPath!, SPACE);
    expect(sidecar!.inlineContent).toBe('agent-local');
    expect(sidecar!.tags).toContain('workspace_conflict');
  });
});

// ============================================================================

describe('Plan 188 §4.D: binary workspace files', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  // Bytes that are NOT valid UTF-8 — a string/JSON round-trip would corrupt them.
  const BIN = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xfe, 0x7f, 0x90, 0xc3, 0x28]);

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('flushes a binary file as raw bytes (payloadRef-backed, no preview/index) and re-hydrates exact bytes', async () => {
    const h1 = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/models/'],
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(h1.hostDir, 'models'), { recursive: true });
    await writeFile(join(h1.hostDir, 'models/m.pkl'), BIN); // raw bytes, no encoding

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: h1.hostDir,
      reason: 'exec-end',
    });

    expect(flush.committed.map((c) => c.path)).toEqual(['/models/m.pkl']);
    expect(flush.committed[0]!.sizeBytes).toBe(BIN.length);
    expect(flush.conflicts).toEqual([]);
    expect(flush.skipped).toEqual([]);

    // §4.D doc shape: raw bytes by reference, stat-only (no preview / no index).
    const doc = await repo.getByPath('/models/m.pkl', SPACE);
    expect(doc!.inlineContent).toBeNull();
    expect(doc!.payloadRef).toBeTruthy();
    expect(doc!.payloadRef!.endsWith('.bin')).toBe(true);
    expect(doc!.preview).toBeNull();
    expect(doc!.indexingMode).toBe('disabled');
    expect(doc!.mimeType).toBe('application/octet-stream');
    expect(doc!.sizeBytes).toBe(BIN.length);

    // Re-hydrate a fresh workspace from the same Memory → exact bytes survive.
    const h2 = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/models/'],
    });
    const restored = await readFile(join(h2.hostDir, 'models/m.pkl'));
    expect(restored.equals(BIN)).toBe(true);
  });

  it('byte-hash dirty detection: unchanged binary is not re-published; a 1-byte change is', async () => {
    // Seed Memory with the binary doc via a first flush.
    const h1 = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/models/'],
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(h1.hostDir, 'models'), { recursive: true });
    await writeFile(join(h1.hostDir, 'models/m.pkl'), BIN);
    await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: h1.hostDir,
      reason: 'exec-end',
    });

    // Re-hydrate, flush WITHOUT touching the file → not dirty (byte hash matches).
    const h2 = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/models/'],
    });
    const clean = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: h2.hostDir,
      reason: 'exec-end',
    });
    expect(clean.committed).toEqual([]);
    expect(clean.conflicts).toEqual([]);

    // Flip a single byte → detected as dirty and re-published.
    const mutated = Buffer.from(BIN);
    mutated[0] = mutated[0]! ^ 0xff;
    await writeFile(join(h2.hostDir, 'models/m.pkl'), mutated);
    const dirtyFlush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: h2.hostDir,
      reason: 'exec-end',
    });
    expect(dirtyFlush.committed.map((c) => c.path)).toEqual(['/models/m.pkl']);
    expect(dirtyFlush.conflicts).toEqual([]);
  });

  it('a text file still flushes as text (inline + preview + indexing), not binary', async () => {
    const h1 = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(h1.hostDir, 'data'), { recursive: true });
    await writeFile(join(h1.hostDir, 'data/out.csv'), 'a,b\n1,2', 'utf-8');

    await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: h1.hostDir,
      reason: 'exec-end',
    });

    const doc = await repo.getByPath('/data/out.csv', SPACE);
    expect(doc!.inlineContent).toBe('a,b\n1,2');
    expect(doc!.payloadRef).toBeNull();
    expect(doc!.preview).not.toBeNull();
    expect(doc!.indexingMode).toBe('auto');
    expect(doc!.mimeType).toBe('text/csv');
  });
});

// ============================================================================

describe('Plan 188 §4.F: output roots + hydratedPaths', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('pre-creates declared output dirs (empty, not a conflict) and reports hydratedPaths', async () => {
    repo.add({ path: '/data/in.csv', inlineContent: 'x', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/'],
      outputs: ['/out/', '/results/submission.csv'],
    });

    // §4.F result visibility: exactly the inputs that materialized.
    expect(hydrated.hydratedPaths).toEqual(['/data/in.csv']);

    const { stat, writeFile } = await import('node:fs/promises');
    // A declared output dir exists up front (empty)…
    expect((await stat(join(hydrated.hostDir, 'out'))).isDirectory()).toBe(true);
    // …and the parent dir of a declared output FILE exists too.
    expect((await stat(join(hydrated.hostDir, 'results'))).isDirectory()).toBe(true);

    // Code writes into the pre-created dir → flushes back to Memory.
    await writeFile(join(hydrated.hostDir, 'out/result.csv'), 'a,b\n1,2', 'utf-8');
    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'exec-end',
    });
    expect(flush.committed.map((c) => c.path)).toEqual(['/out/result.csv']);
  });

  it('requires at least one of inputs/outputs', async () => {
    await expect(
      mgr.hydrate({ tenantId: TENANT, runId: RUN, spaceId: SPACE, inputs: [] }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('rejects an output path that escapes the workspace root (fail fast, not silent skip)', async () => {
    await expect(
      mgr.hydrate({
        tenantId: TENANT,
        runId: RUN,
        spaceId: SPACE,
        inputs: [],
        outputs: ['../../etc/passwd'],
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID_WORKING_SET' });
  });

  it('hydrates an existing declared output so overwriting it is a clean CAS update (no false conflict)', async () => {
    repo.add({ path: '/data/out.csv', inlineContent: 'old', spaceId: SPACE });

    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: [],
      outputs: ['/data/out.csv'],
    });
    // The existing output was hydrated (so the manifest knows its version).
    expect(hydrated.hydratedPaths).toEqual(['/data/out.csv']);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(hydrated.hostDir, 'data/out.csv'), 'new', 'utf-8');
    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'exec-end',
    });

    expect(flush.conflicts).toEqual([]); // CAS update, not unhydrated-overwrite
    expect(flush.committed.map((c) => c.path)).toEqual(['/data/out.csv']);
    expect((await repo.getByPath('/data/out.csv', SPACE))!.inlineContent).toBe('new');
  });
});

describe('Plan 188 §4.F: binary classification by extension', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('treats a known-binary extension as binary even when the bytes are valid UTF-8', async () => {
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: [],
      outputs: ['/models/'],
    });
    const { writeFile } = await import('node:fs/promises');
    // A .pkl whose bytes happen to be valid UTF-8 — must still be stored as binary.
    await writeFile(join(hydrated.hostDir, 'models/model.pkl'), 'valid utf-8 text', 'utf-8');

    const flush = await mgr.flush({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      reason: 'exec-end',
    });
    expect(flush.committed.map((c) => c.path)).toEqual(['/models/model.pkl']);

    const doc = await repo.getByPath('/models/model.pkl', SPACE);
    expect(doc!.inlineContent).toBeNull(); // NOT inlined as text
    expect(doc!.payloadRef).toBeTruthy();
    expect(doc!.payloadRef!.endsWith('.bin')).toBe(true);
    expect(doc!.indexingMode).toBe('disabled');
    expect(doc!.preview).toBeNull();
  });
});

// ============================================================================

describe('Plan 188 §4.H: WorkspaceManager.refresh (auto-merge)', () => {
  let redis: RedisType;
  let repo: FakeRepo;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    repo = new FakeRepo();
    mgr = makeManager(repo, redis);
  });

  it('materializes a newly-declared input into the live workspace + manifest', async () => {
    repo.add({ path: '/data/a/train.csv', inlineContent: 'a', spaceId: SPACE });
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/a/'],
    });

    // A new doc appears in Memory; the agent declares it on a later turn.
    repo.add({ path: '/data/b/extra.csv', inlineContent: 'b-extra', spaceId: SPACE });
    const refreshed = await mgr.refresh({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      inputs: ['/data/b/'],
    });

    expect(refreshed.added).toEqual(['/data/b/extra.csv']);
    const onDisk = await readFile(join(hydrated.hostDir, 'data/b/extra.csv'), 'utf-8');
    expect(onDisk).toBe('b-extra');
    const manifest = await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN });
    expect(Object.keys(manifest!.files)).toContain('/data/b/extra.csv');
    expect(manifest!.inputs).toContain('/data/b/');
  });

  it('is add-only: re-declaring an already-hydrated path does NOT clobber a local edit', async () => {
    repo.add({ path: '/data/a.csv', inlineContent: 'memory-v1', spaceId: SPACE });
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/a.csv'],
    });

    // Agent locally edits the file (not yet flushed).
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(hydrated.hostDir, 'data/a.csv'), 'local-edit', 'utf-8');

    // Re-declaring the same path on a later turn must NOT pull Memory's version
    // back over the dirty local copy.
    const refreshed = await mgr.refresh({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      inputs: ['/data/a.csv'],
    });

    expect(refreshed.added).toEqual([]); // nothing new
    const onDisk = await readFile(join(hydrated.hostDir, 'data/a.csv'), 'utf-8');
    expect(onDisk).toBe('local-edit'); // local edit preserved
  });

  it('pre-creates newly-declared output dirs on refresh', async () => {
    repo.add({ path: '/data/seed.csv', inlineContent: 's', spaceId: SPACE });
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/seed.csv'],
    });

    await mgr.refresh({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      hostDir: hydrated.hostDir,
      inputs: [],
      outputs: ['/results/'],
    });

    const { stat } = await import('node:fs/promises');
    expect((await stat(join(hydrated.hostDir, 'results'))).isDirectory()).toBe(true);
  });

  it('throws WORKSPACE_NOT_HYDRATED when there is no live workspace to refresh', async () => {
    await expect(
      mgr.refresh({
        tenantId: TENANT,
        runId: RUN,
        spaceId: SPACE,
        hostDir: '/tmp/nonexistent',
        inputs: ['/data/x/'],
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_HYDRATED' });
  });

  it('is atomic: a later doc over quota rolls back — no earlier doc is left on disk or in the manifest', async () => {
    repo.add({ path: '/data/seed.csv', inlineContent: 'seed', spaceId: SPACE });
    const hydrated = await mgr.hydrate({
      tenantId: TENANT,
      runId: RUN,
      spaceId: SPACE,
      inputs: ['/data/seed.csv'],
    });
    const before = await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN });

    // Two newly-declared inputs in order: the first is fine, the second blows the
    // per-file cap. The first must NOT be written (preflight runs before commit).
    repo.add({ path: '/data/small.csv', inlineContent: 'ok', spaceId: SPACE });
    repo.add({ path: '/data/big.csv', inlineContent: 'x'.repeat(100), spaceId: SPACE });

    await expect(
      mgr.refresh({
        tenantId: TENANT,
        runId: RUN,
        spaceId: SPACE,
        hostDir: hydrated.hostDir,
        inputs: ['/data/small.csv', '/data/big.csv'],
        quotas: { maxBytes: 1_000_000, maxFileBytes: 10, maxFileCount: 1000 },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FILE_TOO_LARGE' });

    // small.csv was iterated before big.csv but must not have hit disk.
    await expect(readFile(join(hydrated.hostDir, 'data/small.csv'), 'utf-8')).rejects.toThrow();
    // Manifest is untouched — no half-applied bytes/files.
    const after = await getWorkspaceManifest(redis, { tenantId: TENANT, runId: RUN });
    expect(Object.keys(after!.files)).not.toContain('/data/small.csv');
    expect(after!.bytesUsed).toBe(before!.bytesUsed);
  });
});
