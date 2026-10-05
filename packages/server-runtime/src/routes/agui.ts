import type { FastifyPluginAsync } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { canReadSpace } from './realtimeTopics/authz.js';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  type AgentId,
  type SystemRole,
  type SessionAgentTarget,
  projectRunEventToAgui,
} from '@aflow/schemas';

const UUID_SHAPE_AGUI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function aguiAgentIdToTarget(agentId: string): SessionAgentTarget {
  if (UUID_SHAPE_AGUI.test(agentId)) {
    return { kind: 'custom-agent', agentId: agentId as AgentId };
  }
  return { kind: 'platform-role', systemRole: agentId as SystemRole };
}
import { createSessionService } from '../services/sessions.js';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl.js';
import { isInteractiveUser } from '../utils/interactiveUser.js';
import type { PubSubSubscription } from '../services/pubsub.js';

// ============================================================================
// Routes
// ============================================================================

export const aguiRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  const typedApp = app as unknown as ReturnType<typeof app.withTypeProvider<ZodTypeProvider>>;
  const sessionService = createSessionService(app.appContext);

  typedApp.post(
    '/',
    {
      schema: {
        tags: ['AG-UI'],
        summary: 'Start an agent session and stream AG-UI events',
        description:
          'Starts a new agent session and returns a Server-Sent Events stream in AG-UI format. Each Phoenix session event is projected to one or more AG-UI events.',
        body: z.object({
          agentId: z.string().describe('Agent ID to run'),
          input: z.record(z.unknown()).optional().describe('Input data for the agent'),
          version: z.string().optional().describe('Specific agent version'),
        }),
        response: {
          200: z.record(z.unknown()).describe('AG-UI SSE event stream'),
          400: z.object({ error: z.string() }),
        },
      },
      config: { authz: { resource: 'session', action: 'write', spaceIdFrom: 'requireSpace' } },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { agentId, input, version } = request.body as {
        agentId: string;
        input?: Record<string, unknown>;
        version?: string;
      };

      const baseUrl = resolveApiBaseUrl();

      // Start the run
      const run = await sessionService.startSession(
        {
          tenantId: tenant.tenantId,
          target: aguiAgentIdToTarget(agentId),
          spaceId: space.spaceId,
          trigger: 'api',
          activatedByPerson: isInteractiveUser(request.authUser),
          ...(input ? { input } : {}),
          ...(version ? { agentVersion: version } : {}),
        },
        baseUrl,
      );

      const runId = run.sessionId;

      // Switch to SSE
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(': connected\n\n');

      let closed = false;
      let cursor: string | undefined;
      let subscription: PubSubSubscription | null = null;

      const keepAliveInterval = setInterval(() => {
        if (!closed) reply.raw.write(': keepalive\n\n');
      }, 15000);

      // SSE authorizes at request time only — re-check on an interval so a
      // revoked member's stream ends instead of outliving their membership.
      // canReadSpace is served by the in-process cache between revocations.
      const authUserId = request.authUser?.userId;
      const authMethod = request.authUser?.authMethod;
      const db = app.appContext.db as PostgresJsDatabase;
      const reauthInterval = setInterval(() => {
        if (closed || !authUserId) return;
        canReadSpace(db, tenant.tenantId, authUserId, space.spaceId, authMethod)
          .then((ok) => {
            if (!ok) return cleanup();
            return undefined;
          })
          .catch(() => {});
      }, 5000);

      const cleanup = async () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveInterval);
        clearInterval(reauthInterval);
        if (pollInterval) clearInterval(pollInterval);
        if (subscription) await subscription.unsubscribe();
        reply.raw.end();
      };

      request.raw.on('close', () => {
        void cleanup();
      });
      request.raw.on('error', () => {
        void cleanup();
      });

      // Emit and project events
      const emitAguiEvent = (event: Record<string, unknown>) => {
        const data = (event['data'] ?? {}) as Record<string, unknown>;
        const meta = event['metadata'] as Record<string, unknown> | undefined;
        const stepExecId = event['stepExecutionId'] as string | undefined;
        const aguiInput = {
          eventId: event['eventId'] as string,
          eventType: event['eventType'] as string,
          timestamp: typeof event['timestamp'] === 'string' ? Date.parse(event['timestamp']) : 0,
          runId: String(event['runId']),
          ...(data['stepId'] ? { stepId: data['stepId'] as string } : {}),
          ...(stepExecId ? { stepExecutionId: stepExecId } : {}),
          ...(meta ? { metadata: meta } : {}),
          ...(data['runtimeStatePatch']
            ? {
                runtimeStatePatch: data['runtimeStatePatch'] as {
                  version: number;
                  changed: Array<{ key: string; value: unknown }>;
                },
              }
            : {}),
        };
        const projected = projectRunEventToAgui(aguiInput);
        if (projected === null) return;
        const events = Array.isArray(projected) ? projected : [projected];
        for (const aguiEvent of events) {
          sendSSEEvent(reply.raw, crypto.randomUUID(), 'agui_event', aguiEvent);
        }
      };

      let fetchInFlight = false;
      const fetchAndSend = async () => {
        if (closed || fetchInFlight) return;
        fetchInFlight = true;
        try {
          const result = await sessionService.getSessionEvents(tenant.tenantId, runId, cursor, 100);
          if (result.kind === 'reconcile_required') {
            request.log.warn(
              { runId, reason: result.reason },
              'AG-UI reconcile_required — cursor lost',
            );
            sendSSEEvent(reply.raw, crypto.randomUUID(), 'stream_end', {
              reason: 'reconcile_required',
            });
            await cleanup();
            return;
          }
          for (const event of result.events) {
            if (closed) break;
            emitAguiEvent(event as unknown as Record<string, unknown>);
          }
          // Advance by the reader's position, not the last emitted event: this
          // loop projects into another protocol and may emit nothing at all
          // from a page, and a cursor derived from what it emitted would stop
          // moving exactly then.
          cursor = result.nextCursor;

          // Check terminal
          const currentRun = await sessionService.getSessionById(tenant.tenantId, runId);
          if (
            currentRun &&
            ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALLED'].includes(currentRun.status)
          ) {
            sendSSEEvent(reply.raw, crypto.randomUUID(), 'stream_end', {
              reason: 'run_completed',
              status: currentRun.status,
            });
            await cleanup();
          }
        } catch (err) {
          request.log.error({ err, runId }, 'AG-UI streaming poll error');
        } finally {
          fetchInFlight = false;
        }
      };

      // Pub/Sub wakeup if available
      const pubsubSubscriber = app.appContext.pubsubSubscriber;
      if (pubsubSubscriber) {
        try {
          subscription = await pubsubSubscriber.subscribeToRun(tenant.tenantId, runId, () => {
            fetchAndSend().catch((err: unknown) => {
              request.log.error({ err, runId }, 'AG-UI pub/sub handler error');
            });
          });
        } catch {
          // Fall through to polling
        }
      }

      // Poll interval (fast initially, slows if pub/sub is active)
      const pollInterval: ReturnType<typeof setInterval> | null = setInterval(
        () => {
          fetchAndSend().catch((err: unknown) => {
            request.log.error({ err, runId }, 'AG-UI poll error');
          });
        },
        subscription ? 2000 : 500,
      );

      // Kick off first fetch immediately
      fetchAndSend().catch((err: unknown) => {
        request.log.error({ err, runId }, 'AG-UI initial fetch error');
      });
    },
  );
};

// ============================================================================
// Helpers
// ============================================================================

function sendSSEEvent(
  stream: NodeJS.WritableStream,
  id: string,
  eventType: string,
  data: unknown,
): void {
  stream.write(`id: ${id}\n`);
  stream.write(`event: ${eventType}\n`);
  stream.write(`data: ${JSON.stringify(data)}\n\n`);
}
