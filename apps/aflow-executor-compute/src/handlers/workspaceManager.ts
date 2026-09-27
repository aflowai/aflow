import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, readdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDocRepository,
  createTenantContext,
  canonicalizePath,
  type MemoryDocRepository,
} from '@aflow/database';
import {
  type WorkspaceManifest,
  type WorkspaceManifestEntry,
  type WorkspaceManifestScope,
  setWorkspaceManifest,
  getWorkspaceManifest,
  deleteWorkspaceManifest,
} from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { ExecutorLogger } from '@aflow/executor-runtime';
import { isBinaryContent, writeMemoryDoc, type WriteMemoryDocParams } from '@aflow/memory-store';
import type { TenantId, SessionId, StepExecutionId } from '@aflow/schemas';

import { sandboxScratchDir } from './sandboxHostDir.js';

/**
 * chmod that tolerates ONLY a vanished target (ENOENT) — a concurrent exec may
 * have reaped the ephemeral scratch path between create and chmod. Any other
 * failure (EACCES, EROFS, EPERM) is rethrown: silently swallowing it would
 * leave the dir/file root-owned and non-writable by the sandbox uid, recreating
 * the exact PermissionError this code exists to prevent — fail loud, not quiet.
 */
async function chmodIgnoreMissing(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface WorkspaceQuotas {
  /** Total bytes cap (default 1 GiB). */
  maxBytes: number;
  /** Per-file bytes cap (default 256 MiB). */
  maxFileBytes: number;
  /** File count cap (default 10000). */
  maxFileCount: number;
}

export const DEFAULT_WORKSPACE_QUOTAS: WorkspaceQuotas = {
  maxBytes: 1_073_741_824,
  maxFileBytes: 268_435_456,
  maxFileCount: 10_000,
};

export interface WorkspaceInstanceScope {
  stepExecutionId: StepExecutionId;
  attempt: number;
}

export interface HydrateInput {
  tenantId: TenantId;
  runId: SessionId;
  spaceId: string;
  inputs: string[];
  outputs?: string[];
  quotas?: WorkspaceQuotas;
  /** TTL for the Redis manifest entry (typically aligned with checkpointTtlSeconds). */
  manifestTtlSeconds?: number;
  scope?: WorkspaceInstanceScope;
}

export interface HydrateResult {
  hostDir: string;
  hydratedPathsCount: number;
  /** The Memory paths actually materialized into /workspace/ (§4.F visibility). */
  hydratedPaths: string[];
  bytesUsed: number;
  manifest: WorkspaceManifest;
}

export interface RefreshInput {
  tenantId: TenantId;
  runId: SessionId;
  spaceId: string;
  /** The live workspace host dir (the bind-mounted /workspace/). */
  hostDir: string;
  inputs: string[];
  outputs?: string[];
  quotas?: WorkspaceQuotas;
  scope?: WorkspaceInstanceScope;
}

export interface RefreshResult {
  /** Memory paths newly materialized into the live workspace this call. */
  added: string[];
}

export interface FlushInput {
  tenantId: TenantId;
  runId: SessionId;
  spaceId: string;
  hostDir: string;
  /** Reason for the flush — used in structured logs. */
  reason: 'session-end' | 'idle' | 'commit' | 'exec-end';
  quotas?: WorkspaceQuotas;
  scope?: WorkspaceInstanceScope;
}

export interface FlushResult {
  committed: Array<{ path: string; newMemoryVersion: number; sizeBytes: number }>;
  conflicts: Array<{
    path: string;
    hydratedAtVersion: number;
    currentVersion: number;
    localContentHash: string;
    sidecarPath?: string;
  }>;
  skipped: Array<{
    path: string;
    sizeBytes: number;
    reason: 'too_large' | 'workspace_quota_exceeded' | 'unreadable';
  }>;
  pendingDeletes: string[];
  bytesFlushed: number;
}

export interface WorkspaceStatus {
  hydratedPathsCount: number;
  bytesUsed: number;
  dirtyPathsCount: number;
  pendingDeletesCount: number;
  lastFlushedAt: string | null;
}

// ============================================================================

export type WorkspaceErrorCode =
  | 'WORKSPACE_NOT_HYDRATED'
  | 'WORKSPACE_QUOTA_EXCEEDED'
  | 'WORKSPACE_FILE_TOO_LARGE'
  | 'WORKSPACE_FILE_COUNT_EXCEEDED'
  | 'WORKSPACE_INVALID_WORKING_SET'
  | 'WORKSPACE_DB_UNAVAILABLE';

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

// ============================================================================
// Manager
// ============================================================================

export interface WorkspaceManagerOptions {
  log: ExecutorLogger;
  /** Required for MemoryDocRepository access. */
  db: PostgresJsDatabase | undefined;
  redis: Redis;
  payloadStore: PayloadStore;
  /**
   * Optional repository factory override (tests). When provided, this is used
   * in place of the default `createMemoryDocRepository(db, ...)` lookup. In
   * production this is left unset and `db` drives repo construction.
   */
  repoFactory?: (tenantId: TenantId) => MemoryDocRepository;
}

export class WorkspaceManager {
  private readonly log: ExecutorLogger;
  private readonly db: PostgresJsDatabase | undefined;
  private readonly redis: Redis;
  private readonly payloadStore: PayloadStore;
  private readonly repoFactoryOverride?: (tenantId: TenantId) => MemoryDocRepository;

  constructor(opts: WorkspaceManagerOptions) {
    this.log = opts.log;
    this.db = opts.db;
    this.redis = opts.redis;
    this.payloadStore = opts.payloadStore;
    if (opts.repoFactory) {
      this.repoFactoryOverride = opts.repoFactory;
    }
  }

  // ==========================================================================
  // Hydrate: pull workingSet from Memory, materialize on disk, persist manifest
  // ==========================================================================

  async hydrate(input: HydrateInput): Promise<HydrateResult> {
    const quotas = input.quotas ?? DEFAULT_WORKSPACE_QUOTAS;
    const outputs = input.outputs ?? [];
    if (input.inputs.length === 0 && outputs.length === 0) {
      throw new WorkspaceError(
        'WORKSPACE_INVALID_WORKING_SET',
        'workspace requires file intent — declare inputs (paths/prefixes to read) and/or outputs.',
      );
    }

    const repo = this.repoFor(input.tenantId);
    // Bind-mounted at /workspace/ — MUST live under the shared sandbox base dir
    // so the path resolves identically in the executor and the host Docker daemon
    // (see sandboxHostDir.ts for the DinD invariant).
    const hostDir = sandboxScratchDir(`phoenix-workspace-${randomUUID().slice(0, 12)}`);
    await mkdir(hostDir, { recursive: true });
    // Container runs as 1000:1000 — give it write access to the bind-mount.
    await chmod(hostDir, 0o777);

    const startMs = Date.now();
    const files: Record<string, WorkspaceManifestEntry> = {};
    let bytesUsed = 0;
    let fileCount = 0;
    const skipped: Array<{ path: string; reason: string }> = [];

    try {
      // Hydrate inputs AND any declared outputs that already exist in Memory, so
      // overwriting an existing output is a clean CAS update (not a false
      // unhydrated-overwrite conflict). Dedupe by memory path.
      const seen = new Set<string>();
      for (const entry of [...input.inputs, ...outputs]) {
        const docs = await this.expandWorkingSetEntry(repo, entry, input.spaceId);
        for (const doc of docs) {
          if (seen.has(doc.path)) continue;
          seen.add(doc.path);
          // Per-file cap (D8)
          if (doc.sizeBytes > quotas.maxFileBytes) {
            throw new WorkspaceError(
              'WORKSPACE_FILE_TOO_LARGE',
              `Memory doc ${doc.path} is ${String(doc.sizeBytes)} bytes; per-file cap is ${String(quotas.maxFileBytes)}.`,
              { path: doc.path, sizeBytes: doc.sizeBytes, cap: quotas.maxFileBytes },
            );
          }
          // Total bytes cap (D8)
          if (bytesUsed + doc.sizeBytes > quotas.maxBytes) {
            throw new WorkspaceError(
              'WORKSPACE_QUOTA_EXCEEDED',
              `Workspace would exceed ${String(quotas.maxBytes)} bytes; consider narrowing inputs.`,
              { bytesUsed, attempt: doc.sizeBytes, cap: quotas.maxBytes },
            );
          }
          // File count cap (D8)
          if (fileCount + 1 > quotas.maxFileCount) {
            throw new WorkspaceError(
              'WORKSPACE_FILE_COUNT_EXCEEDED',
              `Workspace would exceed ${String(quotas.maxFileCount)} files.`,
              { fileCount, cap: quotas.maxFileCount },
            );
          }

          const bytes = await this.readDocBytes(repo, doc, input.spaceId);
          if (bytes === null) {
            skipped.push({ path: doc.path, reason: 'unreadable' });
            continue;
          }

          // Materialize on disk (binary-safe)
          await this.writeWorkspaceFile(hostDir, doc.path, bytes);

          const contentHash = sha256Bytes(bytes);
          const sizeBytes = bytes.length;
          files[doc.path] = {
            memoryDocId: doc.id,
            memoryVersionAtHydrate: doc.currentVersion,
            contentHashAtHydrate: contentHash,
            mtimeAtFlush: null,
            sizeBytes,
          };
          bytesUsed += sizeBytes;
          fileCount += 1;
        }
      }

      // §4.F output-root creation: ensure each declared output's directory
      // exists in /workspace/ so code can write even when Memory has nothing
      // there yet (created empty — not a conflict).
      await this.createOutputDirs(hostDir, outputs);

      const manifest: WorkspaceManifest = {
        scope: input.scope
          ? {
              kind: 'step',
              tenantId: input.tenantId,
              runId: input.runId,
              spaceId: input.spaceId,
              stepExecutionId: input.scope.stepExecutionId,
              attempt: input.scope.attempt,
            }
          : {
              kind: 'run',
              tenantId: input.tenantId,
              runId: input.runId,
              spaceId: input.spaceId,
            },
        hydratedAt: new Date().toISOString(),
        lastFlushedAt: null,
        inputs: [...input.inputs],
        outputs: [...outputs],
        files,
        pendingDeletes: [],
        bytesUsed,
      };

      await setWorkspaceManifest(this.redis, manifest, input.manifestTtlSeconds);

      this.log.info('Workspace hydrated', {
        tenantId: input.tenantId,
        runId: input.runId,
        spaceId: input.spaceId,
        inputsCount: input.inputs.length,
        outputsCount: outputs.length,
        hydratedPathsCount: fileCount,
        bytesUsed,
        skippedCount: skipped.length,
        durationMs: Date.now() - startMs,
      });
      if (skipped.length > 0) {
        this.log.debug('Workspace hydrate skipped some docs', {
          tenantId: input.tenantId,
          runId: input.runId,
          skipped,
        });
      }

      return {
        hostDir,
        hydratedPathsCount: fileCount,
        hydratedPaths: Object.keys(files),
        bytesUsed,
        manifest,
      };
    } catch (err) {
      // Roll back: hydrate failed → clean up the host dir; do not leave a
      // partial workspace on disk or a partial manifest in Redis.
      await rm(hostDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  // ==========================================================================
  // Refresh: add newly-declared inputs/outputs into an already-live workspace
  // ==========================================================================

  async refresh(input: RefreshInput): Promise<RefreshResult> {
    const quotas = input.quotas ?? DEFAULT_WORKSPACE_QUOTAS;
    const outputs = input.outputs ?? [];
    const manifest = await getWorkspaceManifest(
      this.redis,
      this.keyScope(input.tenantId, input.runId, input.scope),
    );
    if (!manifest) {
      throw new WorkspaceError(
        'WORKSPACE_NOT_HYDRATED',
        'refresh requires an already-hydrated workspace; none found for this run.',
      );
    }

    const repo = this.repoFor(input.tenantId);
    const files: Record<string, WorkspaceManifestEntry> = { ...manifest.files };
    let bytesUsed = manifest.bytesUsed;
    let fileCount = Object.keys(files).length;
    // Already-present paths are skipped (add-only).
    const seen = new Set<string>(Object.keys(files));

    // Preflight (no disk writes): expand, read, and quota-check every candidate,
    // and validate the output-dir paths, BEFORE touching the live workspace.
    // refresh is atomic — a later quota or output-path failure must not leave
    // half-written, manifest-untracked files on disk (they would surface as
    // spurious create-if-absent conflicts at the next flush).
    const pending: Array<{
      doc: { id: string; path: string; currentVersion: number };
      bytes: Buffer;
    }> = [];
    for (const entry of [...input.inputs, ...outputs]) {
      const docs = await this.expandWorkingSetEntry(repo, entry, input.spaceId);
      for (const doc of docs) {
        if (seen.has(doc.path)) continue;
        seen.add(doc.path);
        if (doc.sizeBytes > quotas.maxFileBytes) {
          throw new WorkspaceError(
            'WORKSPACE_FILE_TOO_LARGE',
            `Memory doc ${doc.path} is ${String(doc.sizeBytes)} bytes; per-file cap is ${String(quotas.maxFileBytes)}.`,
            { path: doc.path, sizeBytes: doc.sizeBytes, cap: quotas.maxFileBytes },
          );
        }
        if (bytesUsed + doc.sizeBytes > quotas.maxBytes) {
          throw new WorkspaceError(
            'WORKSPACE_QUOTA_EXCEEDED',
            `Workspace would exceed ${String(quotas.maxBytes)} bytes; narrow the inputs you add.`,
            { bytesUsed, attempt: doc.sizeBytes, cap: quotas.maxBytes },
          );
        }
        if (fileCount + 1 > quotas.maxFileCount) {
          throw new WorkspaceError(
            'WORKSPACE_FILE_COUNT_EXCEEDED',
            `Workspace would exceed ${String(quotas.maxFileCount)} files.`,
            { fileCount, cap: quotas.maxFileCount },
          );
        }
        const bytes = await this.readDocBytes(repo, doc, input.spaceId);
        if (bytes === null) continue; // unreadable — skip, like hydrate
        bytesUsed += bytes.length;
        fileCount += 1;
        pending.push({ doc, bytes });
      }
    }
    this.assertOutputPathsWithinRoot(input.hostDir, outputs);

    // Commit: every check passed — now write to the live workspace.
    const added: string[] = [];
    for (const { doc, bytes } of pending) {
      await this.writeWorkspaceFile(input.hostDir, doc.path, bytes);
      files[doc.path] = {
        memoryDocId: doc.id,
        memoryVersionAtHydrate: doc.currentVersion,
        contentHashAtHydrate: sha256Bytes(bytes),
        mtimeAtFlush: null,
        sizeBytes: bytes.length,
      };
      added.push(doc.path);
    }

    // Pre-create any newly-declared output dirs (empty, not a conflict).
    await this.createOutputDirs(input.hostDir, outputs);

    const updated: WorkspaceManifest = {
      ...manifest,
      inputs: [...new Set([...manifest.inputs, ...input.inputs])],
      outputs: [...new Set([...manifest.outputs, ...outputs])],
      files,
      bytesUsed,
    };
    await setWorkspaceManifest(this.redis, updated);

    if (added.length > 0) {
      this.log.info('Workspace refreshed (auto-merged new paths)', {
        tenantId: input.tenantId,
        runId: input.runId,
        spaceId: input.spaceId,
        added,
      });
    }
    return { added };
  }

  // ==========================================================================
  // Flush: compare workspace against manifest, publish dirty files to Memory
  // ==========================================================================

  /**
   * Flush dirty files to Memory using compare-and-set on the hydrated version.
   * Quota errors abort atomically (no partial publish). Conflicts are returned
   * per-path; non-conflicting dirty files are still published.
   */
  async flush(input: FlushInput): Promise<FlushResult> {
    const manifest = await getWorkspaceManifest(
      this.redis,
      this.keyScope(input.tenantId, input.runId, input.scope),
    );
    if (!manifest) {
      this.log.warn('Workspace flush: no manifest found, nothing to flush', {
        tenantId: input.tenantId,
        runId: input.runId,
      });
      return {
        committed: [],
        conflicts: [],
        skipped: [],
        pendingDeletes: [],
        bytesFlushed: 0,
      };
    }

    const startMs = Date.now();
    const quotas = input.quotas ?? DEFAULT_WORKSPACE_QUOTAS;
    const repo = this.repoFor(input.tenantId);

    const scan = await this.scanWorkspaceSizes(input.hostDir, quotas);

    // Pass 2: read bytes for survivors; compute byte hash; diff against manifest.
    interface Dirty {
      path: string;
      bytes: Buffer;
      isBinary: boolean;
      contentHash: string;
      sizeBytes: number;
      hydratedEntry?: WorkspaceManifestEntry;
    }
    const dirty: Dirty[] = [];
    const stillPresent = new Set<string>();
    const skipped: FlushResult['skipped'] = [...scan.skipped];

    for (const file of scan.survivors) {
      stillPresent.add(file.memoryPath);
      let bytes: Buffer;
      try {
        bytes = await readFile(file.absPath);
      } catch {
        // Genuinely unreadable (IO error) — skip from publish. The corresponding
        // manifest entry (if any) stays unchanged so the prior version remains.
        skipped.push({
          path: file.memoryPath,
          sizeBytes: file.sizeBytes,
          reason: 'unreadable',
        });
        continue;
      }
      const contentHash = sha256Bytes(bytes);
      const hydrated = manifest.files[file.memoryPath];
      const isDirty = hydrated?.contentHashAtHydrate !== contentHash;
      if (isDirty) {
        dirty.push({
          path: file.memoryPath,
          bytes,
          // §4.D/§4.F: non-UTF-8 bytes OR a known-binary extension → binary, so a
          // binary artifact that happens to decode as UTF-8 isn't indexed as text.
          isBinary: isBinaryContent(bytes, file.memoryPath),
          contentHash,
          sizeBytes: bytes.length,
          ...(hydrated ? { hydratedEntry: hydrated } : {}),
        });
      }
    }

    // Files that were hydrated but no longer on disk → pending deletes
    const newPendingDeletes = new Set(manifest.pendingDeletes);
    for (const memPath of Object.keys(manifest.files)) {
      if (!stillPresent.has(memPath) && !scan.oversizePaths.has(memPath)) {
        newPendingDeletes.add(memPath);
      }
    }

    // Apply CAS publish per dirty file. Conflicts → write a sidecar Memory doc
    const committed: FlushResult['committed'] = [];
    const conflicts: FlushResult['conflicts'] = [];
    const updatedFiles: Record<string, WorkspaceManifestEntry> = { ...manifest.files };

    for (const d of dirty) {
      try {
        const memDoc = await this.publishDirty(repo, input.tenantId, input.runId, input.spaceId, d);
        committed.push({
          path: d.path,
          newMemoryVersion: memDoc.currentVersion,
          sizeBytes: d.sizeBytes,
        });
        updatedFiles[d.path] = {
          memoryDocId: memDoc.id,
          memoryVersionAtHydrate: memDoc.currentVersion,
          contentHashAtHydrate: d.contentHash,
          mtimeAtFlush: Date.now(),
          sizeBytes: d.sizeBytes,
        };
      } catch (err) {
        if (err instanceof MemoryConflictError) {
          // C2: rescue the local content to a sidecar path so it survives
          // workspace teardown. The sidecar is a fresh Memory doc; no CAS
          // collision possible because the path is timestamp-suffixed.
          const sidecarPath = await this.publishConflictSidecar(
            repo,
            input.tenantId,
            input.runId,
            input.spaceId,
            d,
          );
          conflicts.push({
            path: d.path,
            hydratedAtVersion: d.hydratedEntry?.memoryVersionAtHydrate ?? 0,
            currentVersion: err.currentVersion,
            localContentHash: d.contentHash,
            ...(sidecarPath ? { sidecarPath } : {}),
          });
          continue;
        }
        throw err;
      }
    }

    const newBytesUsed = Object.values(updatedFiles).reduce((sum, e) => sum + e.sizeBytes, 0);

    const updatedManifest: WorkspaceManifest = {
      ...manifest,
      lastFlushedAt: new Date().toISOString(),
      files: updatedFiles,
      pendingDeletes: [...newPendingDeletes],
      bytesUsed: newBytesUsed,
    };
    await setWorkspaceManifest(this.redis, updatedManifest);

    const bytesFlushed = committed.reduce((sum, c) => {
      const entry = updatedManifest.files[c.path];
      return sum + (entry?.sizeBytes ?? 0);
    }, 0);

    if (skipped.length > 0) {
      // Loud warning so operators / agents notice files dropped at flush time.
      this.log.warn('Workspace flush skipped some files', {
        tenantId: input.tenantId,
        runId: input.runId,
        spaceId: input.spaceId,
        skipped,
      });
    }

    this.log.info('Workspace flushed', {
      tenantId: input.tenantId,
      runId: input.runId,
      spaceId: input.spaceId,
      reason: input.reason,
      dirtyCount: dirty.length,
      committedCount: committed.length,
      conflictCount: conflicts.length,
      skippedCount: skipped.length,
      pendingDeletesCount: newPendingDeletes.size,
      bytesFlushed,
      durationMs: Date.now() - startMs,
    });

    return {
      committed,
      conflicts,
      skipped,
      pendingDeletes: [...newPendingDeletes],
      bytesFlushed,
    };
  }

  // ==========================================================================
  // Status: read-only manifest summary for sessionInfo output
  // ==========================================================================

  async getStatus(
    tenantId: TenantId,
    runId: SessionId,
    scope?: WorkspaceInstanceScope,
  ): Promise<WorkspaceStatus | null> {
    const manifest = await getWorkspaceManifest(this.redis, this.keyScope(tenantId, runId, scope));
    if (!manifest) return null;
    // dirtyPathsCount is computed lazily — the host dir isn't touched here
    // (we don't have its path), so we approximate as the count of files
    // whose mtimeAtFlush is null since hydrate. Phase 2 may surface an
    // exact count by walking the host dir on demand.
    const dirtyPathsCount = Object.values(manifest.files).filter(
      (e) => e.mtimeAtFlush === null,
    ).length;
    return {
      hydratedPathsCount: Object.keys(manifest.files).length,
      bytesUsed: manifest.bytesUsed,
      dirtyPathsCount,
      pendingDeletesCount: manifest.pendingDeletes.length,
      lastFlushedAt: manifest.lastFlushedAt,
    };
  }

  // ==========================================================================
  // Release: tear down host dir + manifest
  // ==========================================================================

  async release(
    tenantId: TenantId,
    runId: SessionId,
    hostDir: string | undefined,
    scope?: WorkspaceInstanceScope,
  ): Promise<void> {
    if (hostDir) {
      await rm(hostDir, { recursive: true, force: true }).catch(() => {});
    }
    await deleteWorkspaceManifest(this.redis, this.keyScope(tenantId, runId, scope)).catch(
      () => {},
    );
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private keyScope(
    tenantId: TenantId,
    runId: SessionId,
    scope?: WorkspaceInstanceScope,
  ): WorkspaceManifestScope {
    if (scope) {
      return { tenantId, runId, stepExecutionId: scope.stepExecutionId, attempt: scope.attempt };
    }
    return { tenantId, runId };
  }

  private repoFor(tenantId: TenantId): MemoryDocRepository {
    if (this.repoFactoryOverride) {
      return this.repoFactoryOverride(tenantId);
    }
    if (!this.db) {
      throw new WorkspaceError('WORKSPACE_DB_UNAVAILABLE', 'Database not available.');
    }
    return createMemoryDocRepository(this.db, createTenantContext(tenantId));
  }

  /**
   * Expand a workingSet entry to a list of MemoryDocs.
   * Trailing '/' → list under prefix. Otherwise → getByPath (single doc).
   */
  private async expandWorkingSetEntry(
    repo: MemoryDocRepository,
    entry: string,
    spaceId: string,
  ): Promise<Array<{ id: string; path: string; sizeBytes: number; currentVersion: number }>> {
    const canonical = canonicalizePath(entry);
    if (entry.endsWith('/') || canonical === '/') {
      // Prefix listing
      const docs = await repo.list({
        pathPrefix: canonical,
        scope: { spaceId },
        limit: 5000,
      });
      // list() returns a query result — fetch full docs to get currentVersion + size
      const full = await Promise.all(
        docs.map(async (d) => {
          const doc = await repo.getByPath(d.path, spaceId);
          return doc
            ? {
                id: doc.id,
                path: doc.path,
                sizeBytes: doc.sizeBytes,
                currentVersion: doc.currentVersion,
              }
            : null;
        }),
      );
      return full.filter((d): d is NonNullable<typeof d> => d !== null);
    }
    const doc = await repo.getByPath(canonical, spaceId);
    if (!doc) return [];
    return [
      {
        id: doc.id,
        path: doc.path,
        sizeBytes: doc.sizeBytes,
        currentVersion: doc.currentVersion,
      },
    ];
  }

  private async readDocBytes(
    repo: MemoryDocRepository,
    doc: { path: string; id: string },
    spaceId: string,
  ): Promise<Buffer | null> {
    const fullDoc = await repo.getById(doc.id, spaceId);
    if (!fullDoc) return null;
    if (fullDoc.inlineContent !== null) {
      return Buffer.from(fullDoc.inlineContent, 'utf-8');
    }
    if (fullDoc.payloadRef) {
      try {
        if (isBytesPayloadRef(fullDoc.payloadRef)) {
          return await this.payloadStore.retrieveBytes(fullDoc.payloadRef);
        }
        const payload = await this.payloadStore.retrieve(fullDoc.payloadRef);
        return Buffer.from(
          typeof payload === 'string' ? payload : JSON.stringify(payload),
          'utf-8',
        );
      } catch (err) {
        this.log.warn('Workspace hydrate: failed to retrieve payload', {
          path: fullDoc.path,
          payloadRef: fullDoc.payloadRef,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
    return null;
  }

  /**
   * Create a directory under hostDir and make every segment we touch
   * world-writable (0o777). The worker container runs the executor as root, but
   * sandboxes run as uid 1000:1000 (containerRunner `--user`); a dir created
   * here with the default umask (0o755, root-owned) is UNWRITABLE inside the
   * sandbox, so the agent cannot create new files in a hydrated dir — e.g.
   * writing submission.csv into the hydrated /data/ dir, the canonical Kaggle
   * pattern (inputs + output share a dir). hostDir itself is already chmod 0o777
   * at hydrate; this extends that to every nested dir. Bind mounts preserve host
   * perms, so 0o777 on the host = writable inside the sandbox.
   */
  private async mkdirWorldWritable(hostDir: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    const rel = relative(hostDir, targetDir);
    if (rel.length === 0 || rel.startsWith('..')) return;
    let current = hostDir;
    for (const segment of rel.split(sep)) {
      if (segment.length === 0) continue;
      current = join(current, segment);
      await chmodIgnoreMissing(current, 0o777);
    }
  }

  /**
   * Write a single workspace file at hostDir/<memoryPathWithoutLeadingSlash>.
   * Creates parent directories. Path validation: memoryPath is canonical (starts
   * with /), no '..' segments survive canonicalization.
   */
  private async writeWorkspaceFile(
    hostDir: string,
    memoryPath: string,
    content: Buffer,
  ): Promise<void> {
    const rel = memoryPath.startsWith('/') ? memoryPath.slice(1) : memoryPath;
    if (rel.length === 0) {
      throw new WorkspaceError(
        'WORKSPACE_INVALID_WORKING_SET',
        `Memory path "${memoryPath}" maps to the workspace root`,
      );
    }
    const fullPath = join(hostDir, rel);
    if (!fullPath.startsWith(hostDir + '/') && fullPath !== hostDir) {
      // Defense in depth: refuse anything that escapes hostDir.
      throw new WorkspaceError(
        'WORKSPACE_INVALID_WORKING_SET',
        `Memory path "${memoryPath}" escapes the workspace root`,
      );
    }
    await this.mkdirWorldWritable(hostDir, dirname(fullPath));
    await writeFile(fullPath, content);
    // Hydrated files are root-owned (executor runs as root); make them writable
    // by the sandbox uid so a re-hydrated declared output can be overwritten.
    await chmodIgnoreMissing(fullPath, 0o666);
  }

  private async createOutputDirs(hostDir: string, outputs: string[]): Promise<void> {
    this.assertOutputPathsWithinRoot(hostDir, outputs);
    for (const out of outputs) {
      const rel = out.startsWith('/') ? out.slice(1) : out;
      if (rel.length === 0) continue;
      const full = join(hostDir, rel);
      const dir = out.endsWith('/') ? full : dirname(full);
      await this.mkdirWorldWritable(hostDir, dir);
    }
  }

  /**
   * Validate (without creating) that each declared output stays within the
   * workspace root. Split out of createOutputDirs so refresh() can run this
   * escape check during its preflight — before any file is written — keeping
   * the auto-merge atomic on a bad output path.
   */
  private assertOutputPathsWithinRoot(hostDir: string, outputs: string[]): void {
    for (const out of outputs) {
      const rel = out.startsWith('/') ? out.slice(1) : out;
      if (rel.length === 0) continue;
      const full = join(hostDir, rel);
      if (!full.startsWith(hostDir + '/') && full !== hostDir) {
        throw new WorkspaceError(
          'WORKSPACE_INVALID_WORKING_SET',
          `output path "${out}" escapes the workspace root`,
        );
      }
    }
  }

  private async scanWorkspaceSizes(
    hostDir: string,
    quotas: WorkspaceQuotas,
  ): Promise<{
    survivors: Array<{ memoryPath: string; absPath: string; sizeBytes: number }>;
    skipped: FlushResult['skipped'];
    oversizePaths: Set<string>;
  }> {
    const survivors: Array<{ memoryPath: string; absPath: string; sizeBytes: number }> = [];
    const skipped: FlushResult['skipped'] = [];
    const oversizePaths = new Set<string>();

    const walk = async (dir: string, relPrefix: string): Promise<void> => {
      let entries: Array<{ name: string; rel: string; full: string; stats: Stats }>;
      try {
        const dirEntries = await readdir(dir, { withFileTypes: true });
        entries = await Promise.all(
          dirEntries.map(async (e) => {
            const full = join(dir, e.name);
            const rel = relPrefix === '' ? e.name : `${relPrefix}/${e.name}`;
            const stats = await lstat(full);
            return { name: e.name, rel, full, stats };
          }),
        );
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.stats.isSymbolicLink()) continue; // defense: skip symlinks
        if (e.stats.isDirectory()) {
          await walk(e.full, e.rel);
          continue;
        }
        if (!e.stats.isFile()) continue;
        const memoryPath = '/' + e.rel;
        const sizeBytes = e.stats.size;
        if (sizeBytes > quotas.maxFileBytes) {
          skipped.push({ path: memoryPath, sizeBytes, reason: 'too_large' });
          oversizePaths.add(memoryPath);
          continue;
        }
        survivors.push({ memoryPath, absPath: e.full, sizeBytes });
      }
    };
    await walk(hostDir, '');

    // Per-file cap applied above. Now enforce file-count and total-bytes caps
    // by sorting and truncating. The sort makes the truncation deterministic.
    survivors.sort((a, b) => a.memoryPath.localeCompare(b.memoryPath));

    const final: typeof survivors = [];
    let runningBytes = 0;
    let runningCount = 0;
    for (const s of survivors) {
      if (runningCount + 1 > quotas.maxFileCount) {
        skipped.push({
          path: s.memoryPath,
          sizeBytes: s.sizeBytes,
          reason: 'workspace_quota_exceeded',
        });
        continue;
      }
      if (runningBytes + s.sizeBytes > quotas.maxBytes) {
        skipped.push({
          path: s.memoryPath,
          sizeBytes: s.sizeBytes,
          reason: 'workspace_quota_exceeded',
        });
        continue;
      }
      final.push(s);
      runningBytes += s.sizeBytes;
      runningCount += 1;
    }
    return { survivors: final, skipped, oversizePaths };
  }

  /**
   * Build `writeMemoryDoc` params for a flushed file. Content is handed raw
   * (text or bytes) so the single derivation authority owns payload routing,
   * hashing, preview, and index derivation. Text → inferred docType/mimeType +
   * 'auto' indexing; binary → docType 'binary' + inferred mime (writeMemoryDoc
   * forces indexing disabled for binary).
   */
  private buildFlushWriteParams(
    repo: MemoryDocRepository,
    tenantId: TenantId,
    runId: SessionId,
    spaceId: string,
    path: string,
    dirty: { bytes: Buffer; isBinary: boolean },
    extra: {
      tags: string[];
      summary: string | null;
      writeMode: 'upsert' | 'create';
      expectedHash?: string;
    },
  ): WriteMemoryDocParams {
    const common = {
      repo,
      payloadStore: this.payloadStore,
      redis: this.redis,
      log: this.log,
      tenantId,
      origin: { kind: 'run' as const, runId },
      spaceId,
      path,
      tags: extra.tags,
      summary: extra.summary,
      writeMode: extra.writeMode,
      ...(extra.expectedHash ? { expectedHash: extra.expectedHash } : {}),
    };

    if (dirty.isBinary) {
      return {
        ...common,
        content: { kind: 'binary', bytes: dirty.bytes },
        docType: 'binary',
        mimeType: inferBinaryMimeType(path),
        indexing: 'disabled',
      };
    }

    return {
      ...common,
      content: { kind: 'text', text: dirty.bytes.toString('utf-8') },
      docType: inferDocType(path),
      mimeType: inferMimeType(path),
      indexing: 'auto',
    };
  }

  private async publishConflictSidecar(
    repo: MemoryDocRepository,
    tenantId: TenantId,
    runId: SessionId,
    spaceId: string,
    dirty: {
      path: string;
      bytes: Buffer;
      isBinary: boolean;
      contentHash: string;
      sizeBytes: number;
    },
  ): Promise<string | undefined> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sidecarPath = `${dirty.path}.conflict-${stamp}`;
    try {
      await writeMemoryDoc(
        this.buildFlushWriteParams(repo, tenantId, runId, spaceId, sidecarPath, dirty, {
          tags: ['workspace_conflict'],
          summary: `Workspace flush conflict on ${dirty.path}: rescued local edit at ${sidecarPath}`,
          // 'create' so a colliding sidecar (very unlikely with ISO timestamp)
          // surfaces as an error rather than silently overwriting.
          writeMode: 'create',
        }),
      );
      this.log.info('Workspace conflict rescued to sidecar', {
        path: dirty.path,
        sidecarPath,
        sizeBytes: dirty.sizeBytes,
      });
      return sidecarPath;
    } catch (err: unknown) {
      this.log.error('Failed to write workspace conflict sidecar', {
        path: dirty.path,
        sidecarPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Publish a single dirty file to Memory using compare-and-set against the
   * hydrated version's contentHash. Throws MemoryConflictError if Memory has
   * moved on. Falls back to PayloadStore for content > 64 KiB.
   */
  private async publishDirty(
    repo: MemoryDocRepository,
    tenantId: TenantId,
    runId: SessionId,
    spaceId: string,
    dirty: {
      path: string;
      bytes: Buffer;
      isBinary: boolean;
      contentHash: string;
      sizeBytes: number;
      hydratedEntry?: WorkspaceManifestEntry;
    },
  ): Promise<{ id: string; currentVersion: number }> {
    // Re-read current Memory state to detect external version drift.
    // (repo.put already does its own expectedHash check, but we want a clean
    // structured error before the put runs so we can surface a precise
    // {hydratedAtVersion, currentVersion} pair.)
    const current = await repo.getByPath(dirty.path, spaceId);

    if (dirty.hydratedEntry) {
      const expectedVersion = dirty.hydratedEntry.memoryVersionAtHydrate;
      if (current && current.currentVersion !== expectedVersion) {
        throw new MemoryConflictError(current.currentVersion);
      }
      // current may be null if doc was deleted externally — treat as conflict
      if (!current && expectedVersion > 0) {
        throw new MemoryConflictError(0);
      }
    } else if (current) {
      throw new MemoryConflictError(current.currentVersion);
    }

    // §4.D: text → inline/JSON-lane with preview+index; binary → raw bytes via
    // storeBytes, no preview, no index. Routed through the single derivation
    // authority so a flushed authored markdown/text file populates its link +
    // property indexes exactly like an executor put.
    let written: { id: string; currentVersion: number };
    try {
      const result = await writeMemoryDoc(
        this.buildFlushWriteParams(repo, tenantId, runId, spaceId, dirty.path, dirty, {
          tags: [],
          summary: null,
          writeMode: dirty.hydratedEntry ? 'upsert' : 'create',
          ...(dirty.hydratedEntry?.contentHashAtHydrate
            ? { expectedHash: dirty.hydratedEntry.contentHashAtHydrate }
            : {}),
        }),
      );
      written = { id: result.doc.id, currentVersion: result.doc.currentVersion };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('MEMORY_ALREADY_EXISTS') || msg.includes('MEMORY_HASH_MISMATCH')) {
        const latest = await repo.getByPath(dirty.path, spaceId).catch(() => null);
        throw new MemoryConflictError(latest?.currentVersion ?? 0);
      }
      throw err;
    }

    return { id: written.id, currentVersion: written.currentVersion };
  }
}

// ============================================================================
// Internal: typed conflict signal (caught by flush loop)
// ============================================================================

class MemoryConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super('memory_version_drift');
    this.name = 'MemoryConflictError';
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isBytesPayloadRef(ref: string): boolean {
  return ref.endsWith('.bin');
}

function inferDocType(path: string): string {
  const ext = (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  if (ext === 'csv') return 'dataset';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'py' || ext === 'js' || ext === 'ts') return 'code';
  return 'text';
}

function inferMimeType(path: string): string {
  const ext = (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  if (ext === 'csv') return 'text/csv';
  if (ext === 'json') return 'application/json';
  if (ext === 'md') return 'text/markdown';
  return 'text/plain';
}

function inferBinaryMimeType(path: string): string {
  const ext = (/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'parquet':
      return 'application/vnd.apache.parquet';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'zip':
      return 'application/zip';
    case 'gz':
    case 'gzip':
      return 'application/gzip';
    case 'pdf':
      return 'application/pdf';
    case 'h5':
    case 'hdf5':
      return 'application/x-hdf5';
    default:
      return 'application/octet-stream';
  }
}
