import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId, Workflow } from '@aflow/schemas';
import {
  getPlatformWorkflow,
  isPlatformWorkflowSlug,
  listPlatformWorkflows,
} from '@aflow/platform-artifacts';

import { createTenantContext } from '../tenant.js';
import { createMemoryDocRepository } from './memoryDocs.js';
import { workflowDocPath, workflowRevisionPath, workflowRoot } from './workflowPaths.js';

// ============================================================================
// resolveWorkflowForStart
// ============================================================================

/**
 * Resolve the latest workflow for starting a new run.
 *
 * - Platform workflow: returns from registry.
 * - Non-platform: reads `/workflows/{slug}/workflow.json` from space memory.
 * - Reserved platform slug missing from registry: throws.
 */
export async function resolveWorkflowForStart(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  workflowSlug: string,
): Promise<Workflow | null> {
  // Platform workflow: return from registry.
  const platform = getPlatformWorkflow(workflowSlug);
  if (platform) {
    return platform as unknown as Workflow;
  }

  // Reserved slug not in registry — hard error.
  if (isPlatformWorkflowSlug(workflowSlug)) {
    throw new Error(`Platform workflow '${workflowSlug}' missing from registry`);
  }

  // Non-platform: read from space memory docs.
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const doc = await docRepo.getByPath(workflowDocPath(workflowSlug), spaceId);
  if (!doc?.inlineContent) return null;

  try {
    return JSON.parse(doc.inlineContent) as Workflow;
  } catch {
    return null;
  }
}

// ============================================================================
// resolveWorkflowForRunRevision
// ============================================================================

export class MissingPinnedRevisionError extends Error {
  constructor(
    public readonly slug: string,
    public readonly revision: number,
  ) {
    super(
      `Pinned revision snapshot missing for workflow '${slug}' r${String(revision)}. ` +
        `Active runs cannot fall back to latest — see plan 113.`,
    );
    this.name = 'MissingPinnedRevisionError';
  }
}

export async function resolveWorkflowForRunRevision(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  workflowSlug: string,
  revision: number,
): Promise<{ workflow: Workflow; source: 'platform' | 'revision' }> {
  // 1. Pinned revision snapshot — the safe default for any active run.
  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);

  const pinnedDoc = await docRepo.getByPath(workflowRevisionPath(workflowSlug, revision), spaceId);
  if (pinnedDoc?.inlineContent) {
    try {
      return { workflow: JSON.parse(pinnedDoc.inlineContent) as Workflow, source: 'revision' };
    } catch {
      // Fall through — the snapshot is unreadable; treat as missing.
    }
  }

  // 2. Platform registry — only valid when the registry revision matches
  //    the requested revision exactly. A registry that has moved on cannot
  //    serve an older revision.
  const platform = getPlatformWorkflow(workflowSlug);
  if (platform?.revision === revision) {
    return { workflow: platform as unknown as Workflow, source: 'platform' };
  }

  throw new MissingPinnedRevisionError(workflowSlug, revision);
}

// ============================================================================
// listWorkflowsWithPlatform
// ============================================================================

export async function listWorkflowsWithPlatform(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
): Promise<Workflow[]> {
  const platformRows: Workflow[] = listPlatformWorkflows().map((w) => w as unknown as Workflow);
  const seen = new Set(platformRows.map((w) => w.slug));

  const tenantCtx = createTenantContext(tenantId);
  const docRepo = createMemoryDocRepository(db, tenantCtx);
  const docs = await docRepo.list({
    pathPrefix: workflowRoot(),
    scope: { spaceId },
    filters: { docType: ['json'] },
    limit: 100,
  });

  const result: Workflow[] = [...platformRows];
  for (const item of docs) {
    if (!item.path.endsWith('/workflow.json')) continue;
    const doc = await docRepo.getByPath(item.path, spaceId);
    if (!doc?.inlineContent) continue;
    let parsed: Workflow;
    try {
      parsed = JSON.parse(doc.inlineContent) as Workflow;
    } catch {
      continue;
    }
    if (seen.has(parsed.slug)) continue;
    seen.add(parsed.slug);
    result.push(parsed);
  }
  return result;
}
