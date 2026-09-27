import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createMemoryDocRepository, createTenantContext, workflowDocPath } from '@aflow/database';
import type { SkillAuthoringSnapshot, SkillManifest, TenantId } from '@aflow/schemas';
import { WorkflowSchema } from '@aflow/schemas';

import { resolveSkillForWorkflow } from './skill.js';
import { loadEvalSuite } from './evalRunner.js';
import { hashCanonical } from './stagedChange/preconditions.js';

export interface SkillAuthoringContext {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
}

/**
 * The manifest precondition token — hashed over the operator-editable surface
 * (goal + campaign contract) only, so an unrelated manifest write (e.g. a
 * capability binding touching `requiredCapabilities`) does not spuriously stale
 * a goal/contract edit. Shared by the snapshot read and the save check so the
 * tokens are computed identically.
 */
export function manifestAuthoringToken(manifest: SkillManifest): string {
  return hashCanonical({ goal: manifest.goal, campaign: manifest.campaign ?? null });
}

/**
 * Server-owned full-skill read for the designer. Assembles the workflow (incl.
 * activation), the manifest (goal + campaign contract, matched by
 * `workflowSlug`), and the eval suite, plus the per-artifact version tokens a
 * save preconditions on. Returns null when the workflow doc is absent or
 * unparseable.
 */
export async function loadSkillAuthoringSnapshot(
  ctx: SkillAuthoringContext,
  slug: string,
): Promise<SkillAuthoringSnapshot | null> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const repo = createMemoryDocRepository(ctx.db, tenantCtx);

  const wfDoc = await repo.getByPath(workflowDocPath(slug), ctx.spaceId);
  if (!wfDoc?.inlineContent) return null;
  let workflow;
  try {
    const parsed = WorkflowSchema.safeParse(JSON.parse(wfDoc.inlineContent));
    if (!parsed.success) return null;
    workflow = parsed.data;
  } catch {
    return null;
  }

  const skill = await resolveSkillForWorkflow(
    { db: ctx.db, tenantId: ctx.tenantId, spaceId: ctx.spaceId },
    slug,
  );
  const manifest = skill?.manifest ?? null;
  const evalSuite = await loadEvalSuite(ctx.db, ctx.tenantId, ctx.spaceId, slug);

  return {
    workflow,
    manifest,
    evalSuite,
    tokens: {
      workflowRevision: workflow.revision,
      manifestHash: manifest ? manifestAuthoringToken(manifest) : null,
      evalSuiteHash: evalSuite ? hashCanonical(evalSuite) : null,
    },
  };
}
