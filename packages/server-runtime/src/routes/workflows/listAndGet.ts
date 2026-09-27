/**
 * Workflow list and detail read routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { listPlatformSkillBundles } from '@aflow/platform-artifacts';
import { materializeAndValidateSkillConfig } from '@aflow/cybernetic-runtime';
import {
  SkillManifestSchema,
  SkillTombstoneSchema,
  type Workflow,
  type SkillTombstone,
  type SkillManifest,
} from '@aflow/schemas';
import { loadWorkflowContentWithDiagnostic } from '../../services/workflowLoader.js';
import {
  ErrorSchema,
  WorkflowSummarySchema,
  WorkflowDetailSchema,
  WorkflowSlugParamsSchema,
  platformWorkflowUuid,
  spaceReadAuthz,
  createWorkflowRepo,
} from './shared.js';

export function registerListAndGetRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/workflows',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'List workflows in a space',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          archived: z.enum(['false', 'true', 'only']).optional(),
        }),
        response: {
          200: z.object({ workflows: z.array(WorkflowSummarySchema) }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const archivedFlag = request.query.archived ?? 'false';
      const includeDeleted: boolean | 'only' =
        archivedFlag === 'only' ? 'only' : archivedFlag === 'true' ? true : false;

      const repo = createWorkflowRepo(fastify, tenant.tenantId);
      const payloadStore = fastify.appContext.payloadStore;

      // List all workflow docs in the space — `/workflows/{slug}/workflow.json`.
      // 200 is plenty for any realistic space and avoids unbounded scans.
      const docs = await repo.list({
        pathPrefix: '/workflows',
        scope: { spaceId },
        limit: 200,
        includeDeleted,
      });

      const summaries: Array<z.infer<typeof WorkflowSummarySchema>> = [];

      // Platform authoring skills (compose-skill, bind-capability, …). The
      // operator-facing `/skills` list hides these; the set is the canonical
      // source so future authoring bundles are covered automatically.
      const systemSkillSlugs = new Set(listPlatformSkillBundles().map((b) => b.skillId));

      for (const doc of docs) {
        if (!doc.path.endsWith('/workflow.json')) continue;
        const result = await loadWorkflowContentWithDiagnostic(
          repo,
          payloadStore,
          doc.id,
          spaceId,
          {
            includeDeleted: includeDeleted !== false,
          },
        );

        const archivedAt = doc.deletedAt ? doc.deletedAt.toISOString() : null;

        if (result.workflow) {
          const wf = result.workflow;
          summaries.push({
            slug: wf.slug,
            name: wf.name,
            description: wf.description,
            mode: wf.mode,
            status: wf.status,
            taskCount: wf.tasks.length,
            outcomeCount: wf.outcomes.length,
            hasActivation: wf.activation !== undefined,
            hasAssignedAgent: wf.assignedAgent !== undefined,
            origin: wf.origin ?? null,
            system: systemSkillSlugs.has(wf.slug),
            revision: wf.revision,
            updatedAt: doc.updatedAt.toISOString(),
            docId: doc.id,
            archivedAt,
          });
        } else if (result.raw) {
          // Degraded summary: workflow JSON exists but fails schema validation.
          // Show it in the UI with a warning instead of silently dropping it.
          const raw = result.raw as Record<string, unknown>;
          const slug =
            typeof raw['slug'] === 'string' ? raw['slug'] : (doc.path.split('/')[2] ?? 'unknown');
          fastify.log.warn(
            { slug, docId: doc.id, error: result.error },
            `Workflow "${slug}" fails schema validation — returning degraded summary`,
          );
          summaries.push({
            slug,
            name: typeof raw['name'] === 'string' ? raw['name'] : slug,
            description: typeof raw['description'] === 'string' ? raw['description'] : '',
            mode: (['optimization', 'process', 'project'].includes(raw['mode'] as string)
              ? raw['mode']
              : 'process') as 'optimization' | 'process' | 'project',
            status: (['draft', 'approved', 'completed', 'abandoned'].includes(
              raw['status'] as string,
            )
              ? raw['status']
              : 'draft') as 'draft' | 'approved' | 'completed' | 'abandoned',
            taskCount: Array.isArray(raw['tasks']) ? raw['tasks'].length : 0,
            outcomeCount: Array.isArray(raw['outcomes']) ? raw['outcomes'].length : 0,
            hasActivation: raw['activation'] !== undefined,
            hasAssignedAgent: raw['assignedAgent'] !== undefined,
            origin: typeof raw['origin'] === 'string' ? raw['origin'] : null,
            system: systemSkillSlugs.has(slug),
            revision: typeof raw['revision'] === 'number' ? raw['revision'] : 0,
            updatedAt: doc.updatedAt.toISOString(),
            docId: doc.id,
            validationError: result.error ?? 'Unknown validation error',
            archivedAt,
          });
        }
        // If result.raw is also null (doc missing/deleted/unparseable), skip entirely
      }

      if (includeDeleted !== 'only') {
        const seenSlugs = new Set(summaries.map((s) => s.slug));
        for (const bundle of listPlatformSkillBundles()) {
          if (seenSlugs.has(bundle.skillId)) continue;
          const wf = bundle.workflow;
          summaries.push({
            slug: wf.slug,
            name: wf.name,
            description: wf.description,
            mode: wf.mode as 'optimization' | 'process' | 'project',
            status: wf.status as 'draft' | 'approved' | 'completed' | 'abandoned',
            taskCount: wf.tasks.length,
            outcomeCount: wf.outcomes.length,
            hasActivation: false,
            hasAssignedAgent: false,
            origin: 'platform',
            system: systemSkillSlugs.has(wf.slug),
            revision: wf.revision,
            updatedAt: wf.updatedAt,
            docId: `platform:${wf.slug}`,
          });
        }
      }

      if (includeDeleted !== false) {
        const tombstoneDocs = await repo.list({
          pathPrefix: '/skills/',
          scope: { spaceId },
          limit: 200,
          filters: { docType: ['skill_tombstone'] },
        });
        for (const td of tombstoneDocs) {
          if (!td.path.endsWith('/tombstone.json')) continue;
          // Reload with body via getById — list projection doesn't carry inlineContent.
          const doc = await repo.getById(td.id, spaceId);
          if (!doc?.inlineContent) continue;
          let tombstone: SkillTombstone;
          try {
            const parsed = SkillTombstoneSchema.safeParse(JSON.parse(doc.inlineContent));
            if (!parsed.success) continue;
            tombstone = parsed.data;
          } catch {
            continue;
          }
          summaries.push({
            slug: tombstone.workflowSlug,
            name: tombstone.name,
            description: '',
            mode: 'process',
            status: 'abandoned',
            taskCount: 0,
            outcomeCount: 0,
            hasActivation: false,
            hasAssignedAgent: false,
            origin: tombstone.origin,
            system: systemSkillSlugs.has(tombstone.workflowSlug),
            revision: tombstone.workflowRevision,
            updatedAt: tombstone.purgedAt,
            docId: td.id,
            archivedAt: tombstone.archivedAt,
            purgedAt: tombstone.purgedAt,
            purgedByUserId: tombstone.purgedByUserId,
          });
        }
      }

      if (summaries.length > 0) {
        const slugSet = new Set(summaries.map((s) => s.slug));
        const manifestDocs = await repo.list({
          pathPrefix: '/skills/',
          scope: { spaceId },
          limit: 200,
          filters: { docType: ['skill_manifest'] },
          includeDeleted,
        });
        const wantsDeleted = includeDeleted !== false;
        for (const md of manifestDocs) {
          if (!md.path.endsWith('/manifest.json')) continue;
          const skillId = md.path.split('/')[2];
          if (!skillId || !slugSet.has(skillId)) continue;
          // Reload with body — list projection doesn't carry inlineContent.
          const doc = await repo.getById(md.id, spaceId, { includeDeleted: wantsDeleted });
          if (!doc?.inlineContent) continue;
          try {
            const parsed = SkillManifestSchema.safeParse(JSON.parse(doc.inlineContent));
            if (!parsed.success || !parsed.data.sourceCatalogId) continue;
            const target = summaries.find((s) => s.slug === parsed.data.workflowSlug);
            if (target) target.sourceCatalogId = parsed.data.sourceCatalogId;
          } catch {
            // unparseable manifest — leave summary unannotated
          }
        }
      }

      // Stable order: alphabetical by slug. The Process Map and Workflow
      // Inspector both rely on this for predictable layout.
      summaries.sort((a, b) => a.slug.localeCompare(b.slug));

      return { workflows: summaries };
    },
  );

  app.get(
    '/:spaceId/workflows/:slug',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Get a workflow by slug',
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          includeArchived: z.coerce.boolean().optional(),
        }),
        response: {
          200: WorkflowDetailSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const includeArchived = request.query.includeArchived === true;

      const repo = createWorkflowRepo(fastify, tenant.tenantId);
      const payloadStore = fastify.appContext.payloadStore;

      const path = `/workflows/${slug}/workflow.json`;
      const doc = await repo.getByPath(path, spaceId, { includeDeleted: includeArchived });

      const docIsArchived = !!doc && !!doc.deletedAt;
      if (!doc || (doc.deletedAt && !includeArchived)) {
        const { getPlatformWorkflow, getPlatformEvalSuite } =
          await import('@aflow/platform-artifacts');
        const platformWf = getPlatformWorkflow(slug);
        if (platformWf) {
          const platformEval = getPlatformEvalSuite(slug);
          return reply.send({
            workflow: { ...platformWf, id: platformWorkflowUuid(slug) } as unknown as Workflow,
            docId: `platform:${slug}`,
            hasLedger: false,
            hasEvalSuite: !!platformEval,
          });
        }
        const tombstoneDoc = await repo.getByPath(`/skills/${slug}/tombstone.json`, spaceId);
        if (tombstoneDoc?.inlineContent) {
          const parsed = SkillTombstoneSchema.safeParse(JSON.parse(tombstoneDoc.inlineContent));
          if (parsed.success) {
            const t = parsed.data;
            return reply.send({
              docId: tombstoneDoc.id,
              hasLedger: false,
              hasEvalSuite: false,
              archivedAt: t.archivedAt,
              purgedAt: t.purgedAt,
              purgedByUserId: t.purgedByUserId,
              tombstoneName: t.name,
            });
          }
        }
        return reply.status(404).send({ error: 'NotFound', message: `Workflow ${slug} not found` });
      }

      const result = await loadWorkflowContentWithDiagnostic(repo, payloadStore, doc.id, spaceId, {
        includeDeleted: docIsArchived,
      });

      // Doc exists but neither validates nor has parseable raw — genuinely
      // unreadable. Treat as 404 since there is nothing the inspector can
      // render. Note: result.raw === null only when JSON parse / payload
      // retrieval itself failed, not when WorkflowSchema validation failed.
      if (!result.workflow && !result.raw) {
        return reply
          .status(404)
          .send({ error: 'NotFound', message: `Workflow ${slug} content unavailable` });
      }

      // 104c Phase 2: cybernetic runs live in the relational workflow_runs table;
      // a legacy `ledger.json` may still exist for older workflows, so derive
      // `hasLedger` from whether that doc is actually present.
      const ledger = await repo.getByPath(`/workflows/${slug}/ledger.json`, spaceId);
      const evalDocs = await repo.list({
        pathPrefix: `/evals/${slug}`,
        scope: { spaceId },
        limit: 1,
      });

      // Degraded path: workflow JSON exists but fails validation. Return
      // 200 with rawWorkflow + validationError so the inspector can render
      // a degraded view (mirrors the workflows-list summary path) instead
      if (!result.workflow) {
        return reply.send({
          rawWorkflow: result.raw,
          validationError: result.error ?? 'Schema validation failed',
          docId: doc.id,
          hasLedger: Boolean(ledger && !ledger.deletedAt),
          hasEvalSuite: evalDocs.length > 0,
          archivedAt: doc.deletedAt ? doc.deletedAt.toISOString() : null,
        });
      }

      const { validity: contractValidity } = materializeAndValidateSkillConfig({
        tasks: result.workflow.tasks,
        stateVariables: result.workflow.stateVariables,
        output: result.workflow.output,
        runInputs: result.workflow.runInputs,
      });

      // Surface the campaign contract from the SkillManifest (a separate doc,
      // keyed by its own skillId — related to the workflow by `workflowSlug`,
      // not by path) so the designer can render the Campaign node and give
      // `$campaign` refs a definition.
      // Returns the manifest's campaign when it both parses and belongs to this
      // workflow; `matched` distinguishes "this skill's manifest, no campaign"
      // from "not this skill's manifest" so the caller can stop scanning.
      const readManifestCampaign = (
        raw: string | null | undefined,
      ): { matched: boolean; campaign: SkillManifest['campaign'] } => {
        if (!raw) return { matched: false, campaign: undefined };
        try {
          const parsed = SkillManifestSchema.safeParse(JSON.parse(raw));
          if (parsed.success && parsed.data.workflowSlug === slug) {
            return { matched: true, campaign: parsed.data.campaign };
          }
        } catch {
          // unparseable manifest — ignore this one
        }
        return { matched: false, campaign: undefined };
      };

      // Fast path: most skills store the manifest under their own slug
      // (skillId === workflowSlug), so a direct lookup is O(1) and uncapped.
      let campaign: SkillManifest['campaign'];
      const directManifest = await repo
        .getByPath(`/skills/${slug}/manifest.json`, spaceId)
        .catch(() => null);
      const direct = readManifestCampaign(directManifest?.inlineContent);
      campaign = direct.campaign;

      // Fallback: skillId differs from workflowSlug — scan and match by field.
      if (!direct.matched) {
        const manifestDocs = await repo
          .list({
            pathPrefix: '/skills/',
            scope: { spaceId },
            limit: 200,
            filters: { docType: ['skill_manifest'] },
          })
          .catch(() => []);
        for (const md of manifestDocs) {
          if (!md.path.endsWith('/manifest.json')) continue;
          const full = await repo.getById(md.id, spaceId).catch(() => null);
          const { matched, campaign: found } = readManifestCampaign(full?.inlineContent);
          if (matched) {
            campaign = found;
            break;
          }
        }
      }

      return reply.send({
        workflow: result.workflow,
        rawWorkflow: result.raw,
        docId: doc.id,
        hasLedger: Boolean(ledger && !ledger.deletedAt),
        hasEvalSuite: evalDocs.length > 0,
        contractValidity,
        ...(campaign ? { campaign } : {}),
        archivedAt: doc.deletedAt ? doc.deletedAt.toISOString() : null,
      });
    },
  );
}
