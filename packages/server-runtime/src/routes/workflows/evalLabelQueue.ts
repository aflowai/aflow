/**
 * Operator label-queue surface (Plan 269 D10). The queue item — not the
 * caller — decides every stream-determined field of the label it produces
 * (partition above all): submit stamps them from the item via
 * `buildLabelValuesFromQueueItem`, so no request can promote its own label
 * to 'validation'. The list omits the judge's verdict and rationale AND the
 * stream fields that imply them (`discloseLabelQueueStreamForList`) — a
 * suggested label anchors the labeler and poisons the measurement.
 *
 * A pending item is hydrated with the rubric and the judge's own evidence
 * because a judge scorecard measures agreement between the judge and the
 * human: labeling from different evidence than the judge saw confounds the
 * confusion matrix, so precision/recall/kappa would no longer describe the
 * judge. The question and the material are shown; the answer is not.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  buildLabelQueueSubjectViews,
  buildLabelValuesFromQueueItem,
  discloseLabelQueueStreamForList,
  getLabelQueueItemById,
  listLabelQueueItems,
  resolveLabelQueueItem,
  type LabelQueueSubjectView,
} from '@aflow/cybernetic-runtime';
import {
  EvalLabelPartitionSchema,
  EvalLabelQueueListItemSchema,
  EvalLabelQueueSourceSchema,
  EvalLabelQueueStatusSchema,
  EvalLabelVerdictSchema,
} from '@aflow/schemas';
import { spaceReadAuthz, spaceWriteAuthz, getDb, ErrorSchema } from './shared.js';
import { requireOperatorPrincipal } from '../../lib/operatorPrincipal.js';
import { insertEvalLabelRow } from '../../services/evalLabelWrite.js';

const DEFAULT_QUEUE_LIST_LIMIT = 50;

const QueueItemParamsSchema = z.object({
  spaceId: z.string().uuid(),
  itemId: z.string().uuid(),
});

export function registerEvalLabelQueueRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/eval-label-queue',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'List label-queue items (operator-only labeling surface)',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          status: EvalLabelQueueStatusSchema.default('pending'),
          batchId: z.string().uuid().optional(),
          workflowSlug: z.string().min(1).max(128).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(DEFAULT_QUEUE_LIST_LIMIT),
        }),
        response: {
          200: z.object({ items: z.array(EvalLabelQueueListItemSchema) }),
          403: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;

      const db = getDb(fastify);
      const entries = await listLabelQueueItems(db, tenant.tenantId, {
        spaceId: space.spaceId,
        status: request.query.status,
        batchId: request.query.batchId,
        workflowSlug: request.query.workflowSlug,
        limit: request.query.limit,
      });

      // Only a pending item is about to be labeled; a resolved listing is a
      // record, and rebuilding evidence for it would be pure IO.
      const payloadStore = fastify.appContext.payloadStore;
      const views: ReadonlyMap<string, LabelQueueSubjectView> =
        request.query.status === 'pending'
          ? await buildLabelQueueSubjectViews({
              db,
              tenantId: tenant.tenantId,
              spaceId: space.spaceId,
              subjects: entries.map((entry) => ({
                itemId: entry.item.id,
                caseRevisionId: entry.item.caseRevisionId,
                runId: entry.item.runId,
                conversation: entry.item.conversationJson,
                frozenEvidence: entry.item.evidenceJson,
                criterionId: entry.item.criterionId,
                scopeKey: entry.item.scopeKey,
                workflowSlug: entry.workflowSlug,
                judgeVersion: entry.item.judgeVersion,
              })),
              ...(payloadStore ? { retrievePayload: (ref) => payloadStore.retrieve(ref) } : {}),
            })
          : new Map();

      return reply.send({
        items: entries.flatMap((entry) => {
          const partition = EvalLabelPartitionSchema.safeParse(entry.item.partition);
          const source = EvalLabelQueueSourceSchema.safeParse(entry.item.source);
          const status = EvalLabelQueueStatusSchema.safeParse(entry.item.status);
          if (!partition.success || !source.success || !status.success) return [];
          const view = views.get(entry.item.id);
          const stream = discloseLabelQueueStreamForList(status.data, {
            partition: partition.data,
            source: source.data,
            inclusionProbability:
              entry.item.inclusionProbability !== null
                ? Number(entry.item.inclusionProbability)
                : null,
          });
          return [
            {
              id: entry.item.id,
              batchId: entry.item.batchId,
              workflowSlug: entry.workflowSlug,
              caseRevisionId: entry.item.caseRevisionId,
              caseTitle: entry.caseTitle,
              trial: entry.item.trial,
              runId: entry.item.runId,
              criterionId: entry.item.criterionId,
              scopeKey: entry.item.scopeKey,
              ...stream,
              status: status.data,
              createdAt: entry.item.createdAt.toISOString(),
              ...(view !== undefined ? { rubric: view.rubric, evidence: view.evidence } : {}),
            },
          ];
        }),
      });
    },
  );

  app.post(
    '/:spaceId/eval-label-queue/:itemId/label',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary:
          'Submit the human label for a queue item (operator-only; partition stamped from the item)',
        params: QueueItemParamsSchema,
        body: z.object({
          verdict: EvalLabelVerdictSchema,
          critique: z.string().min(1).max(8000),
        }),
        response: {
          201: z.object({ id: z.string().uuid(), labelId: z.string().uuid() }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;

      const db = getDb(fastify);
      const item = await getLabelQueueItemById(db, tenant.tenantId, {
        spaceId: space.spaceId,
        itemId: request.params.itemId,
      });
      if (!item) {
        return reply.status(404).send({
          error: 'queue_item_not_found',
          message: `No label-queue item '${request.params.itemId}' exists in this space.`,
        });
      }
      if (item.status !== 'pending') {
        return reply.status(409).send({
          error: 'queue_item_resolved',
          message: `This item is already '${item.status}'.`,
        });
      }
      if (item.runId === null) {
        return reply.status(409).send({
          error: 'queue_item_unlabelable',
          message: 'The item references no trial run — there is nothing to label; dismiss it.',
        });
      }

      const values = buildLabelValuesFromQueueItem(
        {
          spaceId: item.spaceId,
          batchId: item.batchId,
          caseRevisionId: item.caseRevisionId,
          trial: item.trial,
          runId: item.runId,
          criterionId: item.criterionId,
          scopeKey: item.scopeKey,
          partition: item.partition,
          judgeVersion: item.judgeVersion,
        },
        {
          verdict: request.body.verdict,
          critique: request.body.critique,
          labeledByUserId: operator.userId,
        },
      );
      const result = await insertEvalLabelRow(db, tenant.tenantId, values);
      if (!result.ok) {
        // The subject is already answered — by this operator disputing the
        // verdict where they read it, most likely. Leaving the item pending
        // hands the reviewer a row that can never be cleared, so it resolves
        // here even though this request did not write the label.
        await resolveLabelQueueItem(db, tenant.tenantId, {
          spaceId: space.spaceId,
          itemId: item.id,
          status: 'labeled',
        });
        return reply.status(409).send({
          error: 'label_exists',
          message: `A label already exists for criterion "${item.criterionId}" on this trial — the item is cleared from the queue.`,
        });
      }
      await resolveLabelQueueItem(db, tenant.tenantId, {
        spaceId: space.spaceId,
        itemId: item.id,
        status: 'labeled',
        labelId: result.id,
      });
      return reply.status(201).send({ id: item.id, labelId: result.id });
    },
  );

  app.post(
    '/:spaceId/eval-label-queue/:itemId/dismiss',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Dismiss a label-queue item without labeling (operator-only)',
        params: QueueItemParamsSchema,
        response: {
          200: z.object({ id: z.string().uuid(), status: z.literal('dismissed') }),
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const operator = requireOperatorPrincipal(request, reply);
      if (!operator) return;

      const db = getDb(fastify);
      const item = await getLabelQueueItemById(db, tenant.tenantId, {
        spaceId: space.spaceId,
        itemId: request.params.itemId,
      });
      if (!item) {
        return reply.status(404).send({
          error: 'queue_item_not_found',
          message: `No label-queue item '${request.params.itemId}' exists in this space.`,
        });
      }
      const resolved = await resolveLabelQueueItem(db, tenant.tenantId, {
        spaceId: space.spaceId,
        itemId: item.id,
        status: 'dismissed',
      });
      if (!resolved) {
        return reply.status(409).send({
          error: 'queue_item_resolved',
          message: `This item is already '${item.status}'.`,
        });
      }
      return reply.send({ id: item.id, status: 'dismissed' as const });
    },
  );
}
