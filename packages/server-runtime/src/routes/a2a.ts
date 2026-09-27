import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  type A2AJsonRpcRequest,
  type A2AJsonRpcResponse,
  type A2ASendMessageParams,
  type A2AGetTaskParams,
  type A2ACancelTaskParams,
  type A2AMessage,
  type SessionId,
  type SystemRole,
  type SessionAgentTarget,
  type TenantId,
  mapRunToTask,
  mapTaskStateFromRunStatus,
  projectRunEventToA2A,
} from '@aflow/schemas';
import { createSessionService, type SessionService } from '../services/sessions.js';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl.js';

async function a2aAgentIdToTarget(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  spaceId: string,
  agentId: string,
): Promise<SessionAgentTarget | null> {
  const { getPlatformAgentBySystemRole } = await import('@aflow/platform-artifacts');
  if (getPlatformAgentBySystemRole(agentId)) {
    return { kind: 'platform-role', systemRole: agentId as SystemRole };
  }
  try {
    const { resolveAgentPathParam } = await import('@aflow/database');
    const resolved = await resolveAgentPathParam(db, tenantId, spaceId, agentId);
    return resolved.target;
  } catch {
    return null;
  }
}

// ============================================================================
// A2A Error Codes (JSON-RPC)
// ============================================================================

const A2A_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  TASK_NOT_FOUND: { code: -32001, message: 'Task not found' },
  TASK_NOT_CANCELABLE: { code: -32002, message: 'Task not cancelable' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
} as const;

// ============================================================================
// Routes
// ============================================================================

export const a2aRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  const typedApp = app as unknown as ReturnType<typeof app.withTypeProvider<ZodTypeProvider>>;
  const sessionService = createSessionService(app.appContext);
  const db = app.appContext.db as PostgresJsDatabase;

  // POST /v1/a2a — JSON-RPC dispatcher
  typedApp.post(
    '/',
    {
      schema: {
        tags: ['A2A'],
        summary: 'A2A JSON-RPC endpoint',
        description:
          'Implements the A2A (Agent-to-Agent) protocol. Accepts JSON-RPC 2.0 requests with methods: tasks/send, tasks/get, tasks/cancel, tasks/sendSubscribe.',
        body: z.object({
          jsonrpc: z.literal('2.0'),
          id: z.union([z.string(), z.number()]),
          method: z.string(),
          params: z.record(z.unknown()).optional(),
        }),
        response: {
          200: z.record(z.unknown()),
        },
      },
      config: { public: true },
    },
    async (request, reply) => {
      const rpc = request.body as A2AJsonRpcRequest;
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      try {
        let result: unknown;

        switch (rpc.method) {
          case 'tasks/send':
            result = await handleSendMessage(
              db,
              sessionService,
              tenant.tenantId,
              space.spaceId,
              rpc.params as A2ASendMessageParams | undefined,
            );
            break;

          case 'tasks/get':
            result = await handleGetTask(
              sessionService,
              tenant.tenantId,
              rpc.params as A2AGetTaskParams | undefined,
            );
            break;

          case 'tasks/cancel':
            result = await handleCancelTask(
              sessionService,
              tenant.tenantId,
              rpc.params as A2ACancelTaskParams | undefined,
            );
            break;

          case 'tasks/sendSubscribe':
            // For streaming, switch to SSE response
            await handleSendStreamingMessage(
              db,
              sessionService,
              tenant.tenantId,
              space.spaceId,
              rpc.params as A2ASendMessageParams | undefined,
              rpc.id,
              request,
              reply,
            );
            return;

          default: {
            const resp: A2AJsonRpcResponse = {
              jsonrpc: '2.0',
              id: rpc.id,
              error: A2A_ERRORS.METHOD_NOT_FOUND,
            };
            reply.send(resp as unknown as Record<string, unknown>);
            return;
          }
        }

        const resp: A2AJsonRpcResponse = { jsonrpc: '2.0', id: rpc.id, result };
        reply.send(resp as unknown as Record<string, unknown>);
      } catch (err) {
        request.log.error({ err, method: rpc.method }, 'A2A handler error');
        const resp: A2AJsonRpcResponse = {
          jsonrpc: '2.0',
          id: rpc.id,
          error: {
            code: A2A_ERRORS.INTERNAL_ERROR.code,
            message: err instanceof Error ? err.message : 'Internal error',
          },
        };
        reply.send(resp as unknown as Record<string, unknown>);
      }
    },
  );
};

// ============================================================================
// Handler: tasks/send (SendMessage)
// ============================================================================

async function handleSendMessage(
  db: PostgresJsDatabase,
  sessionService: SessionService,
  tenantId: TenantId,
  spaceId: string,
  params: A2ASendMessageParams | undefined,
): Promise<unknown> {
  if (!params?.message) {
    throw Object.assign(new Error('Missing message parameter'), A2A_ERRORS.INVALID_PARAMS);
  }

  const { message, configuration } = params;
  const rawAgentId = configuration?.['agentId'];
  if (typeof rawAgentId !== 'string' || rawAgentId.length === 0) {
    throw Object.assign(
      new Error('Missing configuration.agentId — specify which agent to run'),
      A2A_ERRORS.INVALID_PARAMS,
    );
  }
  const agentId: string = rawAgentId;

  const target = await a2aAgentIdToTarget(db, tenantId, spaceId, agentId);
  if (!target) {
    throw Object.assign(
      new Error(
        `Unknown agent identifier "${agentId}" — not a UUID, platform role, or slug in this space`,
      ),
      A2A_ERRORS.INVALID_PARAMS,
    );
  }

  // Extract text from message parts
  const inputText = extractTextFromMessage(message);
  const baseUrl = resolveApiBaseUrl();

  // Start a run using the existing run service
  const run = await sessionService.startSession(
    {
      tenantId,
      target,
      input: { message: inputText },
      spaceId,
    },
    baseUrl,
  );

  // Return task in "submitted" state
  return {
    id: run.sessionId,
    status: {
      state: 'submitted' as const,
      timestamp: new Date().toISOString(),
    },
    metadata: { _phoenix: { sessionId: run.sessionId, agentId } },
  };
}

// ============================================================================
// Handler: tasks/get (GetTask)
// ============================================================================

async function handleGetTask(
  sessionService: SessionService,
  tenantId: TenantId,
  params: A2AGetTaskParams | undefined,
): Promise<unknown> {
  if (!params?.id) {
    throw Object.assign(new Error('Missing task id'), A2A_ERRORS.INVALID_PARAMS);
  }

  const runId = params.id as SessionId;
  const run = await sessionService.getSessionById(tenantId, runId);
  if (!run) {
    throw Object.assign(new Error(`Task ${params.id} not found`), A2A_ERRORS.TASK_NOT_FOUND);
  }

  // Get events to build message history. `afterEventId: undefined` cannot
  // produce a reconcile signal — the service only fails when it can't
  // resolve a caller-supplied cursor — so the `kind === 'events'` branch
  // always wins here.
  const eventsResult = await sessionService.getSessionEvents(tenantId, runId, undefined, 200);
  const events =
    eventsResult.kind === 'events'
      ? eventsResult.events.map((e) => ({
          eventType: e.eventType,
          ...(e.metadata ? { metadata: e.metadata } : {}),
        }))
      : [];

  return mapRunToTask(
    { runId: String(runId), status: run.status, createdAt: run.createdAt },
    events,
  );
}

// ============================================================================
// Handler: tasks/cancel (CancelTask)
// ============================================================================

async function handleCancelTask(
  sessionService: SessionService,
  tenantId: TenantId,
  params: A2ACancelTaskParams | undefined,
): Promise<unknown> {
  if (!params?.id) {
    throw Object.assign(new Error('Missing task id'), A2A_ERRORS.INVALID_PARAMS);
  }

  const runId = params.id as SessionId;
  const run = await sessionService.getSessionById(tenantId, runId);
  if (!run) {
    throw Object.assign(new Error(`Task ${params.id} not found`), A2A_ERRORS.TASK_NOT_FOUND);
  }

  const terminalStates = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
  if (terminalStates.includes(run.status)) {
    throw Object.assign(
      new Error(`Task ${params.id} is already in terminal state: ${run.status}`),
      A2A_ERRORS.TASK_NOT_CANCELABLE,
    );
  }

  await sessionService.cancelSession({ tenantId, sessionId: runId });

  return {
    id: String(runId),
    status: {
      state: 'canceled' as const,
      timestamp: new Date().toISOString(),
    },
  };
}

// ============================================================================
// Handler: tasks/sendSubscribe (SendStreamingMessage)
// ============================================================================

async function handleSendStreamingMessage(
  db: PostgresJsDatabase,
  sessionService: SessionService,
  tenantId: TenantId,
  spaceId: string,
  params: A2ASendMessageParams | undefined,
  rpcId: string | number,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!params?.message) {
    const resp: A2AJsonRpcResponse = {
      jsonrpc: '2.0',
      id: rpcId,
      error: A2A_ERRORS.INVALID_PARAMS,
    };
    reply.send(resp as unknown as Record<string, unknown>);
    return;
  }

  const { message, configuration } = params;
  const rawAgentId = configuration?.['agentId'];
  if (typeof rawAgentId !== 'string' || rawAgentId.length === 0) {
    const resp: A2AJsonRpcResponse = {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: A2A_ERRORS.INVALID_PARAMS.code,
        message: 'Missing configuration.agentId',
      },
    };
    reply.send(resp as unknown as Record<string, unknown>);
    return;
  }
  const agentId: string = rawAgentId;

  const target = await a2aAgentIdToTarget(db, tenantId, spaceId, agentId);
  if (!target) {
    const resp: A2AJsonRpcResponse = {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: A2A_ERRORS.INVALID_PARAMS.code,
        message: `Unknown agent identifier "${agentId}" — not a UUID, platform role, or slug in this space`,
      },
    };
    reply.send(resp as unknown as Record<string, unknown>);
    return;
  }

  const inputText = extractTextFromMessage(message);
  const baseUrl = resolveApiBaseUrl();

  // Start run
  const run = await sessionService.startSession(
    {
      tenantId,
      target,
      input: { message: inputText },
      spaceId,
    },
    baseUrl,
  );

  const taskId = String(run.sessionId);

  // Switch to SSE
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Emit initial task-status-update
  emitA2AEvent(reply.raw, {
    type: 'task-status-update',
    taskId,
    status: { state: 'working' },
    final: false,
  });

  // Poll for events and project to A2A
  let closed = false;
  let cursor: string | undefined;
  const runId = run.sessionId;

  const cleanup = () => {
    closed = true;
    clearInterval(pollInterval);
    reply.raw.end();
  };

  request.raw.on('close', cleanup);
  request.raw.on('error', cleanup);

  const pollInterval = setInterval(() => {
    void (async () => {
      if (closed) return;

      try {
        const result = await sessionService.getSessionEvents(tenantId, runId, cursor, 100);

        if (result.kind === 'reconcile_required') {
          request.log.warn(
            { runId, reason: result.reason },
            'A2A streaming reconcile_required — closing stream',
          );
          cleanup();
          return;
        }

        // Advance by the reader's position before projecting: A2A filters
        // events out of its protocol, and a cursor taken from what survived
        // the filter would stall on a page that emitted nothing.
        cursor = result.nextCursor;

        for (const event of result.events) {
          if (closed) break;

          const a2aEvent = projectRunEventToA2A(taskId, {
            eventType: event.eventType,
            ...(event.metadata ? { metadata: event.metadata } : {}),
          });

          if (a2aEvent) {
            emitA2AEvent(reply.raw, a2aEvent);

            // If final, close stream
            if (a2aEvent.type === 'task-status-update' && a2aEvent.final) {
              cleanup();
              return;
            }
          }
        }

        // Also check if run is terminal
        const currentRun = await sessionService.getSessionById(tenantId, runId);
        if (
          currentRun &&
          ['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALLED'].includes(currentRun.status)
        ) {
          // If we haven't emitted a final event yet, emit one
          emitA2AEvent(reply.raw, {
            type: 'task-status-update',
            taskId,
            status: { state: mapTaskStateFromRunStatus(currentRun.status) },
            final: true,
          });
          cleanup();
        }
      } catch (err) {
        request.log.error({ err, runId: taskId }, 'A2A streaming poll error');
      }
    })();
  }, 500);
}

// ============================================================================
// Helpers
// ============================================================================

function extractTextFromMessage(message: A2AMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function emitA2AEvent(stream: NodeJS.WritableStream, event: unknown): void {
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}
