/**
 * Workflow eval bundle and Coach feedback read routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, spaces } from '@aflow/database';
import {
  WorkflowEvalsBundleSchema,
  CoachObservationSchema,
  CoachLearningSchema,
  DirectiveLearningPolicySchema,
  computeEvalQualityReport,
} from '@aflow/schemas';
import type { StagedChangeOp } from '@aflow/schemas';
import {
  WorkflowSlugParamsSchema,
  spaceReadAuthz,
  spaceWriteAuthz,
  createWorkflowRepo,
  getDb,
} from './shared.js';
import { listCoachLearningsForSkill, resolveLearning } from '@aflow/cybernetic-runtime';
import {
  loadEvalSuite,
  loadEvalBaseline,
  loadRecentEvalResults,
  loadRecentObservations,
} from './loaders.js';
import { applyOperatorEvalOps } from '../../services/operatorEvalWrite.js';

export function registerEvalsAndCoachRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Operator-authored eval-criterion writes. Applies immediately (the operator
  // is the authority) through the shared apply core, tagged `source: 'operator'`
  // — never the Coach proposal queue. See services/operatorEvalWrite.ts.
  app.post(
    '/:spaceId/workflows/:slug/eval-criteria',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Apply operator-authored eval-criterion changes',
        params: WorkflowSlugParamsSchema,
        body: z.object({
          ops: z.array(z.record(z.unknown())).min(1).max(10),
          rationale: z.string().min(1).max(500),
        }),
        response: {
          200: z.object({
            ok: z.literal(true),
            stagedChangeId: z.string(),
            revision: z.number().optional(),
          }),
          401: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
          422: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const authUser = request.authUser;
      if (!authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      const { slug } = request.params;
      const { ops, rationale } = request.body;

      // Only eval-criterion ops may travel this route — the apply path validates
      // their shape, but reject foreign op kinds up front.
      for (const op of ops) {
        const kind = op['op'];
        if (typeof kind !== 'string' || !kind.startsWith('eval.criterion.')) {
          return reply
            .status(422)
            .send({ error: 'invalid_op', message: 'Only eval.criterion.* ops are allowed here.' });
        }
      }

      const result = await applyOperatorEvalOps({
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        slug,
        ops: ops as StagedChangeOp[],
        rationale,
        operatorUserId: authUser.userId,
        db: getDb(fastify),
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.code, message: result.detail });
      }
      return reply.send({
        ok: true as const,
        stagedChangeId: result.stagedChangeId,
        ...(result.revision !== undefined ? { revision: result.revision } : {}),
      });
    },
  );

  // Operator ratifies / rejects a Coach learning (the skill's memory muscle).
  app.post(
    '/:spaceId/workflows/:slug/learnings/:learningId/resolve',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Ratify or reject a Coach learning',
        params: z.object({
          spaceId: z.string().uuid(),
          slug: z.string().min(1).max(200),
          learningId: z.string().uuid(),
        }),
        body: z.object({ action: z.enum(['ratify', 'reject']) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
          422: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const authUser = request.authUser;
      if (!authUser) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      const { slug, learningId } = request.params;
      const result = await resolveLearning({
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        slug,
        learningId,
        action: request.body.action,
        operatorUserId: authUser.userId,
        db: getDb(fastify),
      });
      if (!result.ok) {
        return reply
          .status(result.status)
          .send({ error: 'resolve_failed', message: result.detail });
      }
      return reply.send({ ok: true as const });
    },
  );

  app.get(
    '/:spaceId/workflows/:slug/evals',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Eval suite, baseline, and recent results for a workflow',
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          /** Cap on recent results returned (default 20, max 100). */
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
        response: { 200: WorkflowEvalsBundleSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const limit = request.query.limit ?? 20;

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createWorkflowRepo(fastify, tenant.tenantId);

      const [suite, baseline, recentResults] = await Promise.all([
        loadEvalSuite(repo, spaceId, slug),
        loadEvalBaseline(repo, spaceId, slug),
        loadRecentEvalResults(repo, spaceId, slug, limit),
      ]);

      let qualityReport = null;
      if (suite) {
        let minSamples = 10;
        try {
          const spaceRows = await withTenantSchema(getDb(fastify), tenantCtx, async (tx) =>
            tx
              .select({ directives: spaces.directives })
              .from(spaces)
              .where(eq(spaces.id, spaceId))
              .limit(1),
          );
          const directivesRaw = spaceRows[0]?.directives as Record<string, unknown> | null;
          const policy = DirectiveLearningPolicySchema.parse(
            directivesRaw?.['learningPolicy'] ?? {},
          );
          minSamples = policy.evalQualityReport.alwaysPassesMinSamples;
        } catch {
          // Schema default stands.
        }
        qualityReport = computeEvalQualityReport(suite, recentResults, { minSamples });
      }

      return {
        workflowSlug: slug,
        suite,
        baseline,
        recentResults,
        qualityReport,
      };
    },
  );

  app.get(
    '/:spaceId/workflows/:slug/observations',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Recent Coach observations for a workflow',
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).optional(),
        }),
        response: {
          200: z.object({
            workflowSlug: z.string(),
            observations: z.array(CoachObservationSchema),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const limit = request.query.limit ?? 20;
      const repo = createWorkflowRepo(fastify, tenant.tenantId);
      const observations = await loadRecentObservations(repo, spaceId, slug, limit);
      return { workflowSlug: slug, observations };
    },
  );

  app.get(
    '/:spaceId/workflows/:slug/learnings',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Recent durable Coach learnings for a workflow',
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).optional(),
        }),
        response: {
          200: z.object({
            workflowSlug: z.string(),
            learnings: z.array(CoachLearningSchema),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const limit = request.query.limit ?? 20;
      const learnings = await listCoachLearningsForSkill(getDb(fastify), tenant.tenantId, {
        spaceId,
        skillSlug: slug,
        limit,
      });
      return { workflowSlug: slug, learnings };
    },
  );
}
