/**
 * Operator-only eval-batch control (Plan 269 D17). Cancellation is the kill
 * switch for a batch spending real money — it exists ONLY as authenticated
 * server REST: it is not a registry operation, appears in no agent preset,
 * and rejects service-principal (agent) callers outright. The route flips
 * the durable head to 'cancelling'; the batch engine drains it — stopping
 * undispatched trials, cancelling in-flight runs through the normal
 * run-cancel path, and keeping completed verdicts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createByokAiClientFactory } from '@aflow/credential-resolver';
import {
  buildEvalBatchDetail,
  buildEvalBatchList,
  buildEvalTrialDetail,
  buildJudgeScorecardsForBatch,
  computeEvalBatchPreflightEstimate,
  executeRejudgeForCriterion,
  getEvalBatchHead,
  launchEvalBatch,
  requestEvalBatchCancel,
  resolveEvalBatchComparison,
  type EvalBatchCompareRefusalCode,
  type EvalBatchLaunchRefusalCode,
} from '@aflow/cybernetic-runtime';
import {
  EvalBatchCompareOutputSchema,
  EvalBatchGetOutputSchema,
  EvalBatchListOutputSchema,
  EvalBatchPreflightSchema,
  EvalBatchRunInputSchema,
  EvalBatchRunOutputSchema,
  EvalTrialDetailViewSchema,
  JudgeScorecardSchema,
} from '@aflow/schemas';
import {
  WorkflowSlugParamsSchema,
  spaceReadAuthz,
  spaceWriteAuthz,
  getDb,
  ErrorSchema,
} from './shared.js';
import { requireOperatorPrincipal } from '../../lib/operatorPrincipal.js';

const BatchParamsSchema = z.object({
  spaceId: z.string().uuid(),
  batchId: z.string().uuid(),
});

const TrialParamsSchema = BatchParamsSchema.extend({
  caseRevisionId: z.string().uuid(),
  trial: z.coerce.number().int().positive(),
});

const LAUNCH_REFUSAL_STATUS: Record<EvalBatchLaunchRefusalCode, 404 | 409 | 422> = {
  // Unreachable from here — this route resolves the operator before launching —
  // but the map is total so the code cannot be added without choosing a status.
  EVAL_BATCH_NO_CREDENTIAL_OWNER: 422,
  EVAL_BATCH_JUDGE_CREDENTIAL_UNRESOLVED: 422,
  EVAL_BATCH_WORKFLOW_NOT_FOUND: 404,
  EVAL_DATASET_NOT_FOUND: 404,
  EVAL_DATASET_VERSION_NOT_FOUND: 404,
  WORKFLOW_REVISION_DRIFT: 409,
  EVAL_BATCH_CONTRACT_INVALID: 422,
  EVAL_BATCH_EMPTY_DATASET: 422,
  // The dataset is intact on disk; some of it cannot be read as cases, and the
  // operator repairs or removes those before a batch can mean anything.
  EVAL_BATCH_UNREADABLE_CASE: 422,
  EVAL_BATCH_SEALED_UNBOUND: 422,
  EVAL_BATCH_SEALED_LIVE_BINDING: 422,
  EVAL_BATCH_COST_PREFLIGHT_EXCEEDS_CEILING: 422,
};

const COMPARE_REFUSAL_STATUS: Record<EvalBatchCompareRefusalCode, 404 | 409> = {
  EVAL_BATCH_NOT_FOUND: 404,
  EVAL_BASELINE_BATCH_MISSING: 404,
  EVAL_BASELINE_NOT_PINNED: 409,
  EVAL_BATCH_IS_BASELINE: 409,
  EVAL_BATCH_COMPARE_DIFFERENT_SKILLS: 409,
  EVAL_BATCH_NOT_TERMINAL: 409,
};

export function registerEvalBatchRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/eval-batches',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'List eval batches, newest first (optionally filtered to one skill)',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          workflowSlug: z.string().min(1).max(128).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: {
          200: EvalBatchListOutputSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const batches = await buildEvalBatchList(getDb(fastify), tenant.tenantId, {
        spaceId: space.spaceId,
        workflowSlug: request.query.workflowSlug,
        limit: request.query.limit,
      });
      return reply.send({ batches });
    },
  );

  app.get(
    '/:spaceId/eval-batches/:batchId',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Eval batch detail — head, provenance manifest, scorecard, per-case dispositions, baseline view',
        params: BatchParamsSchema,
        response: {
          200: EvalBatchGetOutputSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const detail = await buildEvalBatchDetail(getDb(fastify), tenant.tenantId, {
        spaceId: space.spaceId,
        batchId: request.params.batchId,
      });
      if (!detail) {
        return reply.status(404).send({
          error: 'batch_not_found',
          message: `No eval batch '${request.params.batchId}' exists in this space.`,
        });
      }
      return reply.send(detail);
    },
  );

  app.get(
    '/:spaceId/eval-batches/:batchId/cases/:caseRevisionId/trials/:trial',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'One trial in attribution detail — expectation results, judge verdicts, the endpoints it reached, and what it replied',
        params: TrialParamsSchema,
        response: {
          200: EvalTrialDetailViewSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      // The attribution payload is the ruler's own material — the subject's
      // reply, and every fact its tools returned. Space-read is not enough:
      // an agent principal holding it could read what it is measured against.
      if (requireOperatorPrincipal(request, reply) === null) return reply;
      const payloadStore = fastify.appContext.payloadStore;
      const detail = await buildEvalTrialDetail(
        getDb(fastify),
        tenant.tenantId,
        {
          spaceId: space.spaceId,
          batchId: request.params.batchId,
          caseRevisionId: request.params.caseRevisionId,
          trial: request.params.trial,
        },
        payloadStore ? { retrievePayload: (ref) => payloadStore.retrieve(ref) } : {},
      );
      if (!detail) {
        return reply.status(404).send({
          error: 'trial_not_found',
          message: `No trial ${String(request.params.trial)} of case '${request.params.caseRevisionId}' exists in batch '${request.params.batchId}'.`,
        });
      }
      return reply.send(detail);
    },
  );

  app.get(
    '/:spaceId/eval-batches/:batchId/comparison',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'D12 paired comparison — this batch against the pinned baseline, or against an explicit reference batch',
        params: BatchParamsSchema,
        querystring: z.object({
          /** Explicit reference (side A, deltas read A → B). Omit to compare against the pinned baseline. */
          againstBatchId: z.string().uuid().optional(),
        }),
        response: {
          // The REST read returns the op output minus its agent-facing summary paragraph.
          200: EvalBatchCompareOutputSchema.omit({ summary: true }),
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const resolution = await resolveEvalBatchComparison(
        getDb(fastify),
        tenant.tenantId,
        space.spaceId,
        request.query.againstBatchId !== undefined
          ? { batchIdA: request.query.againstBatchId, batchIdB: request.params.batchId }
          : { batchId: request.params.batchId, against: 'baseline' },
      );
      if (!resolution.ok) {
        return reply
          .status(COMPARE_REFUSAL_STATUS[resolution.code])
          .send({ error: resolution.code, message: resolution.message });
      }
      return reply.send({
        comparison: resolution.comparison,
        ...(resolution.baselineBatchId !== undefined
          ? { baselineBatchId: resolution.baselineBatchId }
          : {}),
        graduationCandidates: resolution.graduationCandidates,
      });
    },
  );

  app.get(
    '/:spaceId/workflows/:slug/eval-batch-preflight',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Pre-launch cost estimate — median of the skill’s recent run costs × cases × trials',
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          trialsPerCase: z.coerce.number().int().min(1).max(10).default(1),
          datasetVersion: z.coerce.number().int().nonnegative().optional(),
        }),
        response: {
          200: EvalBatchPreflightSchema.omit({ costCeilingCents: true }).extend({
            caseCount: z.number().int().nonnegative(),
            resolvedVersion: z.number().int().nonnegative(),
          }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const estimate = await computeEvalBatchPreflightEstimate(getDb(fastify), tenant.tenantId, {
        spaceId: space.spaceId,
        workflowSlug: request.params.slug,
        trialsPerCase: request.query.trialsPerCase,
        datasetVersion: request.query.datasetVersion,
      });
      if (!estimate.ok) {
        return reply.status(404).send({ error: estimate.code, message: estimate.message });
      }
      return reply.send({
        caseCount: estimate.caseCount,
        resolvedVersion: estimate.resolvedVersion,
        perRunMedianCents: estimate.preflight.perRunMedianCents,
        sampleSize: estimate.preflight.sampleSize,
        estimatedCostCents: estimate.preflight.estimatedCostCents,
        ...(estimate.preflight.models !== undefined ? { models: estimate.preflight.models } : {}),
      });
    },
  );

  app.post(
    '/:spaceId/workflows/:slug/eval-batches',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Launch an eval batch (operator-only; validate-then-persist with the mandatory cost ceiling — the D5 trusted launcher)',
        params: WorkflowSlugParamsSchema,
        body: EvalBatchRunInputSchema.omit({ workflowSlug: true }),
        response: {
          201: EvalBatchRunOutputSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;

      const result = await launchEvalBatch({
        db: getDb(fastify),
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        input: { ...request.body, workflowSlug: request.params.slug },
        createdByUserId: operator.userId,
        // Grading carries no credential owner, so the judge resolves at space
        // scope only — the operator's personal key does not answer for it.
        probeJudgeCredential: async (model) => {
          try {
            await createByokAiClientFactory(getDb(fastify)).getClientForModel(model, {
              tenantId: tenant.tenantId as string,
              spaceId: space.spaceId,
            });
            return { ok: true };
          } catch (err) {
            return { ok: false, message: err instanceof Error ? err.message : String(err) };
          }
        },
      });
      if (!result.ok) {
        return reply
          .status(LAUNCH_REFUSAL_STATUS[result.code])
          .send({ error: result.code, message: result.message });
      }
      return reply.status(201).send(result.output);
    },
  );

  app.post(
    '/:spaceId/eval-batches/:batchId/cancel',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Cancel an eval batch (operator-only; the engine drains in-flight trials and keeps completed verdicts)',
        params: BatchParamsSchema,
        response: {
          200: z.object({ ok: z.literal(true), status: z.literal('cancelling') }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: z.object({ error: z.string(), message: z.string(), status: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;

      const db = getDb(fastify);
      const scope = { spaceId: space.spaceId, batchId: request.params.batchId };
      const head = await getEvalBatchHead(db, tenant.tenantId, scope);
      if (!head) {
        return reply.status(404).send({
          error: 'batch_not_found',
          message: `No eval batch '${request.params.batchId}' exists in this space.`,
        });
      }

      const cancelled = await requestEvalBatchCancel(db, tenant.tenantId, scope);
      if (!cancelled) {
        const current = await getEvalBatchHead(db, tenant.tenantId, scope);
        const status = current?.status ?? head.status;
        if (status === 'cancelling') {
          return reply.send({ ok: true as const, status: 'cancelling' as const });
        }
        return reply.status(409).send({
          error: 'not_cancellable',
          message: `Batch is '${status}' — only a queued or running batch can be cancelled.`,
          status,
        });
      }
      return reply.send({ ok: true as const, status: 'cancelling' as const });
    },
  );

  app.get(
    '/:spaceId/eval-batches/:batchId/judge-scorecards',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'D11 judge scorecards for the batch’s subject configuration — validation labels only, advisory',
        params: BatchParamsSchema,
        response: {
          200: z.object({ scorecards: z.array(JudgeScorecardSchema) }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const db = getDb(fastify);
      const head = await getEvalBatchHead(db, tenant.tenantId, {
        spaceId: space.spaceId,
        batchId: request.params.batchId,
      });
      if (!head) {
        return reply.status(404).send({
          error: 'batch_not_found',
          message: `No eval batch '${request.params.batchId}' exists in this space.`,
        });
      }
      const scorecards = await buildJudgeScorecardsForBatch(db, tenant.tenantId, {
        spaceId: space.spaceId,
        batchId: head.id,
      });
      return reply.send({ scorecards });
    },
  );

  app.post(
    '/:spaceId/eval-batches/:batchId/rejudge',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Re-judge a criterion over its labeled trials’ stored evidence (operator-only; new judgeVersion verdicts persist alongside the old, no runs re-executed)',
        params: BatchParamsSchema,
        body: z.object({
          criterionId: z.string().min(1).max(300),
        }),
        response: {
          200: z.object({
            criterionId: z.string(),
            judgeVersions: z.array(z.string()),
            subjects: z.number().int().nonnegative(),
            judged: z.number().int().nonnegative(),
            skippedExisting: z.number().int().nonnegative(),
            errors: z.array(
              z.object({
                caseRevisionId: z.string(),
                trial: z.number().int(),
                message: z.string(),
              }),
            ),
          }),
          403: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;

      const payloadStore = fastify.appContext.payloadStore;
      if (!payloadStore) {
        return reply.status(503).send({
          error: 'payload_store_unavailable',
          message:
            'Re-judging rebuilds evidence from stored payloads; no payload store is configured.',
        });
      }
      const db = getDb(fastify);
      const byokFactory = createByokAiClientFactory(db);
      const result = await executeRejudgeForCriterion({
        db,
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        batchId: request.params.batchId,
        criterionId: request.body.criterionId,
        retrievePayload: (ref) => payloadStore.retrieve(ref),
        resolveClient: async (model) => {
          const { client } = await byokFactory.getClientForModel(model, {
            tenantId: tenant.tenantId as string,
            spaceId: space.spaceId,
          });
          return client;
        },
      });
      if (!result.ok) {
        const status = result.code === 'batch_not_found' ? 404 : 422;
        return reply.status(status).send({ error: result.code, message: result.message });
      }
      return reply.send({
        criterionId: result.criterionId,
        judgeVersions: result.judgeVersions,
        subjects: result.subjects,
        judged: result.judged,
        skippedExisting: result.skippedExisting,
        errors: result.errors,
      });
    },
  );
}
