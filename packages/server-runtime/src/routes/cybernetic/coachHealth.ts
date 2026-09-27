import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  createMemoryDocRepository,
} from '@aflow/database';
import { EntityDirectivesSchema, type EntityDirectives } from '@aflow/schemas';
import { computeCoachHealth } from '@aflow/cybernetic-runtime';

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const coachHealthRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  app.get(
    '/:spaceId/coach-health',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'read',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Cybernetic'],
        summary: 'Coach health stats + drift alert',
        params: z.object({ spaceId: z.string().uuid() }),
        response: {
          200: z.object({
            proposalCount: z.number().int(),
            ratifiedCount: z.number().int(),
            rejectedCount: z.number().int(),
            duplicateSuppressedCount: z.number().int(),
            contextPressureCount: z.number().int(),
            ratificationRate: z.number().nullable(),
            windowLabel: z.string(),
            driftAlert: z.boolean(),
            thresholds: z.object({
              driftRateFloor: z.number(),
              driftSampleFloor: z.number(),
            }),
            dailySeries: z.array(
              z.object({
                date: z.string(),
                proposals: z.number().int(),
                ratified: z.number().int(),
                rejected: z.number().int(),
                suppressed: z.number().int(),
              }),
            ),
            byCategory: z.record(
              z.string(),
              z.object({
                proposals: z.number().int(),
                ratified: z.number().int(),
                rejected: z.number().int(),
                ratificationRate: z.number().nullable(),
              }),
            ),
            causalImpactSummary: z
              .object({
                ratifiedProposalsWithMeasurement: z.number().int(),
                meanEvalScoreLift: z.number().nullable(),
                meanCostDeltaPercent: z.number().nullable(),
                netPositiveProposalRate: z.number().nullable(),
                perCategoryLift: z.record(
                  z.string(),
                  z.object({ mean: z.number().nullable(), n: z.number().int() }),
                ),
              })
              .optional(),
            scarcity: z.object({
              playbook: z.object({
                current: z.number().int(),
                limit: z.number().int().nullable(),
              }),
              evalDensity: z.object({
                totalCriteria: z.number().int(),
                limitPerSkill: z.number().int().nullable(),
              }),
              budgetConsumed: z.object({
                costCents: z.number().int(),
                budgetCents: z.number().int().nullable(),
              }),
            }),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const redis = fastify.appContext.redis;

      // Load directives to get coachHealth knobs
      let windowMs = 7 * 24 * 60 * 60 * 1000;
      let driftRateFloor = 0.3;
      let driftSampleFloor = 5;
      let directives: EntityDirectives | null = null;

      const tenantCtx = createTenantContext(tenant.tenantId);
      try {
        const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
          tx
            .select({ directives: spaces.directives })
            .from(spaces)
            .where(eq(spaces.id, spaceId))
            .limit(1),
        );
        if (spaceRows[0]?.directives) {
          const parsed = EntityDirectivesSchema.parse(spaceRows[0].directives);
          directives = parsed;
          const ch = parsed.learningPolicy.coachHealth;
          windowMs = ch.window;
          driftRateFloor = ch.driftRateFloor;
          driftSampleFloor = ch.driftSampleFloor;
        }
      } catch {
        // Fall back to defaults
      }

      // --- Scarcity data ---
      // Playbook size: count of workflows in the space
      const repo = createMemoryDocRepository(db, tenantCtx);
      const workflowDocs = await repo.list({
        pathPrefix: '/workflows',
        scope: { spaceId },
        limit: 200,
      });
      const playbookCurrent = workflowDocs.filter((d) => d.path.endsWith('/workflow.json')).length;

      // Eval density: count total criteria across all eval suites
      const evalDocs = await repo.list({
        pathPrefix: '/evals',
        scope: { spaceId },
        limit: 200,
      });
      const suiteDocs = evalDocs.filter((d) => d.path.endsWith('/suite.json'));
      let totalCriteria = 0;
      for (const s of suiteDocs) {
        const doc = await repo.getById(s.id, spaceId);
        if (!doc?.inlineContent) continue;
        try {
          const suite = JSON.parse(doc.inlineContent) as Record<string, unknown>;
          const gc = Array.isArray(suite['goalCriteria']) ? suite['goalCriteria'].length : 0;
          const tc = Array.isArray(suite['trajectoryCriteria'])
            ? suite['trajectoryCriteria'].length
            : 0;
          const tkc =
            suite['taskCriteria'] && typeof suite['taskCriteria'] === 'object'
              ? Object.values(suite['taskCriteria'] as Record<string, unknown[]>).reduce(
                  (n, arr) => n + (Array.isArray(arr) ? arr.length : 0),
                  0,
                )
              : 0;
          totalCriteria += gc + tc + tkc;
        } catch {
          // skip malformed
        }
      }

      // Extract limits from directives (cast to record for optional fields
      // not yet in the typed schema — they may be added by operator config)
      const lpRaw = directives?.learningPolicy as Record<string, unknown> | undefined;
      const playbookLimit = (lpRaw?.['maxSkills'] as number | undefined) ?? null;
      const evalLimitPerSkill = (lpRaw?.['maxEvalCriteriaPerSkill'] as number | undefined) ?? null;

      // Cost budget: not populated yet. workflowRuns.totalCostCents is not
      // reliably written (analytics projector pending). Cost budget + budget
      // not yet in DirectiveResourceBudgetSchema (v1 note). Show 0/null
      // until the projector is built.
      const scarcity = {
        playbook: { current: playbookCurrent, limit: playbookLimit },
        evalDensity: { totalCriteria, limitPerSkill: evalLimitPerSkill },
        budgetConsumed: { costCents: 0, budgetCents: null as number | null },
      };

      if (!redis) {
        return {
          proposalCount: 0,
          ratifiedCount: 0,
          rejectedCount: 0,
          duplicateSuppressedCount: 0,
          contextPressureCount: 0,
          ratificationRate: null,
          windowLabel: '7d',
          driftAlert: false,
          thresholds: { driftRateFloor, driftSampleFloor },
          dailySeries: [],
          byCategory: {},
          scarcity,
        };
      }

      const health = await computeCoachHealth({
        tenantId: tenant.tenantId,
        spaceId,
        redis,
        db,
        windowMs,
        driftRateFloor,
        driftSampleFloor,
      });

      return { ...health, scarcity };
    },
  );
};
