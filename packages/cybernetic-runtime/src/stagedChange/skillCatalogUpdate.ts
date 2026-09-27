/**
 * Skill-catalog update core — the per-kind update handler for installed
 * skills. Replaces the definition (workflow doc + activation) from the
 * registry payload while preserving the space copy's identity (id, createdAt,
 * origin, status) so runs, campaigns, and pinned revision snapshots stay
 * coherent; the revision bump keeps the next run's snapshot fresh. The
 * projection rebuild recomputes activation status and contract validity.
 */
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import {
  SkillComposeBundleSchema,
  WorkflowSchema,
  type SkillManifest,
  type TenantId,
} from '@aflow/schemas';
import { upsertSkillManifest } from '../skill.js';
import { renderSkillDiagnostics } from '../skillValidity/skillValidity.js';
import { rebuildSkillProjection } from '../skillProjectionReconciler.js';
import type { ApplyContext } from './applyRatifiedOps.js';
import { installSkillCatalogEntry } from './skillCatalogInstall.js';
import {
  activationDocPath,
  buildSkillWorkflowDoc,
  deriveRequiredCapabilities,
  evalSuiteDocPath,
  materializeSkillComposeBundle,
  workflowDocPath,
  type SkillWorkflowDocIdentity,
} from './skillComposeApply.js';

export type UpdateSkillCatalogEntryResult =
  | { outcome: 'invalid_bundle'; error: string }
  | {
      outcome: 'updated' | 'installed';
      skillId: string;
      revision: number;
      activationStatus: string;
      missingCapabilities: string[];
    };

function manifestDocPath(skillId: string): string {
  return `/skills/${skillId}/manifest.json`;
}

function jsonDocPut(path: string, content: unknown, spaceId: string, summary: string) {
  const json = JSON.stringify(content, null, 2);
  return {
    path,
    writeMode: 'upsert' as const,
    docType: 'json' as const,
    mimeType: 'application/json',
    inlineContent: json,
    payloadRef: null,
    sizeBytes: Buffer.byteLength(json, 'utf8'),
    contentHash: '',
    preview: json.substring(0, 200),
    summary,
    indexing: 'disabled' as const,
    scope: { spaceId },
    provenance: { actor: 'system:store-update' },
  };
}

export async function updateSkillCatalogEntry(
  ctx: ApplyContext,
  opts: {
    /** The raw catalog bundle; deep-cloned + re-parsed so updates never mutate the registry. */
    bundle: unknown;
    sourceCatalogId: string;
    sourceVersion: number;
  },
): Promise<UpdateSkillCatalogEntryResult> {
  const parsed = SkillComposeBundleSchema.safeParse(JSON.parse(JSON.stringify(opts.bundle)));
  if (!parsed.success) {
    return {
      outcome: 'invalid_bundle',
      error: `Catalog bundle validation failed: ${parsed.error.message}`,
    };
  }
  const bundle = parsed.data;
  const slug = bundle.workflow.slug;
  const skillId = bundle.manifest.skillId;

  const repo = createMemoryDocRepository(ctx.db, createTenantContext(ctx.tenantId as TenantId), {
    inTransaction: ctx.inTransaction ?? false,
  });
  const existingDoc = await repo.getByPath(workflowDocPath(slug), ctx.spaceId);

  if (!existingDoc?.inlineContent) {
    const installed = await installSkillCatalogEntry(ctx, opts);
    if (installed.outcome === 'invalid_bundle') return installed;
    if (installed.outcome === 'slug_conflict') {
      return {
        outcome: 'invalid_bundle',
        error: `Skill '${slug}' is archived — unarchive or remove it before updating.`,
      };
    }
    return {
      outcome: 'installed',
      skillId: installed.skillId,
      revision: 1,
      activationStatus: installed.activationStatus,
      missingCapabilities: installed.missingCapabilities,
    };
  }

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(existingDoc.inlineContent) as Record<string, unknown>;
  } catch {
    return {
      outcome: 'invalid_bundle',
      error: `Existing workflow doc for '${slug}' is not valid JSON — cannot update in place.`,
    };
  }

  const check = materializeSkillComposeBundle(bundle);
  if (check.validity.status === 'invalid') {
    return {
      outcome: 'invalid_bundle',
      error: `Skill contract validation failed at update:\n${renderSkillDiagnostics(check.validity.diagnostics)}`,
    };
  }
  bundle.workflow.tasks = check.materializedTasks;

  const now = new Date().toISOString();
  const existingRevision = typeof existing['revision'] === 'number' ? existing['revision'] : 1;
  const identity: SkillWorkflowDocIdentity = {
    id: typeof existing['id'] === 'string' ? existing['id'] : crypto.randomUUID(),
    status: typeof existing['status'] === 'string' ? existing['status'] : 'approved',
    origin: typeof existing['origin'] === 'string' ? existing['origin'] : 'cloned',
    // Pinned revision snapshots are immutable — a same-revision rewrite reads
    // as drift at run time, so the definition replace MUST bump the revision.
    revision: existingRevision + 1,
    createdAt: typeof existing['createdAt'] === 'string' ? existing['createdAt'] : now,
    updatedAt: now,
  };
  const wfParse = WorkflowSchema.safeParse(buildSkillWorkflowDoc(bundle, identity));
  if (!wfParse.success) {
    return {
      outcome: 'invalid_bundle',
      error: `Updated workflow fails WorkflowSchema: ${wfParse.error.message}`,
    };
  }

  await repo.put({
    ...jsonDocPut(
      workflowDocPath(slug),
      wfParse.data,
      ctx.spaceId,
      'Workflow updated from store listing',
    ),
    tags: ['workflow'],
    semanticType: 'workflow',
  });

  if (bundle.activation) {
    await repo.put({
      ...jsonDocPut(
        activationDocPath(slug),
        bundle.activation,
        ctx.spaceId,
        'Activation pattern updated from store listing',
      ),
      tags: ['activation'],
      semanticType: 'procedure_activation',
    });
  }

  // Eval suites are additive Coach territory once installed — only seed one
  // where none exists; never replace a space's evolved suite.
  const existingSuite = await repo.getByPath(evalSuiteDocPath(slug), ctx.spaceId);
  if (bundle.evalSuite && !existingSuite) {
    await repo.put({
      ...jsonDocPut(
        evalSuiteDocPath(slug),
        bundle.evalSuite,
        ctx.spaceId,
        'Eval suite seeded by store update',
      ),
      tags: ['eval', 'suite'],
      semanticType: 'eval_suite',
    });
  }

  const existingManifestDoc = await repo.getByPath(manifestDocPath(skillId), ctx.spaceId);
  let existingManifest: Record<string, unknown> | null = null;
  if (existingManifestDoc?.inlineContent) {
    try {
      existingManifest = JSON.parse(existingManifestDoc.inlineContent) as Record<string, unknown>;
    } catch {
      existingManifest = null;
    }
  }
  const hasSuiteDoc = bundle.evalSuite !== undefined || existingSuite !== null;
  const manifest: SkillManifest = {
    schemaVersion: 2,
    skillId,
    name: bundle.manifest.name,
    goal: bundle.manifest.goal,
    ...(bundle.manifest.campaign !== undefined ? { campaign: bundle.manifest.campaign } : {}),
    ...(bundle.manifest.concurrency !== undefined
      ? { concurrency: bundle.manifest.concurrency }
      : {}),
    mode: bundle.manifest.mode,
    origin: (typeof existingManifest?.['origin'] === 'string'
      ? existingManifest['origin']
      : 'cloned') as SkillManifest['origin'],
    workflowSlug: slug,
    evalSuiteRef: hasSuiteDoc ? evalSuiteDocPath(slug) : undefined,
    activationRef: bundle.activation ? activationDocPath(slug) : undefined,
    requiredCapabilities: deriveRequiredCapabilities(bundle),
    sourceCatalogId: opts.sourceCatalogId,
    sourceVersion: opts.sourceVersion,
    installedAt: now,
    createdAt:
      typeof existingManifest?.['createdAt'] === 'string' ? existingManifest['createdAt'] : now,
    updatedAt: now,
  };
  await upsertSkillManifest(
    {
      db: ctx.db,
      tenantId: ctx.tenantId,
      spaceId: ctx.spaceId,
      ...(ctx.inTransaction ? { inTransaction: true } : {}),
    },
    manifest,
  );

  const rebuilt = await rebuildSkillProjection(ctx, slug);
  return {
    outcome: 'updated',
    skillId: slug,
    revision: identity.revision,
    activationStatus: rebuilt?.projection.activationStatus ?? 'active',
    missingCapabilities: rebuilt?.projection.missingCapabilities ?? [],
  };
}
