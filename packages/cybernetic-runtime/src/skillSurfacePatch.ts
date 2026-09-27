import {
  createMemoryDocRepository,
  createTenantContext,
  workflowDocPath,
  ensureWorkflowRevisionSnapshot,
} from '@aflow/database';
import type { SkillManifest, SkillValidity, TenantId } from '@aflow/schemas';
import { WorkflowSchema, SkillManifestSchema } from '@aflow/schemas';
import { isPlatformWorkflowSlug } from '@aflow/platform-artifacts';

import { resolveSkillForWorkflow } from './skill.js';
import { materializeAndValidateSkillConfig } from './skillValidity/skillValidity.js';
import { manifestAuthoringToken, type SkillAuthoringContext } from './skillAuthoringSnapshot.js';

const manifestPath = (skillId: string): string => `/skills/${skillId}/manifest.json`;
const ACTOR = 'operator:surface-patch';

/**
 * A partial full-skill edit. Only the artifacts the operator changed are
 * present — the rest are left untouched (lossless by omission). Within each
 * present artifact the whole content is sent; the server merges it against the
 * locked current doc, preserving server-authoritative identity. Eval changes
 * are NOT carried here — they stay on the provenance-protected
 * `eval.criterion.*` op path, so a save can never clobber eval ownership.
 */
export interface SkillSurfacePatchInput {
  slug: string;
  /** Versions the editor saw — checked only for the artifacts the patch changes. */
  tokens: { workflowRevision?: number | undefined; manifestHash?: string | null | undefined };
  /** Edited workflow content (full doc, incl. activation) — iff the graph changed. */
  workflow?: Record<string, unknown>;
  /** Goal / campaign-contract edit — iff the manifest changed. `campaign: null` clears it. */
  manifest?: { goal?: unknown; campaign?: unknown };
}

export type SkillSurfacePatchResult =
  | { ok: true; newRevision: number; validity: SkillValidity }
  | {
      ok: false;
      status: 404 | 409 | 422;
      code: string;
      detail: string;
      details?: Record<string, unknown>;
    };

/**
 * Lossless full-skill save authority: merges a partial workflow + manifest edit
 * against the locked current docs, in one transaction, under per-artifact
 * version preconditions (a concurrent change to an artifact the editor never
 * touched is rejected, not clobbered), preserving server-authoritative identity
 * and revision history, and validating the merged result holistically (so a
 * contract-field rename + a `$campaign` ref edit are checked together).
 */
export async function applySkillSurfacePatch(
  ctx: SkillAuthoringContext,
  patch: SkillSurfacePatchInput,
): Promise<SkillSurfacePatchResult> {
  const { slug } = patch;

  if (!patch.workflow && !patch.manifest) {
    return {
      ok: false,
      status: 422,
      code: 'empty_patch',
      detail: 'Provide a workflow and/or a goal/contract edit.',
    };
  }
  // Platform-owned skills live in the registry and are read-only here — mirror
  // the guard every sibling write authority enforces.
  if (isPlatformWorkflowSlug(slug)) {
    return {
      ok: false,
      status: 422,
      code: 'platform_artifact_read_only',
      detail: `Skill "${slug}" is platform-owned and cannot be edited here.`,
    };
  }

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);
  const outerRepo = createMemoryDocRepository(ctx.db, tenantCtx);

  // Resolve the skill for the manifest doc path AND for validation: a workflow
  // edit must be validated against the skill's real campaign contract, so the
  // manifest is read whether or not it's being edited.
  const skill = await resolveSkillForWorkflow(
    { db: ctx.db, tenantId: ctx.tenantId, spaceId: ctx.spaceId },
    slug,
  );

  return outerRepo.withTransaction(async (txRepo): Promise<SkillSurfacePatchResult> => {
    const wfDoc = await txRepo.getByPath(workflowDocPath(slug), ctx.spaceId, { forUpdate: true });
    if (!wfDoc?.inlineContent) {
      return { ok: false, status: 404, code: 'not_found', detail: `Skill "${slug}" not found.` };
    }
    const wfParse = WorkflowSchema.safeParse(JSON.parse(wfDoc.inlineContent));
    if (!wfParse.success) {
      return {
        ok: false,
        status: 422,
        code: 'corrupt_workflow',
        detail: `Stored workflow for "${slug}" is not valid; cannot patch.`,
      };
    }
    const currentWf = wfParse.data;

    // Lock-read the manifest whenever the skill has one — needed for validation
    // (the contract) even on a workflow-only edit. The write + the precondition
    // stay gated on `patch.manifest` so an untouched manifest is read-only.
    let currentManifest: SkillManifest | null = null;
    let manifestDocPath: string | null = null;
    if (skill) {
      manifestDocPath = manifestPath(skill.manifest.skillId);
      const mDoc = await txRepo.getByPath(manifestDocPath, ctx.spaceId, { forUpdate: true });
      if (mDoc?.inlineContent) {
        const mParse = SkillManifestSchema.safeParse(JSON.parse(mDoc.inlineContent));
        if (!mParse.success) {
          return { ok: false, status: 422, code: 'corrupt_manifest', detail: mParse.error.message };
        }
        currentManifest = mParse.data;
      }
    }
    if (patch.manifest && !currentManifest) {
      return {
        ok: false,
        status: 422,
        code: 'no_manifest',
        detail: `Skill "${slug}" has no manifest — goal/contract cannot be edited.`,
      };
    }

    // -- Per-artifact preconditions (only what's being edited) --
    if (patch.workflow && patch.tokens.workflowRevision !== currentWf.revision) {
      return {
        ok: false,
        status: 409,
        code: 'stale',
        detail: 'The skill changed since you loaded it. Reload and reapply your edits.',
        details: { artifact: 'workflow', currentRevision: currentWf.revision },
      };
    }
    if (patch.manifest && currentManifest) {
      if (patch.tokens.manifestHash !== manifestAuthoringToken(currentManifest)) {
        return {
          ok: false,
          status: 409,
          code: 'stale',
          detail: 'The goal/contract changed since you loaded it. Reload and reapply your edits.',
          details: { artifact: 'manifest' },
        };
      }
    }

    // -- Merge, preserving server-authoritative identity --
    const now = new Date().toISOString();
    let mergedWf = currentWf;
    if (patch.workflow) {
      const candidate = {
        ...patch.workflow,
        id: currentWf.id,
        slug,
        origin: currentWf.origin,
        createdAt: currentWf.createdAt,
        revision: currentWf.revision + 1,
        updatedAt: now,
      };
      const parsed = WorkflowSchema.safeParse(candidate);
      if (!parsed.success) {
        return { ok: false, status: 422, code: 'invalid_workflow', detail: parsed.error.message };
      }
      mergedWf = parsed.data;
    }

    let mergedManifest = currentManifest;
    if (patch.manifest && currentManifest) {
      const candidate = {
        ...currentManifest,
        ...(patch.manifest.goal !== undefined ? { goal: patch.manifest.goal } : {}),
        ...('campaign' in patch.manifest ? { campaign: patch.manifest.campaign ?? undefined } : {}),
        updatedAt: now,
      };
      const parsed = SkillManifestSchema.safeParse(candidate);
      if (!parsed.success) {
        return { ok: false, status: 422, code: 'invalid_manifest', detail: parsed.error.message };
      }
      mergedManifest = parsed.data;
    }

    // -- Holistic validation (workflow + manifest together) --
    const { materializedTasks, validity } = materializeAndValidateSkillConfig({
      tasks: mergedWf.tasks,
      stateVariables: mergedWf.stateVariables,
      output: mergedWf.output,
      runInputs: mergedWf.runInputs,
      mode: mergedWf.mode,
      campaign: {
        contract: mergedManifest?.campaign,
        goal: mergedManifest?.goal,
        outcomes: mergedWf.outcomes,
      },
    });
    if (validity.status === 'invalid') {
      return {
        ok: false,
        status: 422,
        code: 'invalid',
        detail: 'The edited skill failed validation.',
        details: { diagnostics: validity.diagnostics },
      };
    }

    // -- Persist (atomic) --
    if (patch.workflow) {
      await ensureWorkflowRevisionSnapshot({
        docRepo: txRepo,
        slug,
        revision: currentWf.revision,
        spaceId: ctx.spaceId,
        workflow: JSON.parse(JSON.stringify(currentWf)) as Record<string, unknown>,
        actor: ACTOR,
      });
      // Persist the MATERIALIZED tasks — the executed artifact is always the
      // derived one, as the other workflow writers do.
      const toPersist = WorkflowSchema.parse({ ...mergedWf, tasks: materializedTasks });
      const json = JSON.stringify(toPersist, null, 2);
      await txRepo.put({
        path: workflowDocPath(slug),
        writeMode: 'overwrite',
        docType: 'workflow',
        mimeType: 'application/json',
        inlineContent: json,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(json, 'utf8'),
        contentHash: '',
        preview: json.substring(0, 200),
        tags: ['workflow'],
        summary: `Workflow updated by operator (rev ${String(mergedWf.revision)})`,
        semanticType: 'workflow',
        indexing: 'disabled',
        scope: { spaceId: ctx.spaceId },
        provenance: { actor: ACTOR },
      });
    }
    if (patch.manifest && mergedManifest && manifestDocPath) {
      const json = JSON.stringify(mergedManifest, null, 2);
      await txRepo.put({
        path: manifestDocPath,
        writeMode: 'upsert',
        docType: 'skill_manifest',
        mimeType: 'application/json',
        inlineContent: json,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(json, 'utf8'),
        contentHash: '',
        preview: json.substring(0, 200),
        tags: ['skill'],
        summary: null,
        indexing: 'disabled',
        scope: { spaceId: ctx.spaceId },
      });
    }

    return { ok: true, newRevision: mergedWf.revision, validity };
  });
}
