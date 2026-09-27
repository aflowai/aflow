import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import {
  canonicalizePath,
  type MemoryDoc,
  type MemoryDocPutParams,
  type MemoryDocQueryOptions,
  type MemoryDocQueryResult,
  type MemoryDocRepository,
  type MemoryLinkRepository,
} from '@aflow/database';
import { createMemoryPayloadStore } from '@aflow/payload-store';
import type { ExecutorContext, ExecutorLogger, StepResult } from '@aflow/executor-runtime';
import type { TenantId, SessionId, StepExecutionId, PayloadRef } from '@aflow/schemas';

import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
} from '../containerRunner.js';
import { WorkspaceManager } from '../workspaceManager.js';
import { ComputeExecHandler } from '../computeExecHandler.js';

// ============================================================================
// Test doubles
// ============================================================================

const TENANT = '00000000-0000-0000-0000-0000000000aa' as TenantId;
const RUN = '00000000-0000-0000-0000-0000000000bb' as SessionId;
const SPACE = 'space-1';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function silentLogger(): ExecutorLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/** Compact in-memory MemoryDocRepository — only the methods WorkspaceManager calls. */
class TinyRepo {
  private docs = new Map<string, MemoryDoc>();
  private nextId = 1;
  /** Test hook: throw from put() to simulate an infra failure (DB/PayloadStore down). */
  putHook?: (params: MemoryDocPutParams) => void;

  add(path: string, inlineContent: string): MemoryDoc {
    const canonical = canonicalizePath(path);
    const id = `doc-${String(this.nextId++)}`;
    const now = new Date();
    const doc = {
      id,
      path: canonical,
      docType: 'dataset',
      mimeType: 'text/csv',
      sizeBytes: Buffer.byteLength(inlineContent, 'utf-8'),
      contentHash: sha256(inlineContent),
      inlineContent,
      payloadRef: null,
      preview: null,
      tags: [] as string[],
      summary: null,
      semanticType: null,
      spaceId: SPACE,
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
    } as unknown as MemoryDoc;
    this.docs.set(canonical, doc);
    return doc;
  }

  async getById(id: string): Promise<MemoryDoc | null> {
    for (const d of this.docs.values()) if (d.id === id) return d;
    return null;
  }

  async getByPath(path: string): Promise<MemoryDoc | null> {
    return this.docs.get(canonicalizePath(path)) ?? null;
  }

  async list(options: MemoryDocQueryOptions): Promise<MemoryDocQueryResult[]> {
    const prefix = options.pathPrefix ? canonicalizePath(options.pathPrefix) : '/';
    const out: MemoryDocQueryResult[] = [];
    for (const d of this.docs.values()) {
      if (!d.path.startsWith(prefix)) continue;
      out.push({ id: d.id, path: d.path } as unknown as MemoryDocQueryResult);
    }
    return out;
  }

  async put(params: MemoryDocPutParams): Promise<MemoryDoc> {
    this.putHook?.(params);
    const path = canonicalizePath(params.path);
    const existing = this.docs.get(path);
    if (params.writeMode === 'create' && existing) {
      throw new Error(`MEMORY_ALREADY_EXISTS: ${path}`);
    }
    if (params.expectedHash && existing && existing.contentHash !== params.expectedHash) {
      throw new Error('MEMORY_HASH_MISMATCH');
    }
    const next = {
      ...(existing ?? {}),
      id: existing?.id ?? `doc-${String(this.nextId++)}`,
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
      spaceId: SPACE,
      currentVersion: (existing?.currentVersion ?? 0) + 1,
      indexingMode: params.indexing,
      updatedAt: new Date(),
    } as unknown as MemoryDoc;
    this.docs.set(path, next);
    return next;
  }

  updateDerivedFields = async () => {};
  getLatestVersion = async () => null;

  withTransaction = async <T>(
    fn: (r: MemoryDocRepository, l: MemoryLinkRepository) => Promise<T>,
  ): Promise<T> => {
    const linkRepo = {
      replaceLinksForDoc: async () => {},
    } as unknown as MemoryLinkRepository;
    return fn(this as unknown as MemoryDocRepository, linkRepo);
  };
}

function makeWorkspaceManager(repo: TinyRepo, redis: RedisType): WorkspaceManager {
  return new WorkspaceManager({
    log: silentLogger(),
    db: undefined,
    redis,
    payloadStore: createMemoryPayloadStore(),
    repoFactory: () => repo as unknown as MemoryDocRepository,
  });
}

/**
 * Fake runner: writes the file declared via env (OUT_REL / OUT_CONTENT) into the
 * hydrated /workspace/ bind-mount, simulating container code writing output.
 */
const fakeRunner: ContainerRunner = {
  async run(request: ContainerRunRequest): Promise<ContainerRunResult> {
    if (request.workspace && request.env?.['OUT_REL']) {
      const abs = join(request.workspace.hostDir, request.env['OUT_REL']);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, request.env['OUT_CONTENT'] ?? 'x', 'utf-8');
    }
    return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
  },
};

interface CtxResult {
  ctx: ExecutorContext;
  captured: () => Record<string, unknown> | undefined;
}

function makeCtx(input: unknown, stepExecutionId: StepExecutionId): CtxResult {
  let outputData: Record<string, unknown> | undefined;
  const ctx = {
    job: { spaceId: SPACE, inputRef: 'inline:input' as PayloadRef },
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId,
    attempt: 0,
    log: silentLogger(),
    readPayload: async (ref: PayloadRef) => (ref === 'inline:input' ? input : undefined),
    writePayload: async (kind: string, data: unknown): Promise<PayloadRef> => {
      if (kind === 'output') outputData = data as Record<string, unknown>;
      return `inline:${kind}` as PayloadRef;
    },
  } as unknown as ExecutorContext;
  return { ctx, captured: () => outputData };
}

// ============================================================================
// Tests
// ============================================================================

describe('Plan 188: one-shot workspace exec (handler dispatch)', () => {
  let redis: RedisType;
  let repo: TinyRepo;
  let handler: ComputeExecHandler;

  beforeEach(async () => {
    redis = new Redis() as unknown as RedisType;
    await redis.flushall();
    repo = new TinyRepo();
    handler = new ComputeExecHandler({
      db: undefined,
      runner: fakeRunner,
      redis,
      workspaceManager: makeWorkspaceManager(repo, redis),
    });
  });

  it('hydrates a workingSet, persists /workspace/out.csv to Memory, surfaces it in workspaceFlush.committed', async () => {
    repo.add('/data/train.csv', 'Id,SalePrice\n1,200000');

    const input = {
      runtime: 'python3-ml',
      code: 'print("noop")',
      workspace: { inputs: ['/data/'] },
      env: { OUT_REL: 'out.csv', OUT_CONTENT: 'a,b\n1,2' },
    };
    const { ctx, captured } = makeCtx(input, 'step-1' as StepExecutionId);

    const result: StepResult = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');

    const out = captured();
    expect(out).toBeDefined();
    const flush = out!['workspaceFlush'] as {
      hydratedPaths: string[];
      committed: Array<{ path: string; sizeBytes: number }>;
      conflicts: unknown[];
      skipped: unknown[];
      bytesFlushed: number;
    };
    expect(flush.hydratedPaths).toEqual(['/data/train.csv']); // §4.F visibility
    expect(flush.committed.map((c) => c.path)).toEqual(['/out.csv']);
    expect(flush.committed[0]!.sizeBytes).toBe(Buffer.byteLength('a,b\n1,2', 'utf-8'));
    expect(flush.conflicts).toEqual([]);
    expect(flush.skipped).toEqual([]);

    // The doc landed in Memory.
    const doc = await repo.getByPath('/out.csv');
    expect(doc).not.toBeNull();
    expect(doc!.inlineContent).toBe('a,b\n1,2');

    // Manifest was released (deleted) at the end of the one-shot lifecycle.
    const { getWorkspaceManifest } = await import('@aflow/redis');
    expect(
      await getWorkspaceManifest(redis, {
        tenantId: TENANT,
        runId: RUN,
        stepExecutionId: 'step-1',
        attempt: 0,
      }),
    ).toBeNull();
  });

  it('two concurrent same-run execs do not clobber each other', async () => {
    repo.add('/data/a/in.csv', 'a-in');
    repo.add('/data/b/in.csv', 'b-in');

    const inputA = {
      runtime: 'python3-ml',
      code: 'print("a")',
      workspace: { inputs: ['/data/a/'] },
      env: { OUT_REL: 'data/a/out.csv', OUT_CONTENT: 'a-out' },
    };
    const inputB = {
      runtime: 'python3-ml',
      code: 'print("b")',
      workspace: { inputs: ['/data/b/'] },
      env: { OUT_REL: 'data/b/out.csv', OUT_CONTENT: 'b-out' },
    };
    const a = makeCtx(inputA, 'step-a' as StepExecutionId);
    const b = makeCtx(inputB, 'step-b' as StepExecutionId);

    const [ra, rb] = await Promise.all([handler.execute(a.ctx), handler.execute(b.ctx)]);
    expect(ra.status).toBe('SUCCEEDED');
    expect(rb.status).toBe('SUCCEEDED');

    const flushA = a.captured()!['workspaceFlush'] as {
      committed: Array<{ path: string }>;
      conflicts: unknown[];
    };
    const flushB = b.captured()!['workspaceFlush'] as {
      committed: Array<{ path: string }>;
      conflicts: unknown[];
    };

    // Each exec committed ONLY its own new file, with no false conflict on the
    // other's hydrated input (the clobber bug would cross the manifests).
    expect(flushA.committed.map((c) => c.path)).toEqual(['/data/a/out.csv']);
    expect(flushB.committed.map((c) => c.path)).toEqual(['/data/b/out.csv']);
    expect(flushA.conflicts).toEqual([]);
    expect(flushB.conflicts).toEqual([]);

    expect((await repo.getByPath('/data/a/out.csv'))!.inlineContent).toBe('a-out');
    expect((await repo.getByPath('/data/b/out.csv'))!.inlineContent).toBe('b-out');
  });

  it('fails the step when the flush throws (infra failure) — never a false success', async () => {
    repo.add('/data/train.csv', 'Id\n1');
    // Simulate Redis/DB/PayloadStore down: every publish throws a NON-CAS error,
    // so flush() throws rather than returning conflicts/skips.
    repo.putHook = () => {
      throw new Error('DB_DOWN: connection refused');
    };

    const input = {
      runtime: 'python3-ml',
      code: 'print("noop")',
      workspace: { inputs: ['/data/'] },
      env: { OUT_REL: 'out.csv', OUT_CONTENT: 'a,b\n1,2' },
    };
    const { ctx, captured } = makeCtx(input, 'step-flush-throw' as StepExecutionId);

    const result = await handler.execute(ctx);
    // The run wrote a file but the flush could not persist it → the step FAILS,
    // rather than succeeding with an empty workspaceFlush (silent data loss).
    expect(result.status).toBe('FAILED');
    expect(captured()).toBeUndefined(); // no success output was written

    // Manifest still released (no leak) despite the flush failure.
    const { getWorkspaceManifest } = await import('@aflow/redis');
    expect(
      await getWorkspaceManifest(redis, {
        tenantId: TENANT,
        runId: RUN,
        stepExecutionId: 'step-flush-throw',
        attempt: 0,
      }),
    ).toBeNull();
  });

  it('fails the step when a CLEAN exit (0) did not produce a declared FILE output (§4.F contract)', async () => {
    repo.add('/data/train.csv', 'x');
    const input = {
      runtime: 'python3-ml',
      code: 'print("noop")',
      // Declares an output file but the runner (exit 0) writes nothing (no OUT_REL).
      workspace: { inputs: ['/data/'], outputs: ['/out.csv'] },
    };
    const { ctx } = makeCtx(input, 'step-missing-out' as StepExecutionId);

    const result = (await handler.execute(ctx)) as {
      status: string;
      error?: { message?: string; details?: { workspaceFlush?: { missingOutputs?: string[] } } };
    };
    expect(result.status).toBe('FAILED');
    // Self-contained message (a FAILED step delivers no output/details to the
    // agent) naming the exit and the path — no false conflict/skip boilerplate.
    expect(result.error?.message).toContain('exited 0');
    expect(result.error?.message).toContain('did not write declared output');
    expect(result.error?.message).toContain('/out.csv');
    expect(result.error?.message).not.toContain('conflicted');
    expect(result.error?.message).not.toContain('skipped');
    expect(result.error?.details?.workspaceFlush?.missingOutputs).toEqual(['/out.csv']);
  });

  it('a NON-ZERO exit with a missing declared output SUCCEEDS so the agent sees exitCode + stderr (no §4.F shadowing)', async () => {
    repo.add('/data/train.csv', 'x');
    // A runner that crashes fast (e.g. ImportError — the XGBoost-missing
    // shape) and writes nothing. The §4.F check must NOT
    // convert this into a contract failure, which would suppress the traceback.
    const crashRunner: ContainerRunner = {
      async run(): Promise<ContainerRunResult> {
        return {
          exitCode: 1,
          stdout: '',
          stderr:
            "Traceback (most recent call last):\nModuleNotFoundError: No module named 'xgboost'",
          durationMs: 5,
          timedOut: false,
        };
      },
    };
    const crashHandler = new ComputeExecHandler({
      db: undefined,
      runner: crashRunner,
      redis,
      workspaceManager: makeWorkspaceManager(repo, redis),
    });
    const input = {
      runtime: 'python3-ml',
      code: 'import xgboost',
      workspace: { inputs: ['/data/'], outputs: ['/out.csv'] },
    };
    const { ctx, captured } = makeCtx(input, 'step-crash-missing-out' as StepExecutionId);

    const result = await crashHandler.execute(ctx);
    // A crash is NOT a workspace-contract failure: the step succeeds so the
    // agent reads exitCode + the ImportError traceback and fixes its code.
    expect(result.status).toBe('SUCCEEDED');
    const out = captured()!;
    expect(out['exitCode']).toBe(1);
    expect(String(out['stderr'])).toContain('xgboost'); // the real cause reaches the agent
    const flush = out['workspaceFlush'] as { missingOutputs: string[] };
    expect(flush.missingOutputs).toEqual(['/out.csv']); // surfaced, not hidden
  });

  it('flushes /workspace/ writes to Memory when the run TIMES OUT (§4.A kill-durability)', async () => {
    repo.add('/data/train.csv', 'x');
    // A runner whose script wrote a per-fold checkpoint before the wall-clock
    // kill landed (exitCode 124 / timedOut). The REAL finally-flush must still
    // persist that file — a timeout costs the in-flight fold, not the run.
    const timeoutRunner: ContainerRunner = {
      async run(request: ContainerRunRequest): Promise<ContainerRunResult> {
        const abs = join(request.workspace!.hostDir, 'checkpoints/fold-0.json');
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, '{"fold":0,"metric":0.81}', 'utf-8');
        return {
          exitCode: 124,
          stdout: '',
          stderr: '[Execution timed out after 900s]',
          durationMs: 900_000,
          timedOut: true,
        };
      },
    };
    const timeoutHandler = new ComputeExecHandler({
      db: undefined,
      runner: timeoutRunner,
      redis,
      workspaceManager: makeWorkspaceManager(repo, redis),
    });
    const input = {
      runtime: 'python3-ml',
      code: 'train()',
      workspace: { inputs: ['/data/'], outputs: ['/submission.csv'] },
    };
    const { ctx, captured } = makeCtx(input, 'step-timeout-flush' as StepExecutionId);

    const result = await timeoutHandler.execute(ctx);
    // A timeout is not a workspace-contract failure: the step succeeds so the
    // agent sees timedOut + the flushed checkpoint and can resume from it.
    expect(result.status).toBe('SUCCEEDED');
    const out = captured()!;
    expect(out['timedOut']).toBe(true);
    const flush = out['workspaceFlush'] as {
      committed: Array<{ path: string }>;
      missingOutputs: string[];
    };
    expect(flush.committed.map((c) => c.path)).toEqual(['/checkpoints/fold-0.json']);
    expect(flush.missingOutputs).toEqual(['/submission.csv']); // surfaced, not a hard fail

    // The checkpoint is durable in Memory despite the kill.
    const doc = await repo.getByPath('/checkpoints/fold-0.json');
    expect(doc).not.toBeNull();
    expect(doc!.inlineContent).toBe('{"fold":0,"metric":0.81}');
  });

  it('classifies a hydrate failure (escaping output) as a validation error, not permission', async () => {
    const input = {
      runtime: 'python3-ml',
      code: 'print("noop")',
      workspace: { outputs: ['../escape.csv'] }, // escapes the workspace root
    };
    const { ctx } = makeCtx(input, 'step-escape' as StepExecutionId);

    const result = (await handler.execute(ctx)) as {
      status: string;
      error?: { classification?: string; code?: string };
    };
    expect(result.status).toBe('FAILED');
    expect(result.error?.classification).toBe('validation'); // not 'permission'
  });

  it('succeeds when the declared file output IS produced; trailing-slash dir roots are not required', async () => {
    repo.add('/data/train.csv', 'x');
    const input = {
      runtime: 'python3-ml',
      code: 'print("noop")',
      // A required file output AND a writable dir root (not required to be filled).
      workspace: { inputs: ['/data/'], outputs: ['/out.csv', '/scratch/'] },
      env: { OUT_REL: 'out.csv', OUT_CONTENT: 'a,b\n1,2' },
    };
    const { ctx, captured } = makeCtx(input, 'step-produced-out' as StepExecutionId);

    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    const flush = captured()!['workspaceFlush'] as {
      missingOutputs: string[];
      committed: Array<{ path: string }>;
    };
    expect(flush.missingOutputs).toEqual([]); // file produced; /scratch/ not required
    expect(flush.committed.map((c) => c.path)).toEqual(['/out.csv']);
  });
});
