import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import AjvModule from 'ajv';
import {
  getMcpElicitationRequest,
  deleteMcpElicitationRequest,
  publishMcpElicitationResponse,
  appendSessionEvent,
  type SessionEvent,
} from '@aflow/redis';
import { SessionIdSchema } from '@aflow/schemas';
import { getRedis } from './integrations/shared.js';

// AJV ESM-vs-CJS interop, same pattern as packages/cybernetic-runtime.
const AjvCtor = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as unknown as new (opts?: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => (data: unknown) => boolean;
  errors?: Array<{ instancePath: string; message?: string }>;
};
let _ajv: InstanceType<typeof AjvCtor> | undefined;
function ajv(): InstanceType<typeof AjvCtor> {
  if (!_ajv) _ajv = new AjvCtor({ allErrors: true, strict: false });
  return _ajv;
}

const ElicitationResponseBodySchema = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
  /** Required when `action === 'accept'` AND request mode is `form`. */
  content: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
});

const ElicitationResponseResultSchema = z.object({
  ok: z.boolean(),
  elicitationId: z.string(),
});

export function registerMcpElicitationRoutes(fastify: FastifyInstance): void {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/:sessionId/elicitations/:elicitationId/respond',
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
        summary: 'Respond to an MCP server-initiated elicitation request',
        description:
          'Forwards a user-submitted accept/decline/cancel for an in-flight ' +
          '`elicitation/create` from an MCP server. For form-mode accept, the ' +
          "`content` is validated against the request's `requestedSchema` " +
          'before publishing.',
        params: z.object({
          sessionId: SessionIdSchema,
          elicitationId: z.string().max(256),
        }),
        body: ElicitationResponseBodySchema,
        response: {
          200: ElicitationResponseResultSchema,
          400: z.object({
            error: z.string(),
            message: z.string(),
            details: z.array(z.unknown()).optional(),
          }),
          404: z.object({ error: z.string(), message: z.string() }),
          410: z.object({ error: z.string(), message: z.string() }),
          500: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { sessionId, elicitationId } = request.params;
      const body = request.body;

      const redis = getRedis(fastify);
      if (!redis) {
        reply.code(500).send({ error: 'ServerMisconfigured', message: 'Redis not configured' });
        return;
      }

      // 1. Load the captured request. A miss means either the lease
      //    expired (executor timed out, sent `elicitation/cancel` to the
      //    server, failed the step with `elicitation_timeout`) or no
      //    such elicitation ever existed.
      const stored = await getMcpElicitationRequest(redis, tenant.tenantId, elicitationId);
      if (!stored) {
        reply.code(410).send({
          error: 'Gone',
          message: `Elicitation "${elicitationId}" no longer accepting responses (expired or never registered).`,
        });
        return;
      }

      // 2. Cross-tenant guard. The stored request stamps the tenant; a
      //    response from a different tenant is rejected even if the
      //    elicitationId happens to be guessable.
      if (stored.tenantId !== tenant.tenantId) {
        reply
          .code(404)
          .send({ error: 'NotFound', message: 'Elicitation not found in this tenant' });
        return;
      }

      // 3. Cross-session guard. Within a tenant, the URL's :sessionId
      //    must match the session that owns the elicitation. Without
      //    this, a user with session:write on S1 could respond to an
      //    elicitation parked on S2 (provided they obtained the id,
      //    which appears in event streams + operator logs). It would
      //    also misroute the McpElicitationResolved event to the
      //    wrong stream — leaving S2's UI stuck on the form.
      //
      //    Workflow-task dispatch (no sessionId on the stored request)
      //    is not respondable via this route — that path will land in
      //    Phase 6 follow-ups with its own surface.
      if (!stored.sessionId || stored.sessionId !== sessionId) {
        reply.code(404).send({
          error: 'NotFound',
          message: 'Elicitation not found on this session',
        });
        return;
      }

      // 3. Form-mode validation. URL-mode has no server-supplied schema —
      //    accept/decline/cancel without content is fine.
      if (body.action === 'accept' && stored.request.mode === 'form') {
        if (!body.content) {
          reply.code(400).send({
            error: 'BadRequest',
            message: 'Form-mode accept requires `content` matching the requested schema.',
          });
          return;
        }
        const validate = ajv().compile(stored.request.requestedSchema);
        if (!validate(body.content)) {
          reply.code(400).send({
            error: 'BadRequest',
            message: 'Response content does not satisfy the requested schema.',
            details: (ajv().errors ?? []).map((e) => ({
              path: e.instancePath,
              message: e.message,
            })),
          });
          return;
        }
      }
      if (body.action === 'accept' && stored.request.mode === 'url' && body.content) {
        // URL-mode shouldn't carry content; treat as a client bug. Strip
        // rather than reject so the user's accept still works.
        body.content = undefined;
      }

      // 4. Publish the response on the per-elicitation channel. Fire-and-
      //    forget — the executor's suspended handler subscribes there.
      publishMcpElicitationResponse(redis, {
        elicitationId,
        action: body.action,
        ...(body.content ? { content: body.content } : {}),
        tenantId: tenant.tenantId,
      });

      // 5. Drop the captured request — the executor will release the
      //    lease once it wakes. Even without this, both keys would
      //    expire naturally; clearing eagerly tightens the window where
      //    a stale response could be re-submitted.
      await deleteMcpElicitationRequest(redis, tenant.tenantId, elicitationId);

      // 6. Emit `McpElicitationResolved` so any UI client (SSE) clears
      //    the inline form without waiting for the step to advance.
      //    Routed on the STORED sessionId — verified equal to the
      //    URL's :sessionId above — and includes stepExecutionId for
      //    UI correlation symmetry with the request event.
      const event: SessionEvent = {
        eventId: crypto.randomUUID(),
        eventType: 'McpElicitationResolved',
        timestamp: Date.now(),
        sessionId: stored.sessionId,
        stepExecutionId: stored.stepExecutionId,
        stepType: 'mcp',
        metadata: {
          elicitationId,
          action: body.action,
        },
      };
      try {
        await appendSessionEvent(redis, tenant.tenantId, stored.sessionId, event);
      } catch (err) {
        // Best-effort — the executor wake (step 4) is the authoritative
        // signal; failing to emit the resolved event just leaves the UI
        // mirror slightly stale until the step's normal completion event.
        request.log.warn(
          { err, elicitationId, sessionId },
          'Failed to emit McpElicitationResolved event',
        );
      }

      reply.send({ ok: true, elicitationId });
    },
  );
}
