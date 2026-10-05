import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  createTenantContext,
  createMemoryDocRepository,
  withTenantSchema,
  spaces,
} from '@aflow/database';
import type { StagedChange, EntityDirectives, Workflow, SkillManifest } from '@aflow/schemas';
import { PostInstallTaskSchema } from '@aflow/schemas';
import { isInteractiveUser } from '../../utils/interactiveUser.js';
import {
  buildProposalOpDiffs,
  resolveSkillForWorkflow,
  type ProposalOpDiff,
} from '@aflow/cybernetic-runtime';
import { loadWorkflowContentWithDiagnostic } from '../../services/workflowLoader.js';
import { EntityDirectivesSchema } from '@aflow/schemas';
import { appendEntityEvent } from '@aflow/redis';
import { deriveCoachProposalProjection } from '../../services/cybernetic/coachProposalProjection.js';
import {
  PROPOSAL_DIRS,
  triggerCoachReview,
  loadRunById,
  getRunStatistics,
  tryParseStagedChangeDoc,
} from '@aflow/cybernetic-runtime';
import {
  dismissProposal,
  ratifyProposal,
  rejectProposal,
  loadProposal,
  persistProposal,
} from '../../services/cybernetic/proposalResolution.js';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ResolutionRouteSchema = z.enum(['tenant_ratification', 'platform_issue']);

const RatificationApplyReasonResponseSchema = z.enum([
  'target_skill_missing',
  'workflow_not_found',
  'post_validation',
  'platform_artifact_read_only',
  'precondition_missing',
  'transient',
  'unknown',
]);

const LastRatificationErrorResponseSchema = z.object({
  reason: RatificationApplyReasonResponseSchema,
  op: z.string(),
  detail: z.string(),
  at: z.string(),
});

const ProposalSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  status: z.string(),
  summary: z.string(),
  rationale: z.string(),
  confidence: z.string(),
  targetWorkflowSlug: z.string().nullable(),
  opCount: z.number().int(),
  opKinds: z.array(z.string()),
  authorityLevel: z.enum(['auto_apply', 'stage_for_review', 'require_operator']),
  resolutionRoute: ResolutionRouteSchema,
  proposedAt: z.string(),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  hasReflectionEvidence: z.boolean(),
  lastRatificationError: LastRatificationErrorResponseSchema.optional(),
  rebaseState: z.enum(['clean', 'stale']).optional(),
  staleSummary: z
    .object({
      conflictCount: z.number().int().nonnegative(),
      firstOpKind: z.string().nullable(),
    })
    .optional(),
  validationsSummary: z
    .object({
      overallSafe: z.boolean(),
      warningCount: z.number().int().nonnegative(),
      blockerCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  applyPreviewStatus: z
    .object({
      result: z.literal('ok'),
      previewedAt: z.string().datetime(),
      workflowRevisionAtPreview: z.number().int().nullable(),
    })
    .optional(),
});

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const proposalRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  // -------------------------------------------------------------------------
  // GET /v1/spaces/:spaceId/proposals
  // -------------------------------------------------------------------------

  app.get(
    '/:spaceId/proposals',
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
        summary: 'List Coach proposals for a space',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          pendingOnly: z
            .enum(['true', 'false'])
            .default('true')
            .transform((v) => v === 'true'),
          workflowSlug: z.string().max(128).optional(),
          resolutionRoute: ResolutionRouteSchema.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({ proposals: z.array(ProposalSummarySchema) }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const { pendingOnly, workflowSlug, resolutionRoute, limit } = request.query;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const docRepo = createMemoryDocRepository(db, tenantCtx);

      const docArrays = await Promise.all(
        PROPOSAL_DIRS.map((dir) =>
          docRepo.list({
            pathPrefix: dir,
            scope: { spaceId },
            filters: { docType: ['json'] },
            limit,
          }),
        ),
      );
      const docs = docArrays.flat();

      const proposals: Array<z.infer<typeof ProposalSummarySchema>> = [];
      for (const d of docs) {
        if (!d.path.endsWith('.json')) continue;
        const full = await docRepo.getById(d.id, spaceId);
        if (!full?.inlineContent) continue;

        const parsed = tryParseStagedChangeDoc(full.inlineContent, {
          tenantId: tenant.tenantId,
          spaceId,
          docId: d.id,
          docPath: d.path,
          reader: 'GET /spaces/:spaceId/proposals',
        });
        if (!parsed.ok) continue;
        const sc: StagedChange = parsed.staged;

        if (pendingOnly && sc.status !== 'proposed') continue;
        if (workflowSlug && sc.targetWorkflowSlug !== workflowSlug) continue;
        if (resolutionRoute && sc.resolutionRoute !== resolutionRoute) continue;

        const projection = deriveCoachProposalProjection(sc);
        proposals.push({
          id: sc.id,
          kind: projection.proposalKind,
          status: sc.status,
          summary: projection.proposalSummary,
          rationale: projection.rationale,
          confidence: projection.confidence,
          targetWorkflowSlug: projection.targetWorkflowSlug,
          opCount: projection.opCount,
          opKinds: projection.opKinds,
          authorityLevel: projection.authorityLevel,
          resolutionRoute: sc.resolutionRoute,
          proposedAt: sc.proposedAt,
          expiresAt: sc.expiresAt,
          resolvedAt: sc.resolvedAt ?? null,
          resolvedBy: sc.resolvedBy ?? null,
          hasReflectionEvidence: projection.hasReflectionEvidence,
          ...(projection.lastRatificationError
            ? { lastRatificationError: projection.lastRatificationError }
            : {}),
          ...(projection.rebaseState ? { rebaseState: projection.rebaseState } : {}),
          ...(projection.staleSummary ? { staleSummary: projection.staleSummary } : {}),
          ...(projection.validationsSummary
            ? { validationsSummary: projection.validationsSummary }
            : {}),
          ...(projection.applyPreviewStatus
            ? { applyPreviewStatus: projection.applyPreviewStatus }
            : {}),
        });
      }

      // Most recent first across both dirs.
      proposals.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
      if (proposals.length > limit) proposals.length = limit;

      return { proposals };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/spaces/:spaceId/proposals/:proposalId
  // -------------------------------------------------------------------------

  app.get(
    '/:spaceId/proposals/:proposalId',
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
        summary: 'Get a single proposal with full details',
        params: z.object({
          spaceId: z.string().uuid(),
          proposalId: z.string().uuid(),
        }),
        response: {
          200: z.object({ proposal: z.record(z.unknown()) }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, proposalId } = request.params;
      const sc = await loadProposal(db, tenant.tenantId, spaceId, proposalId);
      if (!sc) {
        return reply.status(404).send({ error: 'Proposal not found' });
      }

      // Before→after diff against the CURRENT workflow
      // (what ratify would apply onto). Best-effort: a missing/unparseable
      // target just yields after-only entries, the card degrades gracefully.
      let opDiffs: ProposalOpDiff[] = [];
      try {
        const slug = sc.targetWorkflowSlug;
        let workflow: Workflow | null = null;
        let manifest: SkillManifest | null = null;
        if (slug) {
          const tenantCtx = createTenantContext(tenant.tenantId);
          const repo = createMemoryDocRepository(db, tenantCtx);
          const doc = await repo.getByPath(`/workflows/${slug}/workflow.json`, spaceId);
          if (doc) {
            const result = await loadWorkflowContentWithDiagnostic(
              repo,
              fastify.appContext.payloadStore,
              doc.id,
              spaceId,
            );
            workflow = result.workflow ?? null;
          } else {
            const { getPlatformWorkflow } = await import('@aflow/platform-artifacts');
            workflow = (getPlatformWorkflow(slug) as unknown as Workflow | null) ?? null;
          }
          // Manifest backs the before-values for goal/campaign-contract ops.
          // Its own try/catch so a manifest-resolution failure can't discard
          // the already-loaded workflow's before-values.
          try {
            const skill = await resolveSkillForWorkflow(
              { db, tenantId: tenant.tenantId, spaceId },
              slug,
            );
            manifest = skill?.manifest ?? null;
          } catch {
            manifest = null;
          }
        }
        opDiffs = buildProposalOpDiffs(workflow, sc.proposal.ops, manifest);
      } catch {
        opDiffs = buildProposalOpDiffs(null, sc.proposal.ops);
      }

      return { proposal: { ...(sc as unknown as Record<string, unknown>), opDiffs } };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/proposals/:proposalId/ratify
  // -------------------------------------------------------------------------

  app.post(
    '/:spaceId/proposals/:proposalId/ratify',
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
        summary: 'Ratify a Coach proposal',
        params: z.object({
          spaceId: z.string().uuid(),
          proposalId: z.string().uuid(),
        }),
        querystring: z
          .object({
            force: z
              .union([z.literal('true'), z.literal('false'), z.boolean()])
              .optional()
              .transform((v) => v === true || v === 'true'),
          })
          .default({}),
        response: {
          200: z.object({
            stagedChangeId: z.string().uuid(),
            status: z.literal('ratified'),
            setupChecklist: z.array(PostInstallTaskSchema).optional(),
          }),
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({
            error: z.literal('PROPOSAL_STALE'),
            detail: z.string(),
            conflicts: z.array(z.record(z.unknown())),
          }),
          422: z.object({ error: z.string(), detail: z.string().optional() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, proposalId } = request.params;
      const force = request.query.force;
      const operatorUserId = request.authUser?.userId ?? 'operator';
      const redis = fastify.appContext.redis;

      const result = await ratifyProposal(
        { db, redis, payloadStore: fastify.appContext.payloadStore ?? undefined },
        { tenantId: tenant.tenantId, spaceId, resolvedBy: operatorUserId },
        proposalId,
        { force },
      );

      if (result.ok) {
        return {
          stagedChangeId: proposalId,
          status: 'ratified' as const,
          ...(result.setupChecklist !== undefined ? { setupChecklist: result.setupChecklist } : {}),
        };
      }

      // Map failure codes to HTTP. `ProposalResolutionFailure` is the
      // union across all three resolve verbs; only the ratify-relevant
      // codes can fire here in practice. The else branch covers any
      // future code added to the service union without a route update.
      if (result.code === 'NOT_FOUND') {
        return reply.status(404).send({ error: 'Proposal not found' });
      }
      if (result.code === 'ALREADY_RESOLVED') {
        return reply.status(400).send({ error: `Proposal is already ${result.status}` });
      }
      if (result.code === 'PROPOSAL_NOT_RATIFIABLE') {
        return reply.status(422).send({ error: 'PROPOSAL_NOT_RATIFIABLE', detail: result.detail });
      }
      if (result.code === 'STALE') {
        return reply.status(409).send({
          error: 'PROPOSAL_STALE' as const,
          detail:
            `Proposal is stale against the current workflow — ` +
            `${String(result.stale.conflicts.length)} precondition(s) no longer hold. ` +
            `Regenerate the proposal or Apply anyway (force=true) with operator confirmation.`,
          conflicts: result.stale.conflicts as unknown as Array<Record<string, unknown>>,
        });
      }
      if (result.code === 'RATIFICATION_APPLY_FAILED') {
        return reply.status(422).send({
          error: `Ratification apply failed: ${result.error.op}`,
          detail: result.error.detail,
        });
      }
      if (result.code === 'APPLY_FAILED') {
        fastify.log.error({ proposalId, detail: result.detail }, 'Proposal apply threw');
        return reply.status(422).send({ error: 'APPLY_FAILED', detail: result.detail });
      }
      return reply.status(400).send({ error: 'UNKNOWN_FAILURE' });
    },
  );

  // -------------------------------------------------------------------------

  app.post(
    '/:spaceId/proposals/:proposalId/regenerate',
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
        summary: 'Regenerate a stale Coach proposal by re-running Coach against the source run',
        params: z.object({
          spaceId: z.string().uuid(),
          proposalId: z.string().uuid(),
        }),
        response: {
          200: z.object({
            stagedChangeId: z.string().uuid(),
            status: z.literal('rejected'),
            coachSessionId: z.string().uuid().nullable(),
            detail: z.string(),
          }),
          400: z.object({ error: z.string(), detail: z.string().optional() }),
          404: z.object({ error: z.string() }),
          422: z.object({ error: z.string(), detail: z.string().optional() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, proposalId } = request.params;
      const operatorUserId = request.authUser?.userId ?? 'operator';

      const sc = await loadProposal(db, tenant.tenantId, spaceId, proposalId);
      if (!sc) {
        return reply.status(404).send({ error: 'Proposal not found' });
      }
      if (sc.status !== 'proposed') {
        return reply.status(400).send({ error: `Proposal is already ${sc.status}` });
      }
      if (sc.resolutionRoute !== 'tenant_ratification') {
        return reply.status(422).send({
          error: 'PROPOSAL_NOT_REGENERABLE',
          detail: 'Only tenant_ratification proposals are regenerable.',
        });
      }
      const sourceRunId =
        sc.evidence.digestCitations?.[0]?.runId ?? sc.evidence.sourceSessionIds[0];
      if (!sourceRunId || !sc.targetWorkflowSlug) {
        return reply.status(422).send({
          error: 'PROPOSAL_NO_SOURCE_RUN',
          detail:
            'Proposal carries no source run id (or no target workflow slug) to retrigger Coach against.',
        });
      }

      // Verify the source run still exists + is terminal — re-using the same
      // shape as `learner.review.retrigger`.
      const run = await loadRunById(db, tenant.tenantId, spaceId, sourceRunId);
      if (!run) {
        return reply.status(422).send({
          error: 'SOURCE_RUN_NOT_FOUND',
          detail: `Original source run ${sourceRunId} is no longer in this space.`,
        });
      }
      if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
        return reply.status(422).send({
          error: 'SOURCE_RUN_NOT_TERMINAL',
          detail: `Source run ${sourceRunId} is "${run.status}" — Coach review only works on terminal runs.`,
        });
      }

      // Resolve directives (best-effort) and stats.
      let parsedDirectives: EntityDirectives | undefined;
      try {
        const tenantCtx = createTenantContext(tenant.tenantId);
        const spaceRows = await withTenantSchema(db, tenantCtx, async (tx) =>
          tx
            .select({ directives: spaces.directives })
            .from(spaces)
            .where(eq(spaces.id, spaceId))
            .limit(1),
        );
        if (spaceRows[0]?.directives) {
          parsedDirectives = EntityDirectivesSchema.parse(spaceRows[0].directives);
        }
      } catch {
        // Fall through with undefined; Coach uses defaults.
      }
      const stats = await getRunStatistics(db, tenant.tenantId, spaceId, sc.targetWorkflowSlug, {
        windowDays: 36500,
      });

      const redisInstance = fastify.appContext.redis;
      if (!redisInstance) {
        return reply.status(422).send({
          error: 'REDIS_UNAVAILABLE',
          detail: 'Redis is not configured; Coach review cannot be dispatched.',
        });
      }

      const coachSessionId = await triggerCoachReview({
        tenantId: tenant.tenantId,
        spaceId,
        workflowSlug: sc.targetWorkflowSlug,
        runId: sourceRunId,
        totalRuns: stats.totalRuns,
        ...(parsedDirectives ? { directives: parsedDirectives } : {}),
        activatedByPerson: isInteractiveUser(request.authUser),
        db,
        redis: redisInstance,
        ...(fastify.appContext.payloadStore
          ? { payloadStore: fastify.appContext.payloadStore }
          : {}),
        force: true,
      });

      // Mark the old proposal as rejected with `regenerated_as:<sessionId>` provenance.
      const now = new Date().toISOString();
      const rejected: StagedChange = {
        ...sc,
        status: 'rejected',
        resolvedAt: now,
        resolvedBy: operatorUserId,
      };
      await persistProposal(db, tenant.tenantId, spaceId, proposalId, rejected);

      try {
        await appendEntityEvent(redisInstance, {
          tenantId: tenant.tenantId,
          spaceId,
          event: {
            eventId: randomUUID(),
            eventType: 'entity.coach.rejected',
            spaceId,
            tenantId: tenant.tenantId,
            timestamp: Date.now(),
            operatingMode: 'supervisory',
            payload: {
              stagedChangeId: proposalId,
              kind: sc.kind,
              resolvedBy: operatorUserId,
              reason: coachSessionId
                ? `regenerated_as:${coachSessionId}`
                : 'regenerated_no_session',
            },
            summary: coachSessionId
              ? `Proposal regenerated — new Coach session ${coachSessionId}`
              : `Proposal regenerated — Coach trigger skipped (no agent / rate-capped)`,
          },
        });
      } catch {
        // Best-effort
      }

      return {
        stagedChangeId: proposalId,
        status: 'rejected' as const,
        coachSessionId: coachSessionId ?? null,
        detail: coachSessionId
          ? `Old proposal rejected. Coach session ${coachSessionId} dispatched to author a fresh proposal against the current workflow.`
          : 'Old proposal rejected. Coach trigger returned null (no Coach agent registered, or rate-capped). Operator may retry.',
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/proposals/:proposalId/reject
  // -------------------------------------------------------------------------

  app.post(
    '/:spaceId/proposals/:proposalId/reject',
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
        summary: 'Reject a Coach proposal',
        params: z.object({
          spaceId: z.string().uuid(),
          proposalId: z.string().uuid(),
        }),
        body: z
          .object({
            reason: z.string().max(500).optional(),
          })
          .default({}),
        response: {
          200: z.object({ stagedChangeId: z.string().uuid(), status: z.literal('rejected') }),
          400: z.object({ error: z.string(), detail: z.string().optional() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, proposalId } = request.params;
      const operatorUserId = request.authUser?.userId ?? 'operator';
      const redis = fastify.appContext.redis;

      const result = await rejectProposal(
        { db, redis },
        { tenantId: tenant.tenantId, spaceId, resolvedBy: operatorUserId },
        proposalId,
        {
          ...(request.body.reason !== undefined ? { reason: request.body.reason } : {}),
        },
      );

      if (result.ok) {
        return { stagedChangeId: proposalId, status: 'rejected' as const };
      }
      if (result.code === 'NOT_FOUND') {
        return reply.status(404).send({ error: 'Proposal not found' });
      }
      if (result.code === 'ALREADY_RESOLVED') {
        return reply.status(400).send({ error: `Proposal is already ${result.status}` });
      }
      if (result.code === 'USE_DISMISS_FOR_PLATFORM_ISSUE') {
        return reply
          .status(400)
          .send({ error: 'USE_DISMISS_FOR_PLATFORM_ISSUE', detail: result.detail });
      }
      return reply.status(400).send({ error: 'UNKNOWN_FAILURE' });
    },
  );

  // -------------------------------------------------------------------------
  app.post(
    '/:spaceId/proposals/:proposalId/dismiss',
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
        summary: 'Dismiss a platform-issue Coach diagnostic',
        params: z.object({
          spaceId: z.string().uuid(),
          proposalId: z.string().uuid(),
        }),
        body: z
          .object({
            dismissReason: z.string().max(500).optional(),
          })
          .default({}),
        response: {
          200: z.object({ stagedChangeId: z.string().uuid(), status: z.literal('dismissed') }),
          400: z.object({ error: z.string(), detail: z.string().optional() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, proposalId } = request.params;
      const operatorUserId = request.authUser?.userId ?? 'operator';
      const redis = fastify.appContext.redis;

      const result = await dismissProposal(
        { db, redis },
        { tenantId: tenant.tenantId, spaceId, resolvedBy: operatorUserId },
        proposalId,
        {
          ...(request.body.dismissReason !== undefined
            ? { dismissReason: request.body.dismissReason }
            : {}),
        },
      );

      if (result.ok) {
        return { stagedChangeId: proposalId, status: 'dismissed' as const };
      }
      if (result.code === 'NOT_FOUND') {
        return reply.status(404).send({ error: 'Proposal not found' });
      }
      if (result.code === 'ALREADY_RESOLVED') {
        return reply.status(400).send({ error: `Proposal is already ${result.status}` });
      }
      if (result.code === 'PROPOSAL_NOT_DISMISSIBLE') {
        return reply.status(400).send({ error: 'PROPOSAL_NOT_DISMISSIBLE', detail: result.detail });
      }
      return reply.status(400).send({ error: 'UNKNOWN_FAILURE' });
    },
  );
};
