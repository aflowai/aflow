import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, type TenantContext } from '@aflow/database';
import type { StagedChange, StagedChangeOp, TenantId } from '@aflow/schemas';
import type { ApplyContext, ApplyResult } from './applyRatifiedOps.js';
import { RatificationApplyError } from './applyRatifiedOps.js';
import { invalidateArtifactBindingCache } from '../artifactBindingResolver.js';
import { getCyberneticLogger } from '../logger.js';

interface DraftRow {
  id: string;
  artifact_id: string | null;
  space_id: string;
  kind: string;
  status: string;
  source_ref: string;
  compiled_ref: string | null;
  html_ref: string | null;
  catalog_id: string;
  catalog_version: string;
  catalog_hash: string;
  /** PR #357 review fix — render-path reads `data_schema` from the
   *  current version row; if NULL, validateDataAgainstSchema skips
   *  validation. Must carry over from the draft so Coach-published
   *  versions don't silently disable the contract bundle install
   *  established. */
  prompt: string | null;
  data_schema: Record<string, unknown> | null;
  validation_report: Record<string, unknown> | null;
}

interface ArtifactRow {
  id: string;
  current_version: number;
  space_id: string;
}

interface BindingRow {
  bundle_id: string;
  binding_id: string;
}

export async function applyArtifactUpdateOps(
  ctx: ApplyContext,
  stagedChange: StagedChange,
): Promise<ApplyResult> {
  const logger = getCyberneticLogger();
  const result: ApplyResult = {
    applied: false,
    appliedOps: [],
    skippedOps: [],
  };

  const tenantCtx = createTenantContext(ctx.tenantId as TenantId);

  for (const op of stagedChange.proposal.ops) {
    if (op.op !== 'update_artifact') {
      // Defensive — kind-level dispatch in applyRatifiedOps should
      // route only update_artifact ops here, but a mixed proposal
      // wouldn't be caught at parse time today. Surface explicitly.
      throw new RatificationApplyError(
        op.op,
        `artifact_update proposals must contain only 'update_artifact' ops; got '${op.op}'`,
      );
    }
    await applyOneUpdateArtifactOp(ctx, tenantCtx, op);
    result.appliedOps.push(op.op);
    result.applied = true;
    logger.info(
      `[applyArtifactUpdate] published artifactId=${op.artifactId} from draftId=${op.draftId} — ${op.diffSummary.slice(0, 80)}`,
    );
  }

  return result;
}

async function applyOneUpdateArtifactOp(
  ctx: ApplyContext,
  tenantCtx: TenantContext,
  op: Extract<StagedChangeOp, { op: 'update_artifact' }>,
): Promise<void> {
  await withTenantSchema(ctx.db, tenantCtx, async (tx) => {
    // ── Step 1: load + validate the draft ──────────────────────────────
    // PR #357 review fix — also SELECT data_schema, validation_report,
    // compiled_ref, prompt. ui.artifact.publish (the equivalent op-side
    // path) copies these onto the new version row; without them, the
    // version's data_schema is NULL and the render path's
    // validateDataAgainstSchema short-circuits to "valid" — silently
    // dropping the contract bundle install established for the seed.
    const draftRows = (await tx.execute(sql`
      SELECT id, artifact_id, space_id, kind, status, source_ref, compiled_ref, html_ref,
             catalog_id, catalog_version, catalog_hash, prompt, data_schema, validation_report
      FROM ui_artifact_drafts
      WHERE id = ${op.draftId}::uuid AND space_id = ${ctx.spaceId}::uuid
      LIMIT 1
    `)) as unknown as DraftRow[];

    const draft = draftRows[0];
    if (!draft) {
      throw new RatificationApplyError(
        op.op,
        `Draft ${op.draftId} not found in space ${ctx.spaceId} — the operator may have ` +
          `deleted it or the Coach never produced it. Re-author the proposal.`,
        'target_skill_missing',
      );
    }
    if (draft.status === 'failed') {
      throw new RatificationApplyError(
        op.op,
        `Cannot publish a failed draft (${op.draftId}) — fix validation errors first.`,
      );
    }
    if (!draft.html_ref) {
      throw new RatificationApplyError(
        op.op,
        `Draft ${op.draftId} has no rendered HTML. The Coach must regenerate to produce ` +
          `a compiled version before this proposal can be ratified.`,
      );
    }
    // If the draft was authored against an artifactId, it must match the
    // op's artifactId — otherwise the operator would be publishing the
    // wrong lineage. Coach should never emit this; defense in depth.
    if (draft.artifact_id && draft.artifact_id !== op.artifactId) {
      throw new RatificationApplyError(
        op.op,
        `Draft ${op.draftId} was authored against artifact ${draft.artifact_id} but ` +
          `the proposal targets ${op.artifactId} — Coach attribution drift, reject.`,
      );
    }

    // ── Step 2: load + validate the target artifact head ───────────────
    const artifactRows = (await tx.execute(sql`
      SELECT id, current_version, space_id
      FROM ui_artifacts
      WHERE id = ${op.artifactId}::uuid AND space_id = ${ctx.spaceId}::uuid AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as ArtifactRow[];

    const artifact = artifactRows[0];
    if (!artifact) {
      throw new RatificationApplyError(
        op.op,
        `Artifact ${op.artifactId} not found in space ${ctx.spaceId} — bundle may have ` +
          `been uninstalled between proposal authoring and ratification.`,
        'target_skill_missing',
      );
    }

    // ── Step 3: compute new version + parentVersionId ──────────────────
    const nextVersion = artifact.current_version + 1;
    const parentRows = (await tx.execute(sql`
      SELECT id FROM ui_artifact_versions
      WHERE artifact_id = ${op.artifactId}::uuid AND version = ${artifact.current_version}
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    const parentVersionId = parentRows[0]?.id ?? null;

    // ── Step 4: load draft source for the contentHash ──────────────────
    // The published-version row carries the rendered-contract hash so
    // bundle reinstalls can short-circuit on identical content. Same
    // recipe as applyArtifactSeeds.ts's renderContractHash, simplified
    // to just the source (the renderer's compile path uses dataSchema +
    // sample data, but for an operator publish those come straight off
    // the draft and we don't recompute).
    //
    // The source/html refs live in PayloadStore; for the contentHash we
    // need the raw source bytes. Inline refs can be unwrapped without
    // PayloadStore; non-inline refs would require a payloadStore handle.
    // For Phase 6 MVP we assume inline (the executor's generate path
    // produces inline source refs by default).
    let contentHash: string;
    if (draft.source_ref.startsWith('inline:')) {
      const base64 = draft.source_ref.slice('inline:'.length);
      const source = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as string;
      contentHash = createHash('sha256').update(source, 'utf8').digest('hex');
    } else {
      // Non-inline source refs — for v1 we fall back to a stable hash
      // of the ref itself. Less ideal (won't dedupe identical content
      // across regenerates) but doesn't block the publish.
      contentHash = createHash('sha256').update(draft.source_ref, 'utf8').digest('hex');
    }

    // ── Step 5: writes (UPDATE head, INSERT version, UPDATE draft) ─────
    await tx.execute(sql`
      UPDATE ui_artifacts
      SET current_version = ${nextVersion},
          catalog_id = ${draft.catalog_id},
          catalog_version = ${draft.catalog_version},
          catalog_hash = ${draft.catalog_hash},
          updated_at = NOW()
      WHERE id = ${op.artifactId}::uuid
    `);

    // PR #357 review fix — copy `compiled_ref`, `data_schema`,
    // `validation_report` from the draft so the new version row stays
    // honest. The render path's `validateDataAgainstSchema` reads
    // `data_schema` directly from the version row; NULL would silently
    // disable the contract the seed established.
    //
    // The draft's `prompt` is preserved alongside a Coach-attribution
    // suffix so the version row's `prompt` column tells the operator
    // both what the Coach asked for and that this came from a
    // staged-change apply (not a direct generate/publish).
    const coachPromptAnnotation = `coach-update: ${op.diffSummary.slice(0, 200)}`;
    const versionPrompt = draft.prompt
      ? `${draft.prompt}\n\n[${coachPromptAnnotation}]`
      : coachPromptAnnotation;

    await tx.execute(sql`
      INSERT INTO ui_artifact_versions (
        artifact_id, version, source_ref, compiled_ref, html_ref,
        content_hash, prompt, data_schema, validation_report,
        parent_version_id, sample_data, sample_data_payload_ref
      )
      VALUES (
        ${op.artifactId}::uuid, ${nextVersion}, ${draft.source_ref}, ${draft.compiled_ref}, ${draft.html_ref},
        ${contentHash},
        ${versionPrompt},
        ${JSON.stringify(draft.data_schema ?? null)}::jsonb,
        ${JSON.stringify(draft.validation_report ?? null)}::jsonb,
        ${parentVersionId ? sql`${parentVersionId}::uuid` : sql`NULL`},
        NULL, NULL
      )
    `);

    // PR #357 review fix — align with `ui.artifact.publish`: DELETE the
    // draft after publish rather than marking status='published'.
    // Marked-but-not-deleted drafts would still appear in
    // `ui.artifact.list` draft listings even though they no longer
    // represent a pending change; that's an operator-UX wart the
    // publish op avoids by hard-deleting. Same here.
    await tx.execute(sql`
      DELETE FROM ui_artifact_drafts
      WHERE id = ${op.draftId}::uuid
    `);

    // ── Step 6: invalidate the resolver cache for every binding row ────
    // The 60s read-through cache in artifactBindingResolver.ts is keyed
    // by `(tenantId, spaceId, bundleId, bindingId)` and resolves to
    // `(artifactId, currentVersion)`. After publish, `currentVersion` is
    // stale for every binding pointing at this artifact — drop them.
    const bindingRows = (await tx.execute(sql`
      SELECT bundle_id, binding_id
      FROM artifact_bindings
      WHERE artifact_id = ${op.artifactId}::uuid AND space_id = ${ctx.spaceId}::uuid
    `)) as unknown as BindingRow[];

    for (const row of bindingRows) {
      invalidateArtifactBindingCache({
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        bundleId: row.bundle_id,
        bindingId: row.binding_id,
      });
    }
  });
}
