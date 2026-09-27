/**
 * Space-scoped access check for session-content routes whose authz config
 * carries no spaceId (chat-history, grant, payloads). The route-level check
 * runs unscoped, so the tenant-admin fast path would bypass the
 * personal-space cap — after the handler resolves the session, this re-runs
 * the permission check with the session's spaceId through the central
 * `requirePermission` authority.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { createTenantContext, sessions, withTenantSchema, workflowRuns } from '@aflow/database';
import { getSessionStateSafe } from '@aflow/redis';
import type { SessionId, TenantId } from '@aflow/schemas';

/**
 * Tri-state so callers can tell "this session is not in your tenant" (deny)
 * apart from "this session predates space assignment" (tenant-level authz is
 * the whole check). Collapsing the two is how a foreign identifier reads as
 * permitted.
 */
export type SessionSpaceLookup = { found: false } | { found: true; spaceId: string | null };

export async function resolveSessionSpaceId(
  app: FastifyInstance,
  tenantId: TenantId,
  sessionId: string,
): Promise<SessionSpaceLookup> {
  const redis = app.appContext.redis;
  let foundInHotState = false;

  if (redis) {
    const result = await getSessionStateSafe(redis, tenantId, sessionId as SessionId);
    if (result.ok) {
      // `spaceId` is optional in hot state, so a record without one is not
      // evidence that the session has no space — only the durable row is.
      // Answering "no space" from here would skip the space-scoped check.
      if (result.state.spaceId) return { found: true, spaceId: result.state.spaceId };
      foundInHotState = true;
    }
  }

  const db = app.appContext.db as PostgresJsDatabase | null;
  if (!db) return foundInHotState ? { found: true, spaceId: null } : { found: false };

  const rows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ spaceId: sessions.spaceId })
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
      .limit(1),
  );
  const row = rows[0];
  if (row) return { found: true, spaceId: row.spaceId ?? null };
  // Postgres is eventually consistent behind Redis, so a session the hot state
  // knows about may not have flushed yet — that is existence, not absence.
  if (foundInHotState) return { found: true, spaceId: null };

  // A workflow run's steps live under the run's id, which is no session: the
  // output a task wrote and the feed a harness step kept are scoped by the
  // run's space the way a session's are by its own.
  const runRows = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
    tx
      .select({ spaceId: workflowRuns.spaceId })
      .from(workflowRuns)
      .where(eq(workflowRuns.runId, sessionId))
      .limit(1),
  );
  const run = runRows[0];
  if (!run) return { found: false };
  return { found: true, spaceId: run.spaceId };
}

export async function assertSessionSpaceAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  args: {
    action: 'read' | 'write' | 'delete';
    sessionId: string;
    /** Pass when the handler already resolved it — skips the lookup. */
    spaceId?: string | null;
  },
): Promise<boolean> {
  const tenant = await request.requireTenant();

  let spaceId: string | null;
  if (args.spaceId !== undefined) {
    spaceId = args.spaceId;
  } else {
    const lookup = await resolveSessionSpaceId(app, tenant.tenantId, args.sessionId);
    if (!lookup.found) {
      reply.status(404).send({ error: 'NotFound', message: 'Session not found' });
      return false;
    }
    spaceId = lookup.spaceId;
  }

  if (!spaceId) return true;
  await app.requirePermission({
    resource: 'session',
    action: args.action,
    getSpaceId: () => spaceId,
  })(request, reply);
  return !reply.sent;
}
