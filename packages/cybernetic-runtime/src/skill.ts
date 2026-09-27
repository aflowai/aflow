import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TenantId, SkillManifest, SkillProjection, Workflow } from '@aflow/schemas';
import { SkillManifestSchema, SkillProjectionSchema } from '@aflow/schemas';
import { createTenantContext, createMemoryDocRepository } from '@aflow/database';
import {
  getPlatformSkillBundle,
  listPlatformSkillBundles,
  isPlatformSkillId,
} from '@aflow/platform-artifacts';
import { getCyberneticLogger } from './logger.js';
import type { SkillCampaignManifestParams } from './skillValidity/skillValidity.js';

// ============================================================================
// Types
// ============================================================================

export interface ResolvedSkill {
  manifest: SkillManifest;
  projection: SkillProjection | null;
  workflow: Workflow | null;
  evalSuiteRef: string | undefined;
  activationRef: string | undefined;
}

export interface SkillLoadContext {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  inTransaction?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function manifestPath(skillId: string): string {
  return `/skills/${skillId}/manifest.json`;
}

function projectionPath(skillId: string): string {
  return `/skills/${skillId}/projection.json`;
}

/** Parse JSON from a MemoryDoc's inlineContent. */
function parseDocContent(inlineContent: string | null): unknown {
  if (!inlineContent) return null;
  try {
    return JSON.parse(inlineContent);
  } catch {
    return null;
  }
}

/** Serialize content for writing via memoryDocs.put(). */
function serializeForPut(content: unknown): {
  inlineContent: string;
  sizeBytes: number;
  preview: string;
} {
  const json = JSON.stringify(content);
  return {
    inlineContent: json,
    sizeBytes: Buffer.byteLength(json, 'utf8'),
    preview: json.substring(0, 200),
  };
}

// ============================================================================
// Read helpers
// ============================================================================

export interface LoadSkillOptions {
  includeArchived?: boolean | 'only';
}

/**
 * Load a single skill by ID, returning the resolved view.
 * Returns null if no manifest exists.
 */
export async function loadSkill(
  ctx: SkillLoadContext,
  skillId: string,
  opts: LoadSkillOptions = {},
): Promise<ResolvedSkill | null> {
  const includeArchived = opts.includeArchived ?? false;
  const includeDeleted = includeArchived !== false;

  const platformBundle = getPlatformSkillBundle(skillId);
  if (platformBundle) {
    // Platform skills can never be archived. If caller asked 'only'-archived,
    // skip them.
    if (includeArchived === 'only') return null;

    // Platform manifest + workflow from registry; projection remains space-local.
    let projection: SkillProjection | null = null;
    const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
    const repo = createMemoryDocRepository(ctx.db, tenantCtx, {
      inTransaction: ctx.inTransaction ?? false,
    });
    const projDoc = await repo.getByPath(projectionPath(skillId), ctx.spaceId);
    if (projDoc) {
      const projRaw = parseDocContent(projDoc.inlineContent);
      const projParsed = SkillProjectionSchema.safeParse(projRaw);
      if (projParsed.success) {
        projection = projParsed.data;
      }
    }

    return {
      manifest: platformBundle.manifest as unknown as SkillManifest,
      projection,
      workflow: platformBundle.workflow as unknown as Workflow,
      evalSuiteRef: platformBundle.manifest.evalSuiteRef,
      activationRef: undefined,
    };
  }

  // Reserved platform skill missing from registry — hard error.
  if (isPlatformSkillId(skillId)) {
    throw new Error(`Platform skill '${skillId}' missing from registry`);
  }

  // Non-platform skill: load from memory docs as before.
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const repo = createMemoryDocRepository(ctx.db, tenantCtx, {
    inTransaction: ctx.inTransaction ?? false,
  });

  const manifestDoc = await repo.getByPath(manifestPath(skillId), ctx.spaceId, {
    includeDeleted,
  });
  if (!manifestDoc) return null;

  // 'only' filter: must be archived. Skip active skills.
  if (includeArchived === 'only' && manifestDoc.deletedAt === null) return null;

  const raw = parseDocContent(manifestDoc.inlineContent);
  const parsed = SkillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    getCyberneticLogger().warn('skill: invalid manifest', { skillId, error: parsed.error.message });
    return null;
  }

  const manifest = parsed.data;

  // Load projection (may not exist yet)
  let projection: SkillProjection | null = null;
  const projDoc = await repo.getByPath(projectionPath(skillId), ctx.spaceId, {
    includeDeleted,
  });
  if (projDoc) {
    const projRaw = parseDocContent(projDoc.inlineContent);
    const projParsed = SkillProjectionSchema.safeParse(projRaw);
    if (projParsed.success) {
      projection = projParsed.data;
    }
  }

  // Load workflow via the slug (stored at /workflows/{slug}/workflow.json)
  let workflow: Workflow | null = null;
  const wfDoc = await repo.getByPath(
    `/workflows/${manifest.workflowSlug}/workflow.json`,
    ctx.spaceId,
    { includeDeleted },
  );
  if (wfDoc) {
    workflow = parseDocContent(wfDoc.inlineContent) as Workflow | null;
  }

  return {
    manifest,
    projection,
    workflow,
    evalSuiteRef: manifest.evalSuiteRef,
    activationRef: manifest.activationRef,
  };
}

export interface ListSkillsOptions {
  includeArchived?: boolean | 'only';
}

/**
 * List all skills for a space, returning resolved views.
 * Scans `/skills/` prefix in memoryDocs.
 */
export async function listSkillsForSpace(
  ctx: SkillLoadContext,
  opts: ListSkillsOptions = {},
): Promise<ResolvedSkill[]> {
  const includeArchived = opts.includeArchived ?? false;
  const skills: ResolvedSkill[] = [];

  if (includeArchived !== 'only') {
    for (const bundle of listPlatformSkillBundles()) {
      const resolved = await loadSkill(ctx, bundle.skillId);
      if (resolved) {
        skills.push(resolved);
      }
    }
  }

  // Space-local skills from memory docs.
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const repo = createMemoryDocRepository(ctx.db, tenantCtx, {
    inTransaction: ctx.inTransaction ?? false,
  });

  const docs = await repo.list({
    scope: { spaceId: ctx.spaceId },
    pathPrefix: '/skills/',
    limit: 200,
    includeDeleted: includeArchived,
  });

  const manifests = docs.filter((d) => d.path.endsWith('/manifest.json'));
  const seenIds = new Set(skills.map((s) => s.manifest.skillId));

  for (const doc of manifests) {
    const segments = doc.path.split('/');
    const skillId = segments[2]; // ['', 'skills', '{skillId}', 'manifest.json']
    if (!skillId || seenIds.has(skillId)) continue;

    // Pass the same flag through loadSkill so its `getByPath` calls match.
    const resolved = await loadSkill(ctx, skillId, { includeArchived });
    if (resolved) {
      skills.push(resolved);
    }
  }

  return skills;
}

export async function resolveSkillForWorkflow(
  ctx: SkillLoadContext,
  workflowSlug: string,
): Promise<ResolvedSkill | null> {
  let direct: ResolvedSkill | null = null;
  try {
    direct = await loadSkill(ctx, workflowSlug);
  } catch {
    direct = null;
  }
  if (direct?.manifest.workflowSlug === workflowSlug) return direct;

  try {
    const all = await listSkillsForSpace(ctx);
    return all.find((s) => s.manifest.workflowSlug === workflowSlug) ?? null;
  } catch {
    return null;
  }
}

export async function resolveCampaignManifestParams(
  ctx: SkillLoadContext,
  workflowSlug: string,
): Promise<SkillCampaignManifestParams | undefined> {
  const skill = await resolveSkillForWorkflow(ctx, workflowSlug);
  if (!skill) return undefined;
  return { contract: skill.manifest.campaign, goal: skill.manifest.goal };
}

// ============================================================================
// Write helpers
// ============================================================================

/**
 * Upsert a SkillManifest. Never touches projection fields.
 */
export async function upsertSkillManifest(
  ctx: SkillLoadContext,
  manifest: SkillManifest,
): Promise<void> {
  if (isPlatformSkillId(manifest.skillId)) {
    throw new Error(
      `PLATFORM_ARTIFACT_READ_ONLY: platform-owned skill '${manifest.skillId}' cannot be created or updated.`,
    );
  }

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const repo = createMemoryDocRepository(ctx.db, tenantCtx, {
    inTransaction: ctx.inTransaction ?? false,
  });
  const path = manifestPath(manifest.skillId);
  const { inlineContent, sizeBytes, preview } = serializeForPut(manifest);

  await repo.put({
    path,
    docType: 'skill_manifest',
    mimeType: 'application/json',
    inlineContent,
    payloadRef: null,
    sizeBytes,
    contentHash: '',
    preview,
    tags: ['skill'],
    summary: null,
    scope: { spaceId: ctx.spaceId },
    writeMode: 'upsert',
    indexing: 'disabled',
  });

  getCyberneticLogger().debug('skill: upserted manifest', {
    skillId: manifest.skillId,
    spaceId: ctx.spaceId,
  });
}

/**
 * Write a SkillProjection. Used internally by the reconciler.
 */
export async function writeSkillProjection(
  ctx: SkillLoadContext,
  projection: SkillProjection,
): Promise<void> {
  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const repo = createMemoryDocRepository(ctx.db, tenantCtx, {
    inTransaction: ctx.inTransaction ?? false,
  });
  const path = projectionPath(projection.skillId);
  const { inlineContent, sizeBytes, preview } = serializeForPut(projection);

  await repo.put({
    path,
    docType: 'skill_projection',
    mimeType: 'application/json',
    inlineContent,
    payloadRef: null,
    sizeBytes,
    contentHash: '',
    preview,
    tags: ['skill'],
    summary: null,
    scope: { spaceId: ctx.spaceId },
    writeMode: 'upsert',
    indexing: 'disabled',
  });
}
