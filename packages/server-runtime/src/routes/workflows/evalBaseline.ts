/**
 * Operator-only baseline pin (Plan 269 D12). The baseline is the RULER —
 * declaring it is ground-truth authority, so pin/unpin exist ONLY as
 * authenticated server REST (the D7 pattern): no registry operation, absent
 * from every agent preset, service-principal callers rejected outright.
 * Agents read the pin through eval.batch.get / eval.batch.compare.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  getEvalBaseline,
  getEvalBatchHead,
  pinEvalBaseline,
  unpinEvalBaseline,
} from '@aflow/cybernetic-runtime';
import { EvalBaselineViewSchema } from '@aflow/schemas';
import {
  WorkflowSlugParamsSchema,
  spaceReadAuthz,
  spaceWriteAuthz,
  getDb,
  ErrorSchema,
} from './shared.js';
import { requireOperatorPrincipal } from '../../lib/operatorPrincipal.js';

const BaselineViewSchema = EvalBaselineViewSchema.extend({
  pinnedByUserId: z.string().uuid().nullable(),
});

export function registerEvalBaselineRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/workflows/:slug/eval-baseline',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: "The skill's pinned baseline batch, when one is pinned",
        params: WorkflowSlugParamsSchema,
        response: {
          200: z.object({ baseline: BaselineViewSchema.nullable() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const row = await getEvalBaseline(getDb(fastify), tenant.tenantId, {
        spaceId: space.spaceId,
        workflowSlug: request.params.slug,
      });
      return reply.send({
        baseline:
          row === null
            ? null
            : {
                batchId: row.batchId,
                pinnedAt: row.pinnedAt.toISOString(),
                pinnedByUserId: row.pinnedByUserId,
              },
      });
    },
  );

  app.put(
    '/:spaceId/workflows/:slug/eval-baseline',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Pin a completed batch as the skill baseline (operator-only; repin upserts, the baseline is the ruler)',
        params: WorkflowSlugParamsSchema,
        body: z.object({ batchId: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.literal(true), baseline: BaselineViewSchema }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: z.object({ error: z.string(), message: z.string(), status: z.string() }),
          422: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;

      const db = getDb(fastify);
      const head = await getEvalBatchHead(db, tenant.tenantId, {
        spaceId: space.spaceId,
        batchId: request.body.batchId,
      });
      if (!head) {
        return reply.status(404).send({
          error: 'batch_not_found',
          message: `No eval batch '${request.body.batchId}' exists in this space.`,
        });
      }
      if (head.workflowSlug !== request.params.slug) {
        return reply.status(422).send({
          error: 'batch_wrong_skill',
          message:
            `Batch '${head.id}' measured skill '${head.workflowSlug}', not '${request.params.slug}' — ` +
            'a baseline is a batch of the skill it rules.',
        });
      }
      if (head.status !== 'completed') {
        return reply.status(409).send({
          error: 'batch_not_pinnable',
          message:
            `Batch '${head.id}' is '${head.status}' — only a COMPLETED batch can be the ruler. ` +
            'A running batch is still collecting verdicts; a failed or cancelled batch is a partial ' +
            'measurement and would make every later comparison read against a hole.',
          status: head.status,
        });
      }

      const row = await pinEvalBaseline(db, tenant.tenantId, {
        spaceId: space.spaceId,
        workflowSlug: request.params.slug,
        batchId: head.id,
        pinnedByUserId: operator.userId,
      });
      return reply.send({
        ok: true as const,
        baseline: {
          batchId: row.batchId,
          pinnedAt: row.pinnedAt.toISOString(),
          pinnedByUserId: row.pinnedByUserId,
        },
      });
    },
  );

  app.delete(
    '/:spaceId/workflows/:slug/eval-baseline',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Unpin the skill baseline (operator-only; idempotent)',
        params: WorkflowSlugParamsSchema,
        response: {
          200: z.object({ ok: z.literal(true), unpinned: z.boolean() }),
          403: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;
      const unpinned = await unpinEvalBaseline(getDb(fastify), tenant.tenantId, {
        spaceId: space.spaceId,
        workflowSlug: request.params.slug,
      });
      return reply.send({ ok: true as const, unpinned });
    },
  );
}
