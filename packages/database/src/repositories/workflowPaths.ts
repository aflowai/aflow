/**
 * Canonical workflow memory-doc paths and revision snapshotting.
 *
 * Single source of truth for where a workflow's latest definition and
 * its revision snapshots live, plus the canonical writer for revision
 * snapshots. Every reader and writer of workflow memory docs must go
 * through these helpers — divergent path schemes have caused active
 * runs to silently drift onto unintended workflow definitions
 * (see plan 113).
 */
import type { createMemoryDocRepository } from './memoryDocs.js';
import type { createMemoryDirRepository } from './memoryDirs.js';

const WORKFLOWS_ROOT = '/workflows';

export function workflowRoot(): string {
  return WORKFLOWS_ROOT;
}

export function workflowDirPath(slug: string): string {
  return `${WORKFLOWS_ROOT}/${slug}`;
}

export function workflowDocPath(slug: string): string {
  return `${WORKFLOWS_ROOT}/${slug}/workflow.json`;
}

export function workflowRevisionPath(slug: string, revision: number): string {
  return `${WORKFLOWS_ROOT}/${slug}/revisions/workflow-r${String(revision)}.json`;
}

// ============================================================================

/**
 * Workflow fields that are NOT part of the immutable run-execution contract.
 *
 * The snapshot at revision N freezes the *definition* the run executes
 * (tasks, outcomes, stateVariables, iteration, mode, etc.). Shell properties
 * — name, description, budget, status, agent assignments, timestamps — can
 * legitimately change in place at the same revision (they don't alter what
 * the run does), so the drift check ignores them.
 *
 * This mirrors `WORKFLOW_METADATA_PATH_PREFIXES` in workflowCrud's patch
 * handler, which is the rule that decides whether a patch bumps the
 * revision. Keep these two lists aligned.
 */
const WORKFLOW_METADATA_FIELDS = new Set<string>([
  'name',
  'description',
  'assignedAgent',
  'taskAssignments',
  'budget',
  'status',
  'createdAt',
  'updatedAt',
]);

function extractDefinitionEssence(workflow: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workflow)) {
    if (!WORKFLOW_METADATA_FIELDS.has(key)) result[key] = value;
  }
  return result;
}

/**
 * Thrown when a revision-N snapshot already exists with a *definition* that
 * does not match the in-memory workflow state at revision N. This means an
 * upstream invariant was violated — the same revision number cannot describe
 * two different workflow definitions. (Metadata-only differences — budget,
 * name, status — are not drift; see `WORKFLOW_METADATA_FIELDS`.)
 */
export class WorkflowRevisionDriftError extends Error {
  constructor(
    public readonly slug: string,
    public readonly revision: number,
    detail: string,
  ) {
    super(
      `Pinned revision snapshot for workflow '${slug}' r${String(revision)} ` +
        `already exists with different content. ${detail}`,
    );
    this.name = 'WorkflowRevisionDriftError';
  }
}

export type RevisionSnapshotOutcome = 'created' | 'matched' | 'overwritten';

/**
 * Snapshot a workflow at a given revision.
 *
 * Both `workflow.run.start` and `applyRatifiedOps` write to the same
 * revision path for the same logical state, so the writer must be
 * idempotent — but we also need to handle drift, where two different
 * definitions get assigned the same revision number.
 *
 * Drift policy is controlled by `onDrift`:
 *   - `'throw'` (default) — raise `WorkflowRevisionDriftError`. Use for
 *     tenant-authored workflows where two definitions sharing one revision
 *     is a structured invariant violation.
 *   - `'overwrite'` — upsert the new content over the stale snapshot. Use
 *     for platform-origin workflows: the in-code registry is the source of
 *     truth, so a stale on-disk snapshot from a prior run is just cache.
 *
 * Outcomes:
 *   - `created` — no prior snapshot existed; we wrote it.
 *   - `matched` — a snapshot already existed and its definition essence
 *                 matches the in-memory workflow.
 *   - `overwritten` — drift detected and `onDrift: 'overwrite'` upserted
 *                     the new content.
 */
export async function ensureWorkflowRevisionSnapshot(params: {
  docRepo: ReturnType<typeof createMemoryDocRepository>;
  dirRepo?: ReturnType<typeof createMemoryDirRepository>;
  slug: string;
  revision: number;
  spaceId: string;
  workflow: Record<string, unknown>;
  actor: string;
  onDrift?: 'throw' | 'overwrite';
}): Promise<RevisionSnapshotOutcome> {
  const { docRepo, dirRepo, slug, revision, spaceId, workflow, actor } = params;
  const onDrift = params.onDrift ?? 'throw';
  const path = workflowRevisionPath(slug, revision);

  const existing = await docRepo.getByPath(path, spaceId);
  if (existing?.inlineContent) {
    return reconcileExistingSnapshot({
      existingContent: existing.inlineContent,
      workflow,
      slug,
      revision,
      onDrift,
      docRepo,
      spaceId,
      actor,
      path,
    });
  }

  // Absent — attempt to create. A `create` collision means a concurrent
  // writer beat us to it; re-read and verify the bytes match before
  // declaring success.
  const json = JSON.stringify(workflow, null, 2);
  const bytes = Buffer.byteLength(json, 'utf8');

  if (dirRepo) {
    await dirRepo.ensureParentDirs(path, { spaceId });
  }

  try {
    await docRepo.put({
      path,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: json,
      payloadRef: null,
      sizeBytes: bytes,
      contentHash: '',
      preview: json.substring(0, 200),
      tags: ['workflow', 'revision'],
      summary: `Workflow revision ${String(revision)}`,
      semanticType: 'workflow_revision',
      indexing: 'disabled',
      scope: { spaceId },
      provenance: { actor },
    });
    return 'created';
  } catch (err) {
    // Likely a TOCTOU collision with a concurrent writer. Re-read and
    // reconcile per the drift policy.
    const after = await docRepo.getByPath(path, spaceId);
    if (!after?.inlineContent) {
      // Existence check failed but no doc on re-read — propagate the
      // original error so the caller doesn't silently suppress it.
      throw err;
    }
    return reconcileExistingSnapshot({
      existingContent: after.inlineContent,
      workflow,
      slug,
      revision,
      onDrift,
      docRepo,
      spaceId,
      actor,
      path,
    });
  }
}

async function reconcileExistingSnapshot(params: {
  existingContent: string;
  workflow: Record<string, unknown>;
  slug: string;
  revision: number;
  onDrift: 'throw' | 'overwrite';
  docRepo: ReturnType<typeof createMemoryDocRepository>;
  spaceId: string;
  actor: string;
  path: string;
}): Promise<RevisionSnapshotOutcome> {
  const { existingContent, workflow, slug, revision, onDrift, docRepo, spaceId, actor, path } =
    params;

  let existingObj: unknown;
  try {
    existingObj = JSON.parse(existingContent);
  } catch {
    if (onDrift === 'overwrite') {
      return overwriteSnapshot({ docRepo, spaceId, actor, path, workflow, revision });
    }
    throw new WorkflowRevisionDriftError(slug, revision, 'Existing snapshot is not valid JSON.');
  }
  if (existingObj === null || typeof existingObj !== 'object' || Array.isArray(existingObj)) {
    if (onDrift === 'overwrite') {
      return overwriteSnapshot({ docRepo, spaceId, actor, path, workflow, revision });
    }
    throw new WorkflowRevisionDriftError(slug, revision, 'Existing snapshot is not a JSON object.');
  }

  const existingEssence = extractDefinitionEssence(existingObj as Record<string, unknown>);
  const incomingEssence = extractDefinitionEssence(workflow);
  if (deepEqual(existingEssence, incomingEssence)) {
    return 'matched';
  }

  if (onDrift === 'overwrite') {
    return overwriteSnapshot({ docRepo, spaceId, actor, path, workflow, revision });
  }
  throw new WorkflowRevisionDriftError(
    slug,
    revision,
    'In-memory workflow definition at this revision differs from the persisted snapshot.',
  );
}

async function overwriteSnapshot(params: {
  docRepo: ReturnType<typeof createMemoryDocRepository>;
  spaceId: string;
  actor: string;
  path: string;
  workflow: Record<string, unknown>;
  revision: number;
}): Promise<'overwritten'> {
  const { docRepo, spaceId, actor, path, workflow, revision } = params;
  const json = JSON.stringify(workflow, null, 2);
  const bytes = Buffer.byteLength(json, 'utf8');
  await docRepo.put({
    path,
    writeMode: 'upsert',
    docType: 'json',
    mimeType: 'application/json',
    inlineContent: json,
    payloadRef: null,
    sizeBytes: bytes,
    contentHash: '',
    preview: json.substring(0, 200),
    tags: ['workflow', 'revision'],
    summary: `Workflow revision ${String(revision)}`,
    semanticType: 'workflow_revision',
    indexing: 'disabled',
    scope: { spaceId },
    provenance: { actor },
  });
  return 'overwritten';
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false; // primitives already compared via ===
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
