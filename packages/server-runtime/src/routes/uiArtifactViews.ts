/**
 * The compiled view of one artifact version.
 *
 * Addressed by **version**, not by instance: an upgrade repins an instance to
 * another version, so an instance URL names different bytes over time. A
 * version's html is *nearly* immutable — but the executor's publish path can
 * rewrite `html_ref` in place, and a compiler change alters output for a
 * version compiled after it — so the response revalidates with a strong
 * validator instead of claiming `immutable` over a rewritable pointer.
 *
 * The html is returned **inside JSON**, never as `text/html`. These bytes are
 * generated — by a compiler, and increasingly by an agent — and the only place
 * they are allowed to execute is the sandboxed frame the client mounts them in.
 * Served as a document on this origin, a direct navigation would run them here
 * instead, with the caller's session.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ArtifactVersionViewSchema, ArtifactVersionViewErrorSchema } from '@aflow/schemas';
import { canReadSpace } from './realtimeTopics/authz.js';
import {
  resolveArtifactVersionSpaceId,
  resolveAppletViewHtmlRef,
  type AppletViewUnavailable,
} from '../lib/appletInstanceLookup.js';

const ParamsSchema = z.object({ versionId: z.string().uuid() });

/**
 * The digest is the whole validator — never the storage ref, which for
 * executor-written rows is a path naming the bucket, tenant, run and step,
 * none of which belongs in a response header.
 */
const CACHE_CONTROL = 'private, no-cache';

/**
 * RFC 9110 §13.1.2: `If-None-Match` uses weak comparison, may carry a list,
 * and `*` matches any current representation. A bare `===` against one strong
 * tag misses all three — and misses every client behind a proxy that weakens
 * ETags on compression, which the production edge does.
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.trim() === '*') return true;
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    const strong = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
    return strong === etag;
  });
}

/**
 * A refusal — a view that will not compile, reaches an unpinned host, or has
 * unreadable source — is recomputed on every read, because only success is
 * persisted. Left unmemoized, the cheapest read-only caller can loop a broken
 * versionId and buy an esbuild run per request on the process serving every
 * tenant. Deterministic given the source, so a short memo loses nothing.
 */
const REFUSAL_TTL_MS = 30_000;
const REFUSAL_MEMO_MAX = 500;
const refusalMemo = new Map<string, { until: number; unavailable: AppletViewUnavailable }>();

function memoizedRefusal(versionId: string): AppletViewUnavailable | null {
  const held = refusalMemo.get(versionId);
  if (held === undefined) return null;
  if (held.until < Date.now()) {
    refusalMemo.delete(versionId);
    return null;
  }
  return held.unavailable;
}

function memoizeRefusal(versionId: string, unavailable: AppletViewUnavailable): void {
  if (refusalMemo.size >= REFUSAL_MEMO_MAX) {
    const oldest = refusalMemo.keys().next().value;
    if (oldest !== undefined) refusalMemo.delete(oldest);
  }
  refusalMemo.set(versionId, { until: Date.now() + REFUSAL_TTL_MS, unavailable });
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify's plugin signature is async
export const uiArtifactViewRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/versions/:versionId/view',
    {
      // The space is not in the request — it is resolved from the version, so
      // the handler owns the check and declares `none` here rather than
      // pointing the framework at a space the caller supplied.
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'none' } },
      schema: {
        tags: ['UI Artifacts'],
        summary: "Fetch one artifact version's compiled view",
        response: {
          200: ArtifactVersionViewSchema,
          304: z.null(),
          404: ArtifactVersionViewErrorSchema,
          503: ArtifactVersionViewErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const params = ParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: 'NotFound', message: 'Artifact version not found' });
      }
      const { versionId } = params.data;

      const db = fastify.appContext.db as PostgresJsDatabase | null;
      if (!db) {
        return reply
          .code(503)
          .send({ error: 'ServiceUnavailable', message: 'Artifact views require a database' });
      }
      const { tenantId } = await request.requireTenant();

      // One 404 for "no such version" and "no access to its space" alike —
      // whether a version exists is a fact about the space that owns it.
      const spaceId = await resolveArtifactVersionSpaceId(db, tenantId, versionId);
      const auth = request.authUser;
      const readable =
        spaceId !== null &&
        auth !== undefined &&
        (await canReadSpace(db, tenantId, auth.userId, spaceId, auth.authMethod));
      if (spaceId === null || !readable) {
        return reply.code(404).send({ error: 'NotFound', message: 'Artifact version not found' });
      }
      await fastify.requirePermission({
        resource: 'memory',
        action: 'read',
        getSpaceId: () => spaceId,
      })(request, reply);
      if (reply.sent) return undefined;

      const payloadStore = fastify.appContext.payloadStore;
      if (!payloadStore) {
        return reply
          .code(503)
          .send({ error: 'ServiceUnavailable', message: 'Artifact views require a payload store' });
      }

      const memoized = memoizedRefusal(versionId);
      if (memoized !== null) {
        return reply
          .code(404)
          .send({ error: 'ViewUnavailable', message: memoized.detail, reason: memoized.reason });
      }

      const view = await resolveAppletViewHtmlRef(db, tenantId, versionId, payloadStore);
      if (view.unavailable !== undefined) {
        memoizeRefusal(versionId, view.unavailable);
        return reply.code(404).send({
          error: 'ViewUnavailable',
          message: view.unavailable.detail,
          reason: view.unavailable.reason,
        });
      }

      const etag = `"${view.contentHash}"`;
      if (etagMatches(request.headers['if-none-match'], etag)) {
        // RFC 9111 §4.3.4: the 304's headers refresh the stored response, so
        // it repeats the validator and policy rather than sending bare.
        return reply
          .code(304)
          .header('ETag', etag)
          .header('Cache-Control', CACHE_CONTROL)
          .send(null);
      }

      let html = view.html;
      if (html === undefined) {
        let stored: unknown;
        try {
          stored = view.htmlRef === undefined ? null : await payloadStore.retrieve(view.htmlRef);
        } catch {
          stored = null;
        }
        if (typeof stored !== 'string') {
          return reply
            .code(404)
            .send({ error: 'ViewUnavailable', message: 'The stored view could not be read.' });
        }
        html = stored;
      }

      return reply
        .header('ETag', etag)
        .header('Cache-Control', CACHE_CONTROL)
        .header('X-Content-Type-Options', 'nosniff')
        .send({ versionId, html });
    },
  );
};
