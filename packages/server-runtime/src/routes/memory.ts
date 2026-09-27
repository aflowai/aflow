import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createTenantContext,
  createMemoryDocRepository,
  createMemoryDirRepository,
  createMemoryLinkRepository,
} from '@aflow/database';
import {
  writeMemoryDoc,
  isBinaryPayloadRef,
  MemoryWriteDeniedError,
  MemoryHashRequiredError,
  type MemoryWriteLogger,
} from '@aflow/memory-store';
import { bumpSpaceContextGen } from '@aflow/redis';
import { parseByteRangeHeader } from '../lib/httpRange.js';
import { resolveServableHeaders } from '../lib/servableContentType.js';

const ErrorSchema = z.object({ error: z.string(), message: z.string() });

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const DocStatSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  docType: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  contentHash: z.string().nullable(),
  tags: z.array(z.string()),
  semanticType: z.string().nullable().optional(),
  version: z.number(),
  embeddingStatus: z.string(),
  spaceId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
});

/** Mirrors the `view: "links"` page size of the memory operation surface. */
const LINKS_PAGE_CAP = 100;

/** Identity of a doc on either end of a link, enough for the client to open it. */
const LinkedDocSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  docType: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  updatedAt: z.string(),
});

const OutgoingLinkSchema = z.object({
  targetPath: z.string(),
  resolved: z.boolean(),
  occurrenceCount: z.number(),
  context: z.string().optional(),
  target: LinkedDocSchema.optional(),
});

const BacklinkSchema = z.object({
  fromPath: z.string(),
  context: z.string().optional(),
  updatedAt: z.string(),
  source: LinkedDocSchema.optional(),
});

const DirListItemSchema = z.object({
  entryType: z.enum(['directory', 'document']),
  id: z.string(),
  path: z.string(),
  name: z.string(),
  docType: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  updatedAt: z.string(),
  preview: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  childCount: z.object({ dirs: z.number(), docs: z.number() }).optional(),
  spaceId: z.string().uuid().nullable().optional(),
});

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  // =========================================================================
  // GET /v1/memory/docs — list / search / grep
  // =========================================================================
  app.get(
    '/docs',
    {
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'List, search, or grep memory documents',
        querystring: z.object({
          pathPrefix: z.string().default('/'),
          mode: z.enum(['list', 'search', 'grep']).default('list'),
          query: z.string().optional(),
          recursive: z
            .string()
            .transform((v) => v === 'true')
            .default('false'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            items: z.array(DirListItemSchema),
            nextCursor: z.string().nullable(),
          }),
          400: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { pathPrefix, mode, query, recursive, limit, cursor } = request.query;

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );
      const dirRepo = createMemoryDirRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const scope = { spaceId: space.spaceId };

      if (mode === 'list' && !recursive) {
        // Directory-style listing via dirRepo
        const dirItems = await dirRepo.listDir(pathPrefix, {
          scope,
          limit: limit + 1,
          cursor,
        });

        const hasMore = dirItems.length > limit;
        const items = dirItems.slice(0, limit).map((item) => ({
          entryType: item.entryType,
          id: item.id,
          path: item.path,
          name: item.name,
          docType: item.docType ?? (item.entryType === 'directory' ? 'directory' : undefined),
          mimeType:
            item.mimeType ?? (item.entryType === 'directory' ? 'inode/directory' : undefined),
          sizeBytes: item.sizeBytes ?? 0,
          updatedAt: item.updatedAt.toISOString(),
          preview: item.preview ?? undefined,
          description: item.description ?? undefined,
          childCount: item.childCount,
          spaceId: item.spaceId ?? undefined,
        }));

        const lastItem = items[items.length - 1];
        return reply.send({
          items,
          nextCursor: hasMore && lastItem ? lastItem.name : null,
        });
      }

      if (mode === 'list' && recursive) {
        const results = await repo.list({
          pathPrefix,
          scope,
          limit: limit + 1,
          cursor,
        });
        const hasMore = results.length > limit;
        const items = results.slice(0, limit).map((r) => ({
          entryType: 'document' as const,
          id: r.id,
          path: r.path,
          name: r.path.split('/').pop() ?? r.path,
          docType: r.docType,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
          semanticType: r.semanticType ?? undefined,
          updatedAt: r.updatedAt.toISOString(),
          preview: r.preview ?? undefined,
          spaceId: r.spaceId ?? undefined,
        }));
        const lastItem = items[items.length - 1];
        return reply.send({
          items,
          nextCursor: hasMore && lastItem ? lastItem.path : null,
        });
      }

      if (!query) {
        return reply.status(400).send({
          error: 'VALIDATION',
          message: `query parameter is required for ${mode} mode`,
        });
      }

      if (mode === 'grep') {
        // Try FTS first, fall back to ILIKE
        const results = await repo.searchFts({ pathPrefix, scope, limit, query });
        if (results.length === 0) {
          const grepResults = await repo.grep({ pathPrefix, scope, limit, query });
          return reply.send({
            items: grepResults.map((r) => ({
              entryType: 'document' as const,
              id: r.id,
              path: r.path,
              name: r.path.split('/').pop() ?? r.path,
              docType: r.docType,
              mimeType: r.mimeType,
              sizeBytes: r.sizeBytes,
              updatedAt: r.updatedAt.toISOString(),
              spaceId: r.spaceId ?? undefined,
            })),
            nextCursor: null,
          });
        }
        return reply.send({
          items: results.map((r) => ({
            entryType: 'document' as const,
            id: r.docId,
            path: r.path,
            name: r.path.split('/').pop() ?? r.path,
            docType: r.docType,
            mimeType: r.mimeType,
            sizeBytes: r.sizeBytes,
            updatedAt: r.updatedAt.toISOString(),
            spaceId: r.spaceId ?? undefined,
          })),
          nextCursor: null,
        });
      }

      // search mode — FTS only for now (no vector via REST)
      const results = await repo.searchFts({ pathPrefix, scope, limit, query });
      return reply.send({
        items: results.map((r) => ({
          entryType: 'document' as const,
          id: r.docId,
          path: r.path,
          name: r.path.split('/').pop() ?? r.path,
          docType: r.docType,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
          updatedAt: r.updatedAt.toISOString(),
          spaceId: r.spaceId ?? undefined,
        })),
        nextCursor: null,
      });
    },
  );

  // =========================================================================
  // GET /v1/memory/docs/:docId — get document (stat + optional content)
  // =========================================================================
  app.get(
    '/docs/:docId',
    {
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Get document by ID (stat, preview, or full content)',
        params: z.object({ docId: z.string().uuid() }),
        querystring: z.object({
          view: z.enum(['stat', 'preview', 'content']).default('content'),
          maxBytes: z.coerce.number().int().min(0).max(10_485_760).default(1_048_576),
        }),
        response: {
          200: z.object({
            stat: DocStatSchema,
            data: z.string().optional(),
            dataJson: z.unknown().optional(),
            truncated: z.boolean().optional(),
          }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { docId } = request.params;
      const { view, maxBytes } = request.query;

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const doc = await repo.getById(docId, space.spaceId);
      if (!doc || doc.deletedAt) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Document not found' });
      }

      const stat = {
        id: doc.id,
        path: doc.path,
        docType: doc.docType,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        contentHash: doc.contentHash,
        tags: doc.tags,
        semanticType: doc.semanticType,
        version: doc.currentVersion,
        embeddingStatus: doc.embeddingStatus,
        spaceId: doc.spaceId,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      };

      if (view === 'stat') {
        return reply.send({ stat });
      }

      const payloadStore = fastify.appContext.payloadStore;

      if (doc.inlineContent === null && doc.payloadRef && isBinaryPayloadRef(doc.payloadRef)) {
        // The viewer plays media from a base64 `data:` URI, so the bytes come
        // back whole or not at all — a prefix of an MP4 is not a playable file.
        // The recorded size gates the transfer; the retrieved length decides.
        if (view === 'preview' || !payloadStore) {
          return reply.send({ stat });
        }
        if (doc.sizeBytes > maxBytes) {
          return reply.send({ stat, truncated: true });
        }
        const bytes = await payloadStore.retrieveBytes(doc.payloadRef);
        if (bytes.length > maxBytes) {
          return reply.send({ stat, truncated: true });
        }
        return reply.send({ stat, data: bytes.toString('base64') });
      }

      // Retrieve content
      let content: string | null = null;
      let contentJson: unknown;

      if (doc.inlineContent !== null) {
        content = doc.inlineContent;
      } else if (doc.payloadRef && payloadStore) {
        const payload = await payloadStore.retrieve(doc.payloadRef);
        if (typeof payload === 'string') {
          content = payload;
        } else {
          contentJson = payload;
          content = JSON.stringify(payload);
        }
      }

      if (view === 'preview') {
        return reply.send({
          stat,
          data: content ? content.substring(0, 500) : undefined,
        });
      }

      // Full content
      let truncated = false;
      let data: string | undefined;
      let dataJson: unknown;

      if (content !== null) {
        if (content.length > maxBytes) {
          data = content.substring(0, maxBytes);
          truncated = true;
        } else {
          data = content;
        }
        if (contentJson !== undefined && !truncated) {
          dataJson = contentJson;
        }
      }

      return reply.send({
        stat,
        ...(data !== undefined ? { data } : {}),
        ...(dataJson !== undefined ? { dataJson } : {}),
        ...(truncated ? { truncated } : {}),
      });
    },
  );

  // =========================================================================
  // GET /v1/memory/docs/:docId/bytes — byte-serve a binary document
  // =========================================================================
  app.get(
    '/docs/:docId/bytes',
    {
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Stream the raw bytes of a binary document',
        description: `
Byte-serve an image/audio/video document so a player can seek without
downloading the whole file. A \`Range: bytes=<start>-<end>\` request answers 206
with \`Content-Range\`; a range past the end answers 416; a request without a
\`Range\` header answers 200 with \`Content-Length\`. Every response advertises
\`Accept-Ranges: bytes\`, and the bytes carry the document's own \`Content-Type\`.

Text documents are not byte-served — read them with
\`GET /v1/memory/docs/{docId}?view=content\`.
        `.trim(),
        params: z.object({ docId: z.string().uuid() }),
        response: {
          400: ErrorSchema,
          404: ErrorSchema,
          416: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const doc = await repo.getById(request.params.docId, space.spaceId);
      if (!doc || doc.deletedAt) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Document not found' });
      }

      // Servability is decided by the lane the bytes were written to, not by
      // the docType: `api.http.download` labels media `binary`, and a large SVG
      // is labelled `image` while its body is text on the `.json` lane.
      const payloadRef = doc.payloadRef;
      if (payloadRef === null || !isBinaryPayloadRef(payloadRef)) {
        return reply.status(400).send({
          error: 'NOT_BINARY',
          message: `Document ${doc.path} does not hold raw bytes. Read it with GET /v1/memory/docs/${doc.id}?view=content.`,
        });
      }

      const payloadStore = fastify.appContext.payloadStore;
      if (!payloadStore) {
        return reply
          .status(503)
          .send({ error: 'NO_PAYLOAD_STORE', message: 'Payload store is not configured.' });
      }

      if (!(await payloadStore.exists(payloadRef))) {
        return reply
          .status(404)
          .send({ error: 'NOT_FOUND', message: 'Document bytes are no longer stored' });
      }

      const sizeBytes = doc.sizeBytes;
      const etag = doc.contentHash === null ? undefined : `"${doc.contentHash}"`;
      reply.header('Accept-Ranges', 'bytes');

      // If-Range guards against splicing two versions of a doc that was
      // rewritten while the player was still seeking through the old one.
      const ifRange = request.headers['if-range'];
      const rangeApplies = ifRange === undefined ? true : ifRange === etag;
      const range = rangeApplies
        ? parseByteRangeHeader(request.headers.range, sizeBytes)
        : ({ kind: 'none' } as const);

      if (range.kind === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${String(sizeBytes)}`);
        return reply.status(416).send({
          error: 'RANGE_NOT_SATISFIABLE',
          message: `Requested range lies outside the ${String(sizeBytes)}-byte document`,
        });
      }

      // The document's own content type goes on only once every JSON refusal
      // is behind us — Fastify refuses to send an object under it.
      //
      // And only if it is one a browser may act on. `mimeType` is written with
      // the document, so it is chosen by whoever wrote the content; serving
      // `text/html` or SVG back under it would make stored bytes into script on
      // an aflow.ai origin, which the render-boundary sanitizer never sees
      // because the browser fetched this response directly.
      const servable = resolveServableHeaders(doc.mimeType);
      reply.header('Content-Type', servable.contentType);
      if (servable.contentDisposition !== undefined) {
        reply.header('Content-Disposition', servable.contentDisposition);
      }
      // Stops a browser sniffing its way back to a rendering decision the
      // declared type no longer authorizes.
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, no-store');
      if (etag !== undefined) reply.header('ETag', etag);

      // Only the refusals above carry a declared response shape; the success
      // bodies are raw bytes Fastify pipes untouched.
      const byteReply = reply as unknown as FastifyReply;

      if (range.kind === 'range') {
        const { start, end } = range;
        reply.header('Content-Range', `bytes ${String(start)}-${String(end)}/${String(sizeBytes)}`);
        reply.header('Content-Length', String(end - start + 1));
        return byteReply
          .status(206)
          .send(await payloadStore.openByteStream(payloadRef, { start, end }));
      }

      reply.header('Content-Length', String(sizeBytes));
      return byteReply.send(await payloadStore.openByteStream(payloadRef));
    },
  );

  // =========================================================================
  // GET /v1/memory/docs/:docId/links — both directions of the wikilink graph
  // =========================================================================
  app.get(
    '/docs/:docId/links',
    {
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Outgoing wikilinks and backlinks for a document',
        params: z.object({ docId: z.string().uuid() }),
        response: {
          200: z.object({
            outgoing: z.array(OutgoingLinkSchema),
            backlinks: z.array(BacklinkSchema),
            outgoingTotal: z.number(),
            outgoingGhostTotal: z.number(),
            backlinkTotal: z.number(),
            truncated: z.boolean().optional(),
          }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const tenantCtx = createTenantContext(tenant.tenantId);
      const db = fastify.appContext.db as PostgresJsDatabase;
      const repo = createMemoryDocRepository(db, tenantCtx);

      const doc = await repo.getById(request.params.docId, space.spaceId);
      if (!doc || doc.deletedAt) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Document not found' });
      }

      const linkRepo = createMemoryLinkRepository(db, tenantCtx);
      const [outgoingAll, backlinkPage, outgoingCounts, backlinkTotal] = await Promise.all([
        linkRepo.getOutgoingLinks(doc.id, space.spaceId),
        linkRepo.getBacklinks(doc.path, space.spaceId, { limit: LINKS_PAGE_CAP }),
        linkRepo.countOutgoing(doc.id, space.spaceId),
        linkRepo.countBacklinks(doc.path, space.spaceId),
      ]);

      const outgoingPage = outgoingAll.slice(0, LINKS_PAGE_CAP);
      const outgoingTotal = outgoingCounts.resolved + outgoingCounts.ghost;

      // The link graph stores paths, and there is no get-by-path read — so one
      // batch lookup turns every live endpoint into something the client can open.
      const endpointPaths = new Set<string>([
        ...outgoingPage.filter((l) => l.resolved).map((l) => l.targetPath),
        ...backlinkPage.items.map((b) => b.fromPath),
      ]);
      const docByPath = new Map<string, z.infer<typeof LinkedDocSchema>>();
      if (endpointPaths.size > 0) {
        const rows = await repo.listByPaths([...endpointPaths], {
          scope: { spaceId: space.spaceId },
        });
        for (const row of rows) {
          docByPath.set(row.path, {
            id: row.id,
            path: row.path,
            docType: row.docType,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            updatedAt: row.updatedAt.toISOString(),
          });
        }
      }

      const outgoing = outgoingPage.map((link) => {
        const target = docByPath.get(link.targetPath);
        return {
          targetPath: link.targetPath,
          resolved: link.resolved,
          occurrenceCount: link.occurrenceCount,
          ...(link.firstContext !== null ? { context: link.firstContext } : {}),
          ...(target ? { target } : {}),
        };
      });

      const backlinks = backlinkPage.items.map((backlink) => {
        const source = docByPath.get(backlink.fromPath);
        return {
          fromPath: backlink.fromPath,
          ...(backlink.firstContext !== null ? { context: backlink.firstContext } : {}),
          updatedAt: backlink.updatedAt.toISOString(),
          ...(source ? { source } : {}),
        };
      });

      const truncated =
        outgoingTotal > outgoing.length || backlinkTotal > backlinks.length ? true : undefined;

      return reply.send({
        outgoing,
        backlinks,
        outgoingTotal,
        outgoingGhostTotal: outgoingCounts.ghost,
        backlinkTotal,
        ...(truncated !== undefined ? { truncated } : {}),
      });
    },
  );

  // =========================================================================
  // PUT /v1/memory/docs — create or upsert a document
  // =========================================================================
  app.put(
    '/docs',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Create or upsert a document',
        body: z.object({
          path: z.string().min(1).max(1024),
          content: z.string(),
          docType: z.string().default('text'),
          mimeType: z.string().default('text/plain'),
          tags: z.array(z.string()).default([]),
          semanticType: z.string().max(64).nullable().optional(),
          summary: z.string().nullable().optional(),
          writeMode: z.enum(['create', 'upsert', 'overwrite']).default('upsert'),
          expectedHash: z.string().min(1).optional(),
        }),
        response: {
          200: z.object({
            id: z.string().uuid(),
            path: z.string(),
            version: z.number(),
            sizeBytes: z.number(),
          }),
          400: ErrorSchema,
          409: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const {
        path,
        content,
        docType,
        mimeType,
        tags,
        semanticType,
        summary,
        writeMode,
        expectedHash,
      } = request.body;
      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );
      const dirRepo = createMemoryDirRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const payloadStore = fastify.appContext.payloadStore;
      if (!payloadStore) {
        // Server misconfiguration (DB reachable but the payload store isn't) —
        // not a client error.
        return reply
          .status(503)
          .send({ error: 'NO_PAYLOAD_STORE', message: 'Payload store is not configured.' });
      }

      const writeLog: MemoryWriteLogger = {
        info: (message, data) => {
          request.log.info(data ?? {}, message);
        },
        warn: (message, data) => {
          request.log.warn(data ?? {}, message);
        },
        error: (message, data) => {
          request.log.error(data ?? {}, message);
        },
      };

      try {
        // Route through the single derivation authority so REST writes populate
        // memory_links + memory_docs.properties/derivation exactly like the
        // executor put.
        const result = await writeMemoryDoc({
          repo,
          dirRepo,
          payloadStore,
          ...(fastify.appContext.redis ? { redis: fastify.appContext.redis } : {}),
          log: writeLog,
          tenantId: tenant.tenantId,
          origin: { kind: 'external', actor: 'api' },
          spaceId: space.spaceId,
          path,
          content: { kind: 'text', text: content },
          docType,
          mimeType,
          indexing: 'auto',
          tags,
          summary: summary ?? null,
          semanticType: semanticType ?? null,
          ...(writeMode !== 'upsert' ? { writeMode } : {}),
          ...(expectedHash ? { expectedHash } : {}),
        });

        // REST writes bypass the orchestrator result path, so bump the per-space
        // generation here too — otherwise other live runs in the space serve a
        // stale SpaceContext until the 1h TTL. Best-effort.
        if (fastify.appContext.redis) {
          await bumpSpaceContextGen(fastify.appContext.redis, tenant.tenantId, space.spaceId);
        }

        return await reply.send({
          id: result.doc.id,
          path: result.doc.path,
          version: result.doc.currentVersion,
          sizeBytes: result.doc.sizeBytes,
        });
      } catch (err) {
        if (err instanceof MemoryWriteDeniedError) {
          return reply.status(400).send({ error: 'WRITE_DENIED', message: err.message });
        }
        if (err instanceof MemoryHashRequiredError) {
          return reply.status(400).send({ error: 'MEMORY_HASH_REQUIRED', message: err.message });
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('MEMORY_ALREADY_EXISTS')) {
          return reply.status(409).send({ error: 'CONFLICT', message: msg });
        }
        if (msg.includes('MEMORY_HASH_MISMATCH')) {
          return reply.status(409).send({ error: 'MEMORY_HASH_MISMATCH', message: msg });
        }
        throw err;
      }
    },
  );

  // =========================================================================
  // DELETE /v1/memory/docs/:docId — soft-delete a document or directory
  // =========================================================================
  app.delete(
    '/docs/:docId',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Soft-delete a document or directory by ID',
        params: z.object({ docId: z.string().uuid() }),
        querystring: z.object({
          recursive: z
            .string()
            .transform((v) => v === 'true')
            .default('false'),
        }),
        response: {
          200: z.object({
            id: z.string(),
            path: z.string(),
            deleted: z.boolean(),
            entryType: z.enum(['document', 'directory']).optional(),
          }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const tenantCtx = createTenantContext(tenant.tenantId);
      const db = fastify.appContext.db as PostgresJsDatabase;
      const repo = createMemoryDocRepository(db, tenantCtx);
      const dirRepo = createMemoryDirRepository(db, tenantCtx);

      // A delete changes space-visible memory but bypasses the orchestrator
      // result path, so bump the per-space generation to keep other live runs
      // fresh within the 1h TTL. Best-effort.
      const bumpGen = async (): Promise<void> => {
        if (fastify.appContext.redis) {
          await bumpSpaceContextGen(fastify.appContext.redis, tenant.tenantId, space.spaceId);
        }
      };

      // Try as document first
      const doc = await repo.getById(request.params.docId, space.spaceId);
      if (doc && !doc.deletedAt) {
        await repo.softDelete(doc.id, space.spaceId);
        await repo.deleteChunksForDoc(doc.id);
        await bumpGen();
        return reply.send({ id: doc.id, path: doc.path, deleted: true, entryType: 'document' });
      }

      // Try as directory by ID
      const dir = await dirRepo.getDirById(request.params.docId, space.spaceId);
      if (dir) {
        const deleted = await dirRepo.deleteDir(dir.path, space.spaceId, request.query.recursive);
        await bumpGen();
        return reply.send({ id: dir.id, path: dir.path, deleted, entryType: 'directory' });
      }

      return reply
        .status(404)
        .send({ error: 'NOT_FOUND', message: 'Document or directory not found' });
    },
  );

  // =========================================================================
  // POST /v1/memory/dirs — create a directory (mkdir)
  // =========================================================================
  app.post(
    '/dirs',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Create a directory',
        body: z.object({
          path: z.string().min(1).max(1024),
          description: z.string().max(2000).optional(),
        }),
        response: {
          200: z.object({ id: z.string(), path: z.string(), created: z.boolean() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const tenantCtx = createTenantContext(tenant.tenantId);
      const dirRepo = createMemoryDirRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const result = await dirRepo.mkdir({
        path: request.body.path,
        description: request.body.description,
        scope: { spaceId: space.spaceId },
      });

      return reply.send(result);
    },
  );

  // =========================================================================
  // DELETE /v1/memory/dirs/:dirId — delete a directory
  // =========================================================================
  app.delete(
    '/dirs/:dirId',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Delete a directory',
        params: z.object({ dirId: z.string().uuid() }),
        querystring: z.object({
          recursive: z
            .string()
            .transform((v) => v === 'true')
            .default('false'),
        }),
        response: {
          200: z.object({ id: z.string(), path: z.string(), deleted: z.boolean() }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const tenantCtx = createTenantContext(tenant.tenantId);
      const dirRepo = createMemoryDirRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const dir = await dirRepo.getDirById(request.params.dirId, space.spaceId);
      if (!dir) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Directory not found' });
      }

      const deleted = await dirRepo.deleteDir(dir.path, space.spaceId, request.query.recursive);
      return reply.send({ id: dir.id, path: dir.path, deleted });
    },
  );

  // =========================================================================
  // GET /v1/memory/trash — list soft-deleted documents
  // =========================================================================
  app.get(
    '/trash',
    {
      config: { authz: { resource: 'memory', action: 'read', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'List soft-deleted documents (trash)',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
        response: {
          200: z.object({
            items: z.array(DocStatSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();
      const { limit, cursor } = request.query;

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const docs = await repo.listDeleted({
        spaceId: space.spaceId,
        limit: limit + 1,
        ...(cursor != null ? { cursor } : {}),
      });

      const hasMore = docs.length > limit;
      const items = docs.slice(0, limit).map((doc) => ({
        id: doc.id,
        path: doc.path,
        docType: doc.docType,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        contentHash: doc.contentHash,
        tags: doc.tags,
        version: doc.currentVersion,
        embeddingStatus: doc.embeddingStatus,
        spaceId: doc.spaceId,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
        deletedAt: doc.deletedAt?.toISOString() ?? null,
      }));

      const lastItem = items[items.length - 1];
      return reply.send({
        items,
        nextCursor: hasMore && lastItem ? lastItem.path : null,
      });
    },
  );

  // =========================================================================
  // POST /v1/memory/trash/:docId/restore — restore a soft-deleted document
  // =========================================================================
  app.post(
    '/trash/:docId/restore',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Restore a soft-deleted document',
        params: z.object({ docId: z.string().uuid() }),
        response: {
          200: z.object({ id: z.string(), path: z.string(), restored: z.boolean() }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );
      const dirRepo = createMemoryDirRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      // Verify doc exists, is deleted, and belongs to this space
      const doc = await repo.getById(request.params.docId, space.spaceId, { includeDeleted: true });
      if (!doc?.deletedAt) {
        return reply
          .status(404)
          .send({ error: 'NOT_FOUND', message: 'Deleted document not found' });
      }

      const restored = await repo.restore(doc.id, space.spaceId);

      // Ensure parent directories are alive
      if (restored) {
        await dirRepo.ensureParentDirs(doc.path, { spaceId: space.spaceId });
      }

      return reply.send({ id: doc.id, path: doc.path, restored });
    },
  );

  // =========================================================================
  // DELETE /v1/memory/trash/:docId — permanently delete
  // =========================================================================
  app.delete(
    '/trash/:docId',
    {
      config: { authz: { resource: 'memory', action: 'write', spaceIdFrom: 'requireSpace' } },
      schema: {
        tags: ['Memory'],
        summary: 'Permanently delete a document (hard delete)',
        params: z.object({ docId: z.string().uuid() }),
        response: {
          200: z.object({ id: z.string(), purged: z.boolean() }),
          404: ErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const space = await request.requireSpace();

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(
        fastify.appContext.db as PostgresJsDatabase,
        tenantCtx,
      );

      const doc = await repo.getById(request.params.docId, space.spaceId, { includeDeleted: true });
      if (!doc?.deletedAt) {
        return reply
          .status(404)
          .send({ error: 'NOT_FOUND', message: 'Deleted document not found' });
      }

      const purged = await repo.hardDelete(doc.id, space.spaceId);
      return reply.send({ id: doc.id, purged });
    },
  );
};
