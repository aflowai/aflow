/**
 * Campaigns surface for the Skill Designer. Wraps the same engine functions
 * the orchestrator inline-ops use (read: `listCampaigns` / view helpers;
 * write: `startCampaign` / `updateCampaign` / `endCampaignInSpace`) so the
 * operator and agent paths stay one authority.
 */
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  WorkflowCampaignListOutputSchema,
  WorkflowCampaignGetOutputSchema,
  WorkflowCampaignStartOutputSchema,
  WorkflowCampaignUpdateOutputSchema,
  WorkflowCampaignEndOutputSchema,
  CampaignConfigRecordSchema,
  CampaignEndedReasonSchema,
} from '@aflow/schemas';
import {
  listCampaigns,
  getCampaignInSpace,
  getCampaignScoreSeries,
  buildCampaignView,
  summarizeScoreSeries,
  recentSeriesTail,
  startCampaign,
  updateCampaign,
  endCampaignInSpace,
  maybeTriggerCampaignEndReview,
  type CampaignOpError,
} from '@aflow/cybernetic-runtime';
import {
  WorkflowSlugParamsSchema,
  spaceReadAuthz,
  spaceWriteAuthz,
  getDb,
  ErrorSchema,
} from './shared.js';

/** A failed campaign operation, with the structured `details` carried through. */
const CampaignOpErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

const STATUS_BY_CODE: Record<string, number> = {
  SKILL_NOT_FOUND: 404,
  CAMPAIGN_NOT_FOUND: 404,
  CAMPAIGN_CONFIG_CONFLICT: 409,
  CAMPAIGN_ENDED: 409,
};

/** Map an engine `CampaignOpError` onto an HTTP status + body. */
function sendCampaignError(reply: FastifyReply, err: CampaignOpError): FastifyReply {
  const status = STATUS_BY_CODE[err.code] ?? 400;
  return reply.status(status).send({
    error: err.code,
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}

const WriteErrorResponses = {
  400: CampaignOpErrorSchema,
  404: CampaignOpErrorSchema,
  409: CampaignOpErrorSchema,
};

export function registerWorkflowCampaignRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/:spaceId/workflows/:slug/campaigns',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: "Campaign instances (+ score summary) for a skill's workflow",
        params: WorkflowSlugParamsSchema,
        querystring: z.object({
          status: z.enum(['active', 'ended', 'all']).default('active'),
        }),
        response: { 200: WorkflowCampaignListOutputSchema },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const { status } = request.query;
      const db = getDb(fastify);
      const rows = await listCampaigns(db, tenant.tenantId, {
        spaceId,
        workflowSlug: slug,
        ...(status === 'all' ? {} : { status }),
      });
      const campaigns = await Promise.all(
        rows.map((c) => buildCampaignView(db, tenant.tenantId, c)),
      );
      return { campaigns };
    },
  );

  app.get(
    '/:spaceId/workflows/:slug/campaigns/:campaignId',
    {
      config: { authz: spaceReadAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'One campaign with its score summary and recent run series',
        params: WorkflowSlugParamsSchema.extend({ campaignId: z.string().uuid() }),
        response: { 200: WorkflowCampaignGetOutputSchema, 404: ErrorSchema },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug, campaignId } = request.params;
      const db = getDb(fastify);
      const campaign = await getCampaignInSpace(db, tenant.tenantId, spaceId, campaignId);
      // The URL is workflow-scoped, so a missing campaign — or one belonging to
      // another workflow, even in this space — is not addressable here.
      if (campaign?.workflowSlug !== slug) {
        return reply
          .status(404)
          .send({ error: 'NotFound', message: `Campaign ${campaignId} not found` });
      }
      const series = await getCampaignScoreSeries(db, tenant.tenantId, campaign.campaignId);
      return {
        campaign,
        scoreSummary: summarizeScoreSeries(campaign, series),
        recentSeries: recentSeriesTail(series),
      };
    },
  );

  app.post(
    '/:spaceId/workflows/:slug/campaigns',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Start (or idempotently return) a campaign for a skill',
        params: WorkflowSlugParamsSchema,
        body: z.object({ config: CampaignConfigRecordSchema.optional() }),
        response: { 200: WorkflowCampaignStartOutputSchema, ...WriteErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug } = request.params;
      const db = getDb(fastify);
      const result = await startCampaign(db, tenant.tenantId, {
        spaceId,
        slug,
        ...(request.body.config ? { config: request.body.config } : {}),
      });
      if (!result.ok) return sendCampaignError(reply, result);
      return reply.send({ campaign: result.campaign, created: result.created });
    },
  );

  app.patch(
    '/:spaceId/workflows/:slug/campaigns/:campaignId',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'Update mutable config fields on an active campaign',
        params: WorkflowSlugParamsSchema.extend({ campaignId: z.string().uuid() }),
        body: z.object({ config: CampaignConfigRecordSchema }),
        response: { 200: WorkflowCampaignUpdateOutputSchema, ...WriteErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug, campaignId } = request.params;
      const db = getDb(fastify);
      // Enforce the workflow-scoped URL before mutating — a campaign from
      // another workflow is not addressable here even within the space.
      const existing = await getCampaignInSpace(db, tenant.tenantId, spaceId, campaignId);
      if (existing?.workflowSlug !== slug) {
        return reply
          .status(404)
          .send({ error: 'CAMPAIGN_NOT_FOUND', message: `Campaign ${campaignId} not found` });
      }
      const result = await updateCampaign(db, tenant.tenantId, {
        spaceId,
        campaignId,
        config: request.body.config,
      });
      if (!result.ok) return sendCampaignError(reply, result);
      return reply.send({ campaign: result.campaign, changedKeys: result.changedKeys });
    },
  );

  app.post(
    '/:spaceId/workflows/:slug/campaigns/:campaignId/end',
    {
      config: { authz: spaceWriteAuthz },
      schema: {
        tags: ['Spaces'],
        summary: 'End a campaign (idempotent)',
        params: WorkflowSlugParamsSchema.extend({ campaignId: z.string().uuid() }),
        body: z.object({ reason: CampaignEndedReasonSchema.default('explicit') }),
        response: { 200: WorkflowCampaignEndOutputSchema, ...WriteErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, slug, campaignId } = request.params;
      const db = getDb(fastify);
      const existing = await getCampaignInSpace(db, tenant.tenantId, spaceId, campaignId);
      if (existing?.workflowSlug !== slug) {
        return reply
          .status(404)
          .send({ error: 'CAMPAIGN_NOT_FOUND', message: `Campaign ${campaignId} not found` });
      }
      const result = await endCampaignInSpace(db, tenant.tenantId, {
        spaceId,
        campaignId,
        reason: request.body.reason,
      });
      if (!result.ok) return sendCampaignError(reply, result);
      const redis = fastify.appContext.redis;
      if (result.endedNow && redis) {
        // The campaign is already ended — a failed dispatch must not fail
        // the request.
        await maybeTriggerCampaignEndReview({
          db,
          redis,
          ...(fastify.appContext.payloadStore
            ? { payloadStore: fastify.appContext.payloadStore }
            : {}),
          tenantId: tenant.tenantId,
          spaceId,
          workflowSlug: slug,
          campaignId,
          reason: request.body.reason,
        }).catch(() => {});
      }
      return reply.send({ campaign: result.campaign });
    },
  );
}
