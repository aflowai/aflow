import type { Redis } from 'ioredis';
import { z } from 'zod';

// ============================================================================
// Manifest schema
// ============================================================================

/** A single Memory document tracked in a hydrated workspace. */
export const WorkspaceManifestEntrySchema = z.object({
  /** Memory document ID at hydrate time. */
  memoryDocId: z.string(),
  /** Memory currentVersion at hydrate time — used for compare-and-set on flush. */
  memoryVersionAtHydrate: z.number().int().nonnegative(),
  /** sha256 of the content as it was hydrated. */
  contentHashAtHydrate: z.string(),
  /** Mtime of the workspace file at the most recent flush (ms epoch), or null pre-flush. */
  mtimeAtFlush: z.number().int().nullable(),
  /** Bytes hydrated (for quota accounting). */
  sizeBytes: z.number().int().nonnegative(),
});
export type WorkspaceManifestEntry = z.infer<typeof WorkspaceManifestEntrySchema>;

export const WorkspaceManifestScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    tenantId: z.string(),
    runId: z.string(),
    spaceId: z.string(),
  }),
  z.object({
    kind: z.literal('step'),
    tenantId: z.string(),
    runId: z.string(),
    spaceId: z.string(),
    stepExecutionId: z.string(),
    attempt: z.number().int().nonnegative(),
  }),
]);
export type WorkspaceManifestScopeValue = z.infer<typeof WorkspaceManifestScopeSchema>;

/**
 * Workspace manifest.
 */
export const WorkspaceManifestSchema = z.object({
  scope: WorkspaceManifestScopeSchema,
  hydratedAt: z.string().datetime(),
  lastFlushedAt: z.string().datetime().nullable(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  /** memoryPath → entry. Memory paths are 1:1 with /workspace/ paths. */
  files: z.record(WorkspaceManifestEntrySchema),
  /** Memory paths the agent rm-ed locally; awaiting an explicit delete-commit op. */
  pendingDeletes: z.array(z.string()),
  /** Running total bytes used by tracked files (for quota accounting). */
  bytesUsed: z.number().int().nonnegative(),
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

// ============================================================================
// Redis key + TTL
// ============================================================================

/** Default TTL for a workspace manifest (aligns with session checkpoint TTL). */
export const WORKSPACE_MANIFEST_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export interface WorkspaceManifestScope {
  tenantId: string;
  runId: string;
  stepExecutionId?: string | undefined;
  attempt?: number | undefined;
}

export function workspaceManifestKey(scope: WorkspaceManifestScope): string {
  const base = `compute:workspace:${scope.tenantId}:${scope.runId}`;
  if (scope.stepExecutionId !== undefined) {
    return `${base}:${scope.stepExecutionId}:${String(scope.attempt ?? 0)}`;
  }
  return base;
}

/** Derive the Redis-key scope from a manifest's own (discriminated) scope. */
function scopeFromManifest(manifest: WorkspaceManifest): WorkspaceManifestScope {
  const s = manifest.scope;
  if (s.kind === 'step') {
    return {
      tenantId: s.tenantId,
      runId: s.runId,
      stepExecutionId: s.stepExecutionId,
      attempt: s.attempt,
    };
  }
  return { tenantId: s.tenantId, runId: s.runId };
}

// ============================================================================
// Manifest CRUD
// ============================================================================

export async function setWorkspaceManifest(
  redis: Redis,
  manifest: WorkspaceManifest,
  ttlSeconds: number = WORKSPACE_MANIFEST_DEFAULT_TTL_SECONDS,
): Promise<void> {
  const key = workspaceManifestKey(scopeFromManifest(manifest));
  const serialized = JSON.stringify(manifest);
  await redis.set(key, serialized, 'EX', ttlSeconds);
}

export async function getWorkspaceManifest(
  redis: Redis,
  scope: WorkspaceManifestScope,
): Promise<WorkspaceManifest | null> {
  const key = workspaceManifestKey(scope);
  const raw = await redis.get(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return WorkspaceManifestSchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function deleteWorkspaceManifest(
  redis: Redis,
  scope: WorkspaceManifestScope,
): Promise<void> {
  const key = workspaceManifestKey(scope);
  await redis.del(key);
}
