import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  TenantId,
  StagedChange,
  Workflow,
  CyberneticEvalSuite,
  SkillManifest,
} from '@aflow/schemas';
import { WorkflowSchema, CyberneticEvalSuiteSchema } from '@aflow/schemas';
import { createTenantContext, createMemoryDocRepository, workflowDocPath } from '@aflow/database';
import { getCyberneticLogger } from '../logger.js';
import { resolveSkillForWorkflow } from '../skill.js';
import {
  collectEvalSkillSlugs,
  evaluateProposalPreconditions,
  isInScopeForPinning,
} from './preconditions.js';
import { tryParseStagedChangeDoc } from './tryParseStagedChangeDoc.js';

const PROPOSAL_DIRS = ['/coach/staged', '/coach/platform-issues'];

export interface ProactiveSweepContext {
  tenantId: TenantId;
  spaceId: string;
  db: PostgresJsDatabase;
}

export interface ProactiveSweepResult {
  /** Proposals inspected. */
  inspected: number;
  /** Proposals newly flipped to `rebaseState='stale'`. */
  newlyStale: string[];
}

/**
 * Inspect sibling proposals targeting the same workflow slug and mark any
 * whose preconditions no longer hold as `rebaseState='stale'`. Excludes
 * the proposal that triggered the sweep (its own apply has already
 * succeeded) and proposals that are already `rebaseState='stale'`.
 *
 * Best-effort: errors loading individual proposals are logged and skipped —
 * a partial sweep is better than no sweep when the trigger proposal has
 * already committed.
 */
export async function proactiveStalenessSweep(
  ctx: ProactiveSweepContext,
  opts: {
    /** Slug that was just mutated (workflow + eval share slug namespace). */
    slug: string;
    /** ID of the proposal that triggered the sweep — excluded from results. */
    excludeProposalId?: string;
  },
): Promise<ProactiveSweepResult> {
  const logger = getCyberneticLogger();
  const tenantCtx = createTenantContext(ctx.tenantId);
  const docRepo = createMemoryDocRepository(ctx.db, tenantCtx);

  // Load current workflow + eval suite (best-effort)
  let workflow: Workflow | null = null;
  const wfDoc = await docRepo.getByPath(workflowDocPath(opts.slug), ctx.spaceId);
  if (wfDoc?.inlineContent) {
    try {
      workflow = WorkflowSchema.parse(JSON.parse(wfDoc.inlineContent));
    } catch {
      /* tolerate; sweep will just not flag workflow-targeted siblings */
    }
  }
  // Manifest backs goal/campaign-contract preconditions. Manifest descriptors
  // are NOT slug-keyed (they read `artifacts.manifest` directly), so each
  // proposal must be evaluated against its OWN skill's manifest — a single
  // opts.slug manifest would false-stale cross-slug overlap proposals. Loaded
  // lazily + cached by the proposal's target slug.
  const manifestBySlug = new Map<string, SkillManifest | null>();
  const manifestForSlug = async (slug: string): Promise<SkillManifest | null> => {
    const cached = manifestBySlug.get(slug);
    if (cached !== undefined) return cached;
    let resolved: SkillManifest | null = null;
    try {
      const skill = await resolveSkillForWorkflow(
        { db: ctx.db, tenantId: ctx.tenantId, spaceId: ctx.spaceId },
        slug,
      );
      resolved = skill?.manifest ?? null;
    } catch {
      /* tolerate; sweep just won't flag this skill's manifest siblings */
    }
    manifestBySlug.set(slug, resolved);
    return resolved;
  };

  const evalSuites = new Map<string, CyberneticEvalSuite>();
  const suiteDoc = await docRepo.getByPath(`/evals/${opts.slug}/suite.json`, ctx.spaceId);
  if (suiteDoc?.inlineContent) {
    try {
      evalSuites.set(
        opts.slug,
        CyberneticEvalSuiteSchema.parse(JSON.parse(suiteDoc.inlineContent)),
      );
    } catch {
      /* tolerate */
    }
  }

  const result: ProactiveSweepResult = { inspected: 0, newlyStale: [] };

  for (const dir of PROPOSAL_DIRS) {
    const docs = await docRepo.list({
      scope: { spaceId: ctx.spaceId },
      pathPrefix: dir,
      limit: 200,
    });
    for (const summary of docs) {
      if (opts.excludeProposalId && summary.path.endsWith(`/${opts.excludeProposalId}.json`)) {
        continue;
      }
      const full = await docRepo.getByPath(summary.path, ctx.spaceId);
      if (!full?.inlineContent) continue;

      const parsed = tryParseStagedChangeDoc(full.inlineContent, {
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
        docPath: summary.path,
        reader: 'proactiveStalenessSweep',
      });
      if (!parsed.ok) continue;
      const staged: StagedChange = parsed.staged;

      if (staged.status !== 'proposed') continue;
      if (staged.rebaseState === 'stale') continue;
      if (!isInScopeForPinning(staged.kind)) continue;
      if (staged.targetWorkflowSlug !== opts.slug) {
        // Check eval skill slug overlap (rare: cross-suite proposals).
        if (!collectEvalSkillSlugs(staged).includes(opts.slug)) continue;
      }
      if (!staged.preconditions) continue; // legacy — leave to ratify-time refusal

      result.inspected += 1;
      // Evaluate manifest pins against the proposal's OWN skill manifest, not
      // the swept slug's — they are not slug-keyed in readTargetHash.
      const proposalManifest = staged.targetWorkflowSlug
        ? await manifestForSlug(staged.targetWorkflowSlug)
        : null;
      const conflicts = evaluateProposalPreconditions(staged, {
        workflow,
        evalSuites,
        manifest: proposalManifest,
      });
      if (!conflicts || conflicts.length === 0) continue;

      const updated: StagedChange = {
        ...staged,
        rebaseState: 'stale',
        staleDetails: {
          detectedAt: new Date().toISOString(),
          conflictingOpIndices: conflicts.map((c) => c.opIndex),
          conflicts,
        },
      };
      const updatedJson = JSON.stringify(updated, null, 2);
      try {
        await docRepo.put({
          path: summary.path,
          writeMode: 'upsert',
          docType: 'json',
          mimeType: 'application/json',
          inlineContent: updatedJson,
          payloadRef: null,
          sizeBytes: Buffer.byteLength(updatedJson, 'utf8'),
          contentHash: '',
          preview: updatedJson.substring(0, 200),
          tags:
            updated.resolutionRoute === 'platform_issue'
              ? ['coach', 'platform-issue']
              : ['coach', 'staged'],
          summary: updated.proposal.summary,
          semanticType: 'staged_change',
          indexing: 'disabled',
          scope: { spaceId: ctx.spaceId },
          provenance: { actor: 'system:proactive-staleness-sweep' },
        });
        result.newlyStale.push(staged.id);
      } catch (err) {
        logger.warn(
          `[proactiveStalenessSweep] failed to persist staleness for ${staged.id}; ` +
            `sweep continues: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (result.newlyStale.length > 0) {
    logger.info(
      `[proactiveStalenessSweep] slug=${opts.slug} inspected=${String(result.inspected)} ` +
        `newlyStale=${String(result.newlyStale.length)}`,
    );
  }
  return result;
}
