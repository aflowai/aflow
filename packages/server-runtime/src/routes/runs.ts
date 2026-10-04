/**
 * Session management endpoints.
 * Handles starting, resuming, and managing agent sessions.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  SessionIdSchema,
  SessionStatusSchema,
  AgentIdSchema,
  StepExecutionIdSchema,
  SessionBlockedOnSchema,
  ClientMessageIdSchema,
  SimulationRunInputSchema,
  SessionMetadataSchema,
  isPersonTrigger,
  type SessionId,
  type StepExecutionId,
  type SessionAgentTarget,
} from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { buildInlineAgentDefinition, createSessionService } from '../services/sessions.js';
import { buildSessionSnapshot } from '../services/buildSessionSnapshot.js';
import { buildActorContext } from '../utils/actorContext.js';
import { isInteractiveUser, refusedStartMode, StartModeSchema } from '../utils/interactiveUser.js';
import { classifyRunServiceError } from '../lib/errors.js';
import { assertSessionSpaceAccess } from '../lib/sessionSpaceAccess.js';
import { registerMcpElicitationRoutes } from './mcp-elicitations.js';
import { registerSessionRoomMessageRoutes } from './sessionRoomMessages.js';
import { registerSessionParticipantRoutes } from './sessionParticipants.js';
import { registerSessionMetadataRoutes } from './sessionMetadataRoutes.js';
import { recordSpeechJoin, recordStartInvites } from '../lib/sessionMembership.js';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl.js';

// ============================================================================
// Request/Response Schemas
// ============================================================================

/**
 * Inline agent config: allows running an ad-hoc agent without pre-registering it.
 * The server passes it through the control plane without persisting it.
 */
const InlineAgentStepSchema = z.object({
  stepId: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  operation: z.string().min(1).max(128),
  config: z.record(z.unknown()).optional(),
  outputMapping: z.record(z.string()).optional(),
  name: z.string().max(255).optional(),
  description: z.string().max(2000).optional(),
  onSuccess: z
    .object({
      next: z.array(
        z.object({
          stepId: z.string(),
          priority: z.number().default(1),
          when: z.string().optional(),
        }),
      ),
    })
    .optional(),
  onFailure: z
    .object({
      next: z.array(
        z.object({
          stepId: z.string(),
          priority: z.number().default(1),
          when: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

const InlineAgentConfigSchema = z.object({
  /** Optional name for the inline agent (defaults to "inline-flow") */
  name: z.string().max(255).optional(),
  /** Start step ID (defaults to first step) */
  startStepId: z.string().optional(),
  /** Steps to execute (at least one required) */
  steps: z.array(InlineAgentStepSchema).min(1),
});

const StartSessionRequestSchema = z
  .object({
    target: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('platform-role'), systemRole: z.string().min(1).max(64) }),
        z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
      ])
      .optional(),
    /** Slug-pair alternative to `target`. Resolved via `resolveAgentRef`. */
    targetRef: z
      .object({
        spaceSlug: z.string().min(1).max(64).optional(),
        agentSlug: z.string().min(1).max(64),
      })
      .optional(),
    agentVersion: z.string().optional(),
    /** Space members to invite as the session is born — no separate round trip, no message-first. */
    invitees: z.array(z.string().uuid()).max(20).optional(),
    /** Inline agent definition — alternative to target/targetRef. Provide steps directly. */
    agentConfig: InlineAgentConfigSchema.optional(),
    /**
     * Session input. Standard format: { input: <value>, config?: { key: value } }
     * Also accepts bare values and legacy keyed objects for backward compat at the API layer.
     * The coercion pipeline normalizes everything before reaching the orchestrator.
     */
    input: z.unknown().optional(),
    inputRef: z.string().optional(),
    mode: StartModeSchema.optional(),
    context: z
      .object({
        spaceId: z.string().optional(),
        userId: z.string().optional(),
        traceId: z.string().optional(),
      })
      .optional(),
    budgets: z
      .object({
        maxCostUsd: z.number().positive().optional(),
        maxDurationMs: z.number().int().positive().optional(),
        maxSteps: z.number().int().positive().optional(),
      })
      .optional(),
    modelHints: z.array(z.string()).optional(),
    clientMessageId: ClientMessageIdSchema.optional(),
    /**
     * What this run pins its simulated worlds to. Caller-set, never
     * agent-set — a subject choosing its own seed, persona or generation model
     * is choosing the environment it is measured in.
     */
    simulationRunInput: SimulationRunInputSchema.optional(),
  })

  .refine((data) => data.target || data.targetRef || data.agentConfig, {
    message: 'One of target, targetRef, or agentConfig is required',
  });

const MissingVariableSchema = z.object({
  variableId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  typeSchema: z.record(z.unknown()).optional(),
  semanticType: z.string().optional(),
  required: z.boolean().optional(),
  responseOptions: z
    .object({
      type: z.enum(['single', 'multi']),
      options: z.array(z.object({ value: z.string(), label: z.string().optional() })),
    })
    .optional(),
});

const RequiredInputSchema = z.object({
  stepExecutionId: StepExecutionIdSchema,
  prompt: z.string().optional(),
  missingVariables: z.array(MissingVariableSchema).optional(),
});

const StartSessionResponseSchema = z.object({
  sessionId: SessionIdSchema,
  status: SessionStatusSchema,
  eventsUrl: z.string().url(),
  requiredInput: RequiredInputSchema.optional(),
  traceId: z.string(),
  next: z
    .object({
      kind: z.enum(['watch_events', 'provide_input']),
      eventsUrl: z.string().url().optional(),
      requiredInput: RequiredInputSchema.optional(),
    })
    .optional(),
});

const ResumeSessionRequestSchema = z.object({
  stepExecutionId: StepExecutionIdSchema,
  /** Resume input. For agent turns: { input: "user message" }. For structured pauses: keyed to missingVariables. */
  input: z.unknown().optional(),
  inputRef: z.string().optional(),
  /** Whether the user is interacting via voice (toggles voice-friendly LLM output) */
  voiceMode: z.boolean().optional(),
  clientMessageId: ClientMessageIdSchema.optional(),
});

const ResumeSessionResponseSchema = z.object({
  status: SessionStatusSchema,
  requiredInput: RequiredInputSchema.optional(),
  traceId: z.string(),
  next: z
    .object({
      kind: z.enum(['watch_events', 'provide_input']),
      eventsUrl: z.string().url().optional(),
      requiredInput: RequiredInputSchema.optional(),
    })
    .optional(),
});

const CancelSessionResponseSchema = z.object({
  status: SessionStatusSchema,
  message: z.string(),
});

const SessionDetailsSchema = z.object({
  sessionId: SessionIdSchema,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('platform-role'), systemRole: z.string() }),
    z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
    z.object({ kind: z.literal('inline-agent'), definitionRef: z.string() }),
  ]),
  agentVersion: z.string(),
  status: SessionStatusSchema,
  createdAt: z.string().datetime(),
  /** When the execution state last moved — tool results and all. */
  updatedAt: z.string().datetime(),
  /** When someone last spoke here. What a conversation list sorts on. */
  lastActivityAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  /** Who opened this session. Provenance — authorization never reads it. */
  createdBy: z.string().optional(),
  metadata: SessionMetadataSchema.optional(),
  inputRef: z.string().optional(),
  outputRef: z.string().optional(),
  error: z
    .object({
      title: z.string(),
      message: z.string(),
      category: z.enum([
        'network',
        'config',
        'permission',
        'rate_limit',
        'timeout',
        'budget',
        'validation',
        'system',
      ]),
      suggestedActions: z.array(z.string()).optional(),
      canRetry: z.boolean(),
      supportRef: z.string().optional(),
    })
    .optional(),
  errorRef: z.string().optional(),
  stepCount: z.number().int().nonnegative(),
  currentStepId: z.string().optional(),
  requiredInput: RequiredInputSchema.optional(),
  blockedOn: SessionBlockedOnSchema.nullable().optional(),
});

const ListSessionsQuerySchema = z.object({
  targetKind: z.enum(['platform-role', 'custom-agent']).optional(),
  /** Filter by custom-agent UUID. */
  targetAgentId: AgentIdSchema.optional(),
  /** Filter by platform-role systemRole. */
  targetSystemRole: z.string().min(1).max(64).optional(),
  status: SessionStatusSchema.optional(),
  spaceId: z.string().uuid().optional(),
  createdBy: z.string().uuid().optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().optional(),
  excludeTrigger: z.string().optional().default('eval'),
});

const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionDetailsSchema),
  nextCursor: z.string().optional(),
  totalCount: z.number().int().nonnegative().optional(),
});

const SessionSnapshotResponseSchema = z.object({
  snapshot: z.unknown(),
  tailCursor: z.string().nullable(),
  olderCursor: z.string().nullable(),
  hasOlder: z.boolean(),
  foldedEventCount: z.number().int().nonnegative(),
  catchupEventCount: z.number().int().nonnegative(),
  status: z.string().nullable(),
  catchupFailed: z.boolean(),
});

// ============================================================================
// Routes
// ============================================================================

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin; route handlers use await
export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const sessionService = createSessionService(app.appContext);

  // Require authentication for all routes
  app.addHook('preHandler', app.authenticate);

  registerMcpElicitationRoutes(fastify);
  registerSessionRoomMessageRoutes(fastify, sessionService);
  registerSessionParticipantRoutes(fastify);
  registerSessionMetadataRoutes(fastify);

  // -------------------------------------------------------------------------
  // POST /v1/sessions - Start a new session
  // -------------------------------------------------------------------------
  app.post(
    '/',
    {
      config: { authz: { resource: 'session', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Sessions'],
        summary: 'Start a new agent session',
        description: `Start a new agent session with optional input. Supports idempotency via Idempotency-Key header.

**Inline agent**: Instead of \`agentId\`, provide \`agentConfig\` with an inline agent definition. The server runs it ephemerally without persisting an agent definition row.

**Sync mode**: Add \`?wait=30s\` to wait for completion (max 60s). Returns immediately if the session completes, fails, or pauses within the timeout. Otherwise returns with status=RUNNING.`,
        headers: z.object({
          'idempotency-key': z.string().optional(),
        }),
        querystring: z.object({
          wait: z
            .string()
            .regex(/^\d+s$/)
            .optional()
            .describe("Wait for completion up to this duration (e.g., '30s'). Max 60s."),
          spaceId: z.string().uuid().optional(),
        }),
        body: StartSessionRequestSchema,
        response: {
          201: StartSessionResponseSchema.extend({
            // Extended response when wait is used
            outputRef: z.string().optional(),
            errorRef: z.string().optional(),
            error: z
              .object({
                code: z.string(),
                message: z.string(),
              })
              .optional(),
          }),
          400: z.object({ error: z.string(), message: z.string() }),
          403: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({
            error: z.string(),
            message: z.string(),
            existingSessionId: SessionIdSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const idempotencyKey = request.headers['idempotency-key'];
      const body = request.body;
      const waitParam = request.query.wait;
      const mode = body.mode ?? 'api';
      const modeRefusal = refusedStartMode(mode, isInteractiveUser(request.authUser));
      if (modeRefusal) return reply.status(400).send({ error: 'BadRequest', message: modeRefusal });

      try {
        const baseUrl = resolveApiBaseUrl();

        let resolvedTarget: SessionAgentTarget | undefined;
        let inlineDefinition: ReturnType<typeof buildInlineAgentDefinition> | undefined;

        if (body.agentConfig) {
          if (!space.canWrite) {
            reply.status(403).send({
              error: 'Forbidden',
              message: 'You need editor or admin role in this space to run inline agents.',
            });
            return;
          }
          inlineDefinition = buildInlineAgentDefinition(body.agentConfig);
          resolvedTarget = { kind: 'inline-agent', definitionRef: '' };
          request.log.info(
            { slug: inlineDefinition.flowId, version: inlineDefinition.version },
            'Prepared ephemeral inline agent definition',
          );
        } else if (body.target) {
          if (body.target.kind === 'platform-role') {
            const { getPlatformAgentBySystemRole } = await import('@aflow/platform-artifacts');
            const entry = getPlatformAgentBySystemRole(body.target.systemRole);
            if (!entry) {
              reply.status(400).send({
                error: 'BadRequest',
                message: `Unknown platform role: ${body.target.systemRole}`,
              });
              return;
            }
          } else {
            // custom-agent — the discriminated union has only the two
            // PersistentAgentTarget arms at this point. Capture the narrowed
            // agentId for use inside the async transaction closure (TS
            // narrowing on body.target is lost across the await boundary).
            const customAgentId = body.target.agentId;
            const { agents, createTenantContext, withTenantSchema } =
              await import('@aflow/database');
            const { eq, and } = await import('drizzle-orm');
            const tenantCtx = createTenantContext(tenant.tenantId);
            const rows: Array<{ id: string; archivedAt: Date | null }> = await withTenantSchema(
              request.server.appContext.db as PostgresJsDatabase,
              tenantCtx,
              async (tx) =>
                tx
                  .select({ id: agents.id, archivedAt: agents.archivedAt })
                  .from(agents)
                  .where(and(eq(agents.id, customAgentId), eq(agents.spaceId, space.spaceId)))
                  .limit(1),
            );
            if (rows.length === 0) {
              reply.status(404).send({
                error: 'NotFound',
                message: `Custom agent ${customAgentId} not found in this space`,
              });
              return;
            }
            if (rows[0]?.archivedAt) {
              reply.status(409).send({
                error: 'Conflict',
                message: `Custom agent ${customAgentId} is archived`,
                existingSessionId: '00000000-0000-0000-0000-000000000000' as SessionId,
              });
              return;
            }
          }
          resolvedTarget = body.target as SessionAgentTarget;
        } else if (body.targetRef) {
          const { resolveAgentRef } = await import('@aflow/database');
          try {
            const resolved = await resolveAgentRef(
              request.server.appContext.db as never,
              tenant.tenantId,
              {
                spaceId: space.spaceId,
                agentSlug: body.targetRef.agentSlug as never,
              },
            );
            resolvedTarget = resolved.target;
          } catch (err) {
            reply.status(404).send({
              error: 'NotFound',
              message: err instanceof Error ? err.message : 'Agent not found',
            });
            return;
          }
        } else {
          reply.status(400).send({
            error: 'BadRequest',
            message: 'One of target, targetRef, or agentConfig is required',
          });
          return;
        }

        if (!resolvedTarget) {
          // Unreachable — every branch above either assigns resolvedTarget or returns.
          reply.status(400).send({
            error: 'BadRequest',
            message: 'Internal: target resolution did not produce a value',
          });
          return;
        }

        const actorContext = buildActorContext(request, tenant, space);

        const result = await sessionService.startSession(
          {
            tenantId: tenant.tenantId,
            target: resolvedTarget,
            ...(body.agentVersion ? { agentVersion: body.agentVersion } : {}),
            ...(inlineDefinition ? { inlineDefinition } : {}),
            input: body.input,
            inputRef: body.inputRef,
            idempotencyKey,
            traceId: body.context?.traceId,
            spaceId: space.spaceId,
            createdBy:
              (request.headers['x-on-behalf-of'] as string | undefined) ?? request.authUser?.userId,
            trigger: mode,
            activatedByPerson: isPersonTrigger(mode),
            ...(mode === 'voice' ? { voiceMode: true } : {}),
            ...(actorContext ? { actorContext } : {}),
            ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
            ...(body.simulationRunInput ? { simulationRunInput: body.simulationRunInput } : {}),
          },
          baseUrl,
        );

        request.log.debug(
          { sessionId: result.sessionId, tenantId: tenant.tenantId },
          'Session started',
        );

        if (actorContext) {
          void recordSpeechJoin(fastify, tenant.tenantId, result.sessionId, actorContext.userId);
          if (body.invitees && body.invitees.length > 0) {
            void recordStartInvites(fastify, {
              tenantId: tenant.tenantId,
              spaceId: space.spaceId,
              sessionId: result.sessionId,
              invitedBy: actorContext.userId,
              invitees: body.invitees,
            });
          }
        }

        // If wait parameter is specified, poll for completion
        if (waitParam) {
          const waitSeconds = Math.min(parseInt(waitParam.replace('s', ''), 10), 60);
          const pollIntervalMs = 200; // Poll every 200ms
          const maxPolls = Math.ceil((waitSeconds * 1000) / pollIntervalMs);

          for (let i = 0; i < maxPolls; i++) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

            const details = await sessionService.getSessionById(tenant.tenantId, result.sessionId);
            if (!details) continue;

            // Resting/terminal states - return immediately
            if (
              details.status === 'SUCCEEDED' ||
              details.status === 'FAILED' ||
              details.status === 'CANCELLED' ||
              details.status === 'PAUSED' ||
              details.status === 'WAITING_ON_CHILD'
            ) {
              const next =
                details.status === 'PAUSED' && details.requiredInput
                  ? {
                      kind: 'provide_input' as const,
                      requiredInput: details.requiredInput,
                    }
                  : undefined;
              return await reply.status(201).send({
                ...result,
                status: details.status,
                outputRef: details.outputRef,
                errorRef: details.errorRef,
                requiredInput: details.requiredInput,
                next,
              });
            }
          }

          // Timeout - return current status (still RUNNING)
          request.log.info(
            { sessionId: result.sessionId, waitSeconds },
            'Session still in progress after wait timeout',
          );
        }

        reply.status(201).send({
          ...result,
          next: {
            kind: 'watch_events' as const,
            eventsUrl: result.eventsUrl,
          },
        });
      } catch (err) {
        request.log.error(
          { err, target: body.target, targetRef: body.targetRef },
          'Failed to start session',
        );
        throw classifyRunServiceError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/sessions - List sessions
  // -------------------------------------------------------------------------
  app.get(
    '/',
    {
      config: { authz: { resource: 'session', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Sessions'],
        summary: 'List sessions',
        description: 'List sessions with optional filters. Supports pagination via cursor.',
        querystring: ListSessionsQuerySchema,
        response: {
          200: ListSessionsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const query = request.query;

      // Build list params — only include excludeTrigger when it's a real trigger value
      const excludeTrigger =
        query.excludeTrigger && query.excludeTrigger !== 'none' ? query.excludeTrigger : undefined;

      const listParams: Parameters<typeof sessionService.listSessions>[0] = {
        tenantId: tenant.tenantId,
        spaceId: space.spaceId,
        limit: query.limit,
      };
      if (query.targetKind !== undefined) listParams.targetKind = query.targetKind;
      if (query.targetAgentId !== undefined) listParams.targetAgentId = query.targetAgentId;
      if (query.targetSystemRole !== undefined)
        listParams.targetSystemRole = query.targetSystemRole;
      if (query.status !== undefined) listParams.status = query.status;
      if (query.createdBy !== undefined) listParams.createdBy = query.createdBy;
      if (query.createdAfter !== undefined) listParams.createdAfter = query.createdAfter;
      if (query.createdBefore !== undefined) listParams.createdBefore = query.createdBefore;
      if (query.cursor !== undefined) listParams.cursor = query.cursor;
      if (excludeTrigger !== undefined) listParams.excludeTrigger = excludeTrigger;

      const result = await sessionService.listSessions(listParams);

      reply.send(result);
    },
  );

  // -------------------------------------------------------------------------
  app.get(
    '/:sessionId/debug',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Get session debug view',
        description: `Single JSON document with session details, recent events, agent decisions, and payload refs.
No large payloads embedded — use refs with GET /v1/payloads?ref= to hydrate.`,
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          eventsLimit: z.coerce.number().int().positive().max(500).optional(),
          walkStepHistory: z
            .enum(['true', 'false'])
            .optional()
            .describe(
              'Read back past the newest page until every dynamic step has a status, up to 10,000 events. Off by default: one page is read.',
            ),
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.any(), // SessionDebugView - complex schema
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { sessionId } = request.params;
      if (!(await assertSessionSpaceAccess(app, request, reply, { action: 'read', sessionId }))) {
        return;
      }
      const { eventsLimit, walkStepHistory } = request.query;

      const debug = await sessionService.getSessionDebug(tenant.tenantId, sessionId as SessionId, {
        ...(eventsLimit !== undefined && { eventsLimit }),
        ...(walkStepHistory === 'true' && { walkStepHistory: true }),
      });

      if (!debug) {
        reply.status(404).send({
          error: 'NotFound',
          message: `Session ${sessionId} not found`,
        });
        return;
      }

      reply.send(debug);
    },
  );

  // -------------------------------------------------------------------------
  app.get(
    '/:sessionId/state',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Get session hot state',
        description: `Sanitized Redis hot state for inspection. Returns session state, runtime variables (refs + summaries), dynamicStepsCount.
Useful for "what does the engine think right now?" debugging.`,
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.any(), // SessionStateView
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { sessionId } = request.params;
      if (!(await assertSessionSpaceAccess(app, request, reply, { action: 'read', sessionId }))) {
        return;
      }

      const state = await sessionService.getSessionStateView(
        tenant.tenantId,
        sessionId as SessionId,
      );

      if (!state) {
        reply.status(404).send({
          error: 'NotFound',
          message: `Session ${sessionId} not found or has no Redis hot state`,
        });
        return;
      }

      reply.send(state);
    },
  );

  // -------------------------------------------------------------------------
  app.get(
    '/:sessionId/snapshot',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Get session snapshot (Plan 146)',
        description: `Materialized RunViewState for the chat page's initial paint.
Folds the newest \`limit\` durable events (Redis tail, then Postgres) plus workflow-run catch-up.
\`hasOlder\` reports whether the conversation started before the page.
Reading further back: re-request with a larger \`limit\` — the fold is re-run from one end rather than stitched onto the previous page, so a message whose events straddle a page boundary cannot appear twice.
Live tail: subscribe to the realtime WebSocket \`session.events\` topic (mint token via \`POST /v1/realtime/token\`) with \`cursor=<tailCursor>\` and \`skipCatchup=true\` when \`catchupFailed\` is false.
Event-level pages: \`GET /sessions/:id/events?limit=<n>&before=<cursor>\`.`,
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
          limit: z.coerce.number().int().positive().optional(),
        }),
        response: {
          200: SessionSnapshotResponseSchema,
          404: z.object({ error: z.string(), message: z.string() }),
          503: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { sessionId } = request.params;
      if (!(await assertSessionSpaceAccess(app, request, reply, { action: 'read', sessionId }))) {
        return;
      }

      const payloadStore = app.appContext.payloadStore;
      if (!payloadStore) {
        reply.status(503).send({
          error: 'ServiceUnavailable',
          message: 'PayloadStore not configured; snapshot endpoint requires it.',
        });
        return;
      }

      const session = await sessionService.getSessionById(tenant.tenantId, sessionId as SessionId);
      if (!session) {
        reply.status(404).send({
          error: 'NotFound',
          message: `Session ${sessionId} not found.`,
        });
        return;
      }

      const result = await buildSessionSnapshot(
        {
          db: app.appContext.db as PostgresJsDatabase,
          redis: app.appContext.redis,
          payloadStore,
        },
        tenant.tenantId,
        sessionId as SessionId,
        space.spaceId,
        request.query.limit === undefined ? {} : { limit: request.query.limit },
      );

      reply.send(result);
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/sessions/:sessionId - Get session details
  // -------------------------------------------------------------------------
  app.get(
    '/:sessionId',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'read',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Get session details',
        description: 'Get detailed information about a specific session',
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: SessionDetailsSchema,
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { sessionId } = request.params;
      if (!(await assertSessionSpaceAccess(app, request, reply, { action: 'read', sessionId }))) {
        return;
      }

      const session = await sessionService.getSessionById(tenant.tenantId, sessionId as SessionId);

      if (!session) {
        reply.status(404).send({
          error: 'NotFound',
          message: `Session ${sessionId} not found`,
        });
        return;
      }

      reply.send(session);
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/sessions/:sessionId/chat-history - Get agent chat history
  // -------------------------------------------------------------------------
  app.get(
    '/:sessionId/chat-history',
    {
      config: { authz: { resource: 'session', action: 'read' } },
      schema: {
        tags: ['Sessions'],
        summary: 'Get agent chat history',
        description:
          'Returns the messages sent to the model and its response for the latest agent turn.',
        params: z.object({ sessionId: SessionIdSchema }),
        querystring: z.object({ stepId: z.string().optional() }),
        response: {
          200: z.object({
            messages: z.array(z.unknown()),
            modelOutput: z.string().optional(),
            decision: z.unknown().optional(),
            model: z.string().optional(),
            usage: z
              .object({
                promptTokens: z.number().optional(),
                completionTokens: z.number().optional(),
              })
              .optional(),
            turnNumber: z.number().optional(),
            contextWindow: z.number().optional(),
            // Passthrough (z.unknown) so a read of an older payload that predates
            // these fields tolerates their absence rather than failing serialization.
            tokenEstimate: z.unknown().optional(),
            toolSurface: z.unknown().optional(),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { sessionId } = request.params;
      const { stepId } = request.query;
      const redis = app.appContext.redis;
      const payloadStore = app.appContext.payloadStore;

      if (!redis || !payloadStore) {
        reply.status(404).send({ error: 'NotAvailable', message: 'Service not available' });
        return;
      }

      const { getSessionStateSafe } = await import('@aflow/redis');
      const result = await getSessionStateSafe(redis, tenant.tenantId, sessionId as SessionId);
      if (!result.ok) {
        reply.status(404).send({ error: 'NotFound', message: `Session ${sessionId} not found` });
        return;
      }

      if (
        !(await assertSessionSpaceAccess(app, request, reply, {
          action: 'read',
          sessionId,
          spaceId: result.state.spaceId ?? null,
        }))
      ) {
        return;
      }

      const vars = result.state.runtimeState?.variables ?? {};

      // Find the chatHistory variable — match specific stepId or first one found
      let chatHistoryRef: string | undefined;
      for (const [key, entry] of Object.entries(vars)) {
        if (!key.startsWith('ai.agent.chatHistory.')) continue;
        if (stepId && key !== `ai.agent.chatHistory.${stepId}`) continue;
        const ref = (entry as Record<string, unknown>)['ref'] as
          { kind?: string; payloadRef?: string } | undefined;
        if (ref?.kind === 'ref' && ref.payloadRef) {
          chatHistoryRef = ref.payloadRef;
        }
      }

      if (!chatHistoryRef) {
        reply.status(404).send({
          error: 'NotFound',
          message: 'No agent chat history available for this session',
        });
        return;
      }

      try {
        const data = (await payloadStore.retrieve(chatHistoryRef as never)) as Record<
          string,
          unknown
        >;
        // Payload shape is dynamic; ?? [] is defensive
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const messages = (data['modelMessages'] as unknown[]) ?? [];
        // Look up context window from model catalog
        let contextWindow: number | undefined;
        const modelId = data['model'] as string | undefined;
        if (modelId) {
          const { createDefaultModelCatalog } = await import('@aflow/ai-client');
          const modelDef = createDefaultModelCatalog().getModel(modelId);
          if (modelDef) contextWindow = modelDef.contextWindow;
        }

        reply.send({
          messages,
          modelOutput: data['modelOutput'] as string | undefined,
          decision: data['decision'],
          model: modelId,
          usage: data['usage'] as { promptTokens?: number; completionTokens?: number } | undefined,
          turnNumber: data['turnNumber'] as number | undefined,
          contextWindow,
          tokenEstimate: data['tokenEstimate'],
          toolSurface: data['toolSurface'],
        });
      } catch (err) {
        request.log.error({ err }, 'Failed to load chat history payload');
        reply.status(404).send({
          error: 'NotFound',
          message: 'Failed to load chat history payload',
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/sessions/:sessionId/resume - Resume a paused session
  // -------------------------------------------------------------------------
  app.post(
    '/:sessionId/resume',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'write',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Resume a paused session',
        description:
          'Resume a paused session by providing required input. Uses step_execution_id as pause-point guard.',
        headers: z.object({
          'idempotency-key': z.string().optional(),
        }),
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        body: ResumeSessionRequestSchema,
        response: {
          200: ResumeSessionResponseSchema,
          400: z.object({ error: z.string(), message: z.string() }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { sessionId } = request.params;
      const body = request.body;
      const idempotencyKey = request.headers['idempotency-key'];

      try {
        const actorContext = buildActorContext(request, tenant, space);

        const result = await sessionService.resumeSession({
          tenantId: tenant.tenantId,
          sessionId: sessionId as SessionId,
          stepExecutionId: body.stepExecutionId as StepExecutionId,
          input: body.input,
          inputRef: body.inputRef,
          idempotencyKey,
          ...(actorContext ? { actorContext } : {}),
          ...(body.voiceMode !== undefined ? { voiceMode: body.voiceMode } : {}),
          ...(body.clientMessageId ? { clientMessageId: body.clientMessageId } : {}),
          activatedByPerson: isInteractiveUser(request.authUser),
        });

        request.log.debug({ sessionId, stepExecutionId: body.stepExecutionId }, 'Session resumed');

        if (actorContext) {
          void recordSpeechJoin(fastify, tenant.tenantId, sessionId, actorContext.userId);
        }

        const eventsUrl = `${resolveApiBaseUrl()}/v1/sessions/${sessionId}/events`;
        const next = result.requiredInput
          ? { kind: 'provide_input' as const, requiredInput: result.requiredInput }
          : { kind: 'watch_events' as const, eventsUrl };

        reply.send({ ...result, next });
      } catch (err) {
        request.log.error({ err, sessionId }, 'Failed to resume session');
        throw classifyRunServiceError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/sessions/:sessionId/retry - Retry a failed session
  // -------------------------------------------------------------------------
  app.post(
    '/:sessionId/retry',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'write',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Retry a failed session',
        description:
          'Retry a failed session, optionally from a specific failed step and with corrective input.',
        headers: z.object({
          'idempotency-key': z.string().optional(),
        }),
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        body: z.object({
          input: z.unknown().optional(),
          inputRef: z.string().optional(),
          stepExecutionId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            status: z.string(),
            retryCount: z.number(),
            traceId: z.string(),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
          422: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { sessionId } = request.params;
      const body = request.body;
      const idempotencyKey = request.headers['idempotency-key'];

      try {
        const actorContext = buildActorContext(request, tenant, space);

        const result = await sessionService.retrySession({
          tenantId: tenant.tenantId,
          sessionId: sessionId as SessionId,
          input: body.input,
          inputRef: body.inputRef,
          ...(body.stepExecutionId
            ? { stepExecutionId: body.stepExecutionId as StepExecutionId }
            : {}),
          idempotencyKey,
          ...(actorContext ? { actorContext } : {}),
          activatedByPerson: isInteractiveUser(request.authUser),
        });

        request.log.info(
          { sessionId, stepExecutionId: body.stepExecutionId },
          'Session retry requested',
        );

        reply.send(result);
      } catch (err) {
        request.log.error({ err, sessionId }, 'Failed to retry session');
        throw classifyRunServiceError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/sessions/:sessionId/grant - Get session access grant
  // -------------------------------------------------------------------------
  app.get(
    '/:sessionId/grant',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'read',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Get session access grant',
        description:
          'Returns the authorization grant snapshot for a session, showing what capabilities were granted.',
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        response: {
          200: z.object({ grant: z.any().nullable() }),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { sessionId } = request.params;

      const redis = app.appContext.redis;
      if (!redis) {
        reply.status(404).send({ error: 'NotAvailable', message: 'Service not available' });
        return;
      }

      // A non-existent session must 404 like the session GET does — a 200
      // with `grant: null` made the events broker surface a confusing
      // `subscribe_denied` for sessions that were simply never created.
      const session = await sessionService.getSessionById(tenant.tenantId, sessionId as SessionId);
      if (!session) {
        reply.status(404).send({
          error: 'NotFound',
          message: `Session ${sessionId} not found`,
        });
        return;
      }

      if (!(await assertSessionSpaceAccess(app, request, reply, { action: 'read', sessionId }))) {
        return;
      }

      const { getRunAccessGrant } = await import('@aflow/redis');
      const grant = await getRunAccessGrant(redis, tenant.tenantId, sessionId as SessionId);
      reply.send({ grant: grant ?? null });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/sessions/:sessionId/cancel - Cancel a session
  // -------------------------------------------------------------------------
  app.post(
    '/:sessionId/cancel',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'write',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Cancel a session',
        description:
          'Request cancellation of a running or paused session. Cancellation may be async.',
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: CancelSessionResponseSchema,
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({
            error: z.string(),
            message: z.string(),
            currentStatus: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { sessionId } = request.params;

      try {
        const result = await sessionService.cancelSession({
          tenantId: tenant.tenantId,
          sessionId: sessionId as SessionId,
        });

        request.log.info({ sessionId }, 'Session cancellation requested');

        reply.send(result);
      } catch (err) {
        request.log.error({ err, sessionId }, 'Failed to cancel session');
        if (err instanceof Error && 'currentStatus' in err) {
          const currentStatus = (err as Error & { currentStatus: string }).currentStatus;
          void reply.status(409).send({
            error: 'Conflict',
            message: err.message,
            currentStatus,
          });
          return;
        }
        throw classifyRunServiceError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/sessions/:sessionId/interrupt - Interrupt a running agent (resumable)
  // -------------------------------------------------------------------------
  app.post(
    '/:sessionId/interrupt',
    {
      config: {
        authz: {
          resource: 'session',
          action: 'write',
          spaceIdFrom: 'requireSpace',
          resourceIdFrom: 'param',
        },
      },
      schema: {
        tags: ['Sessions'],
        summary: 'Interrupt a running agent',
        description:
          'Request interruption of a running agent session. The current step finishes, then the session ' +
          'pauses. Unlike cancel, the session is resumable with new input.',
        params: z.object({
          sessionId: SessionIdSchema,
        }),
        querystring: z.object({
          spaceId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({
            status: SessionStatusSchema,
            message: z.string(),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
          409: z.object({
            error: z.string(),
            message: z.string(),
            currentStatus: z.string().optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      await request.requireSpace();
      const { sessionId } = request.params;

      try {
        const result = await sessionService.interruptSession({
          tenantId: tenant.tenantId,
          sessionId: sessionId as SessionId,
        });

        request.log.info({ sessionId }, 'Session interruption requested');

        reply.send(result);
      } catch (err) {
        // Include currentStatus so the UI can reconcile stale state
        if (err instanceof Error && 'currentStatus' in err) {
          request.log.warn(
            { sessionId, currentStatus: (err as Error & { currentStatus: string }).currentStatus },
            'Interrupt rejected: status mismatch (UI will reconcile)',
          );
          const currentStatus = (err as Error & { currentStatus: string }).currentStatus;
          void reply.status(409).send({
            error: 'Conflict',
            message: err.message,
            currentStatus,
          });
          return;
        }
        request.log.error({ err, sessionId }, 'Failed to interrupt session');
        throw classifyRunServiceError(err);
      }
    },
  );
};
