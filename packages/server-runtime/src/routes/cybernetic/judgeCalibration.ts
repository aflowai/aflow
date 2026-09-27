import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { createTenantContext, withTenantSchema, evalLabels, memoryDocs } from '@aflow/database';
import { EvalLabelVerdictSchema } from '@aflow/schemas';
import type { CriterionResult } from '@aflow/schemas';
import { requireOperatorPrincipal } from '../../lib/operatorPrincipal.js';
import { databaseErrorText } from '../../lib/databaseErrors.js';

const CriterionScopeSchema = z.union([
  z.literal('goal'),
  z.literal('trajectory'),
  z.object({ task: z.string().min(1).max(256) }),
]);
type CriterionScope = z.infer<typeof CriterionScopeSchema>;

/** Convert a CriterionScope to a stable string key for storage/indexing. */
function scopeToKey(scope: CriterionScope): string {
  if (typeof scope === 'string') return scope;
  return `task:${scope.task}`;
}

/** Shape of the stored EvalResult JSON we need to extract from. */
interface StoredEvalResult {
  goalResults?: CriterionResult[];
  taskResults?: Record<string, CriterionResult[]>;
  trajectoryResults?: CriterionResult[];
}

/**
 * Find the judge criterion result for a given criterion name in a specific
 * scope. Scope disambiguates same-named criteria across goal/task/trajectory.
 */
function findJudgeCriterionResult(
  evalResult: StoredEvalResult,
  criterionId: string,
  scope: CriterionScope,
): CriterionResult | undefined {
  const match = (r: CriterionResult) =>
    r.criterionType === 'judge' && r.criterionName === criterionId;

  if (scope === 'goal') {
    return evalResult.goalResults?.find(match);
  }
  if (scope === 'trajectory') {
    return evalResult.trajectoryResults?.find(match);
  }
  // scope is { task: taskId }
  const taskCriteria = evalResult.taskResults?.[scope.task];
  return taskCriteria?.find(match);
}

/**
 * Extract the judge verdict label from a CriterionResult.
 * The evidence field follows the format: `Judge [model]: pass|fail|partial (score)`
 */
function extractJudgeLabel(cr: CriterionResult): string {
  const evidence = cr.evidence ?? '';
  const labelMatch = /Judge \[.*?\]: (pass|fail|partial)/.exec(evidence);
  if (labelMatch?.[1]) return labelMatch[1];
  return cr.passed ? 'pass' : 'fail';
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const judgeCalibrationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  // -------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/judge-calibration
  // -------------------------------------------------------------------------

  app.post(
    '/:spaceId/judge-calibration',
    {
      config: {
        authz: {
          resource: 'space',
          action: 'write',
          resourceIdFrom: 'param',
          resourceIdParam: 'spaceId',
        },
      },
      schema: {
        tags: ['Cybernetic'],
        summary: 'Record a human label for a Judge criterion run',
        description:
          'Only verdict, scope, and critique are accepted from the client. ' +
          'judgeLabel and judgeScore are extracted server-side from the ' +
          'stored eval result, and labeledBy is stamped from the authenticated ' +
          'principal, so calibration data stays trustworthy. Operator-only: ' +
          'labels are ground truth, so agent (service-principal) callers are rejected.',
        params: z.object({
          spaceId: z.string().uuid(),
        }),
        body: z.object({
          /** The criterion name to label (must match a judge criterion in the eval result). */
          criterionId: z.string().min(1).max(200),
          /** The workflow run ID whose eval result contains the judge verdict. */
          runId: z.string().min(1).max(256),
          /** Which scope the criterion belongs to — disambiguates same-named criteria. */
          scope: CriterionScopeSchema,
          /** The operator's binary assessment. */
          verdict: EvalLabelVerdictSchema,
          /** Why — the critique feeds judge few-shots. */
          critique: z.string().min(1).max(8000),
          /** Path to the eval suite (e.g. /evals/daily-metrics/suite.json). */
          evalSuitePath: z.string().min(1).max(512),
        }),
        response: {
          201: z.object({ id: z.string().uuid(), message: z.string() }),
          403: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const body = request.body;
      const tenantCtx = createTenantContext(tenant.tenantId);

      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;
      const labeledByUserId = operator.userId;

      // Derive the workflow slug from evalSuitePath: /evals/{slug}/suite.json
      const slugMatch = /^\/evals\/([^/]+)\/suite\.json$/.exec(body.evalSuitePath);
      if (!slugMatch?.[1]) {
        return reply.status(404).send({
          error: `Invalid evalSuitePath format: expected /evals/{slug}/suite.json`,
        });
      }
      const workflowSlug = slugMatch[1];

      // Load the stored eval result for this run
      const resultPath = `/evals/${workflowSlug}/results/${body.runId}.json`;
      const resultRows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({ inlineContent: memoryDocs.inlineContent })
          .from(memoryDocs)
          .where(
            and(
              eq(memoryDocs.spaceId, spaceId),
              eq(memoryDocs.path, resultPath),
              isNull(memoryDocs.deletedAt),
            ),
          )
          .limit(1),
      );

      const resultRow = resultRows[0];
      if (!resultRow?.inlineContent) {
        return reply.status(404).send({
          error: `No eval result found at ${resultPath}`,
        });
      }

      let evalResult: StoredEvalResult;
      try {
        evalResult = JSON.parse(resultRow.inlineContent) as StoredEvalResult;
      } catch {
        return reply.status(404).send({
          error: `Failed to parse eval result at ${resultPath}`,
        });
      }

      // Find the judge criterion result in the specified scope
      const judgeCriterion = findJudgeCriterionResult(evalResult, body.criterionId, body.scope);
      if (!judgeCriterion) {
        const scopeLabel = typeof body.scope === 'string' ? body.scope : `task:${body.scope.task}`;
        return reply.status(404).send({
          error: `No judge criterion "${body.criterionId}" found in ${scopeLabel} scope for run "${body.runId}"`,
        });
      }

      // Extract judge verdict from the stored criterion result
      const judgeLabel = extractJudgeLabel(judgeCriterion);
      const judgeScore = judgeCriterion.score;

      try {
        const vals: typeof evalLabels.$inferInsert = {
          spaceId,
          runId: body.runId,
          evalSuitePath: body.evalSuitePath,
          criterionId: body.criterionId,
          scopeKey: scopeToKey(body.scope),
          verdict: body.verdict,
          judgeLabel,
          critique: body.critique,
          // Operator-picked runs are an enriched sample, not the uniform
          // random slice — never scorecard material (D10).
          partition: 'exemplar',
          labeledByUserId,
        };
        if (judgeScore !== undefined) vals.judgeScore = String(judgeScore);

        const [inserted] = await withTenantSchema(db, tenantCtx, async (tx) =>
          tx.insert(evalLabels).values(vals).returning({ id: evalLabels.id }),
        );

        return await reply.status(201).send({
          id: inserted!.id,
          message: 'Calibration label recorded',
        });
      } catch (error: unknown) {
        const message = databaseErrorText(error);
        if (message.includes('unique') || message.includes('duplicate')) {
          return reply.status(409).send({
            error: `Label already exists for criterion "${body.criterionId}" on run "${body.runId}"`,
          });
        }
        throw error;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/spaces/:spaceId/judge-calibration/:criterionId
  // -------------------------------------------------------------------------

  app.get(
    '/:spaceId/judge-calibration/:criterionId',
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
        summary: 'Get calibration stats for a Judge criterion',
        params: z.object({
          spaceId: z.string().uuid(),
          criterionId: z.string().min(1).max(200),
        }),
        querystring: z.object({
          evalSuitePath: z.string().min(1).max(512).optional(),
          scopeKey: z.string().min(1).max(300).optional(),
        }),
        response: {
          200: z.object({
            criterionId: z.string(),
            agreementRate: z.number().min(0).max(1).nullable(),
            /** Total count across all labels (not just the returned sample page). */
            totalCount: z.number().int().min(0),
            /** Number of samples returned in this response (capped at 100). */
            sampleCount: z.number().int().min(0),
            samples: z.array(
              z.object({
                runId: z.string(),
                verdict: z.string(),
                judgeLabel: z.string().nullable(),
                judgeScore: z.string().nullable(),
                critique: z.string(),
                labeledAt: z.string(),
                agreed: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, criterionId } = request.params;
      const { evalSuitePath, scopeKey } = request.query;
      const tenantCtx = createTenantContext(tenant.tenantId);

      const conditions = [eq(evalLabels.spaceId, spaceId), eq(evalLabels.criterionId, criterionId)];
      if (evalSuitePath) {
        conditions.push(eq(evalLabels.evalSuitePath, evalSuitePath));
      }
      if (scopeKey) {
        conditions.push(eq(evalLabels.scopeKey, scopeKey));
      }

      // Get total count and agreement rate from the full dataset
      const [countRow] = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select({
            total: sql<number>`count(*)::int`,
            agreed: sql<number>`count(*) filter (where judge_label is not null and verdict = judge_label)::int`,
            comparable: sql<number>`count(*) filter (where judge_label is not null)::int`,
          })
          .from(evalLabels)
          .where(and(...conditions)),
      );

      const totalCount = countRow?.total ?? 0;
      const agreedTotal = countRow?.agreed ?? 0;
      const comparableTotal = countRow?.comparable ?? 0;
      const agreementRate = comparableTotal > 0 ? agreedTotal / comparableTotal : null;

      // Get recent samples (capped)
      const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
        tx
          .select()
          .from(evalLabels)
          .where(and(...conditions))
          .orderBy(sql`${evalLabels.labeledAt} DESC`)
          .limit(100),
      );

      const samples = rows.map((r) => ({
        runId: r.runId,
        verdict: r.verdict,
        judgeLabel: r.judgeLabel,
        judgeScore: r.judgeScore,
        critique: r.critique,
        labeledAt: r.labeledAt.toISOString(),
        agreed: r.judgeLabel !== null && r.verdict === r.judgeLabel,
      }));

      return {
        criterionId,
        agreementRate,
        totalCount,
        sampleCount: samples.length,
        samples,
      };
    },
  );
};
