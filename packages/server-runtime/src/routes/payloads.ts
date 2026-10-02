/**
 * Payload endpoints - upload and manage large payloads.
 *
 * Payloads larger than MAX_INLINE_PAYLOAD_BYTES are stored in GCS.
 * This endpoint provides:
 * - Direct upload URLs for large payloads
 * - Inline storage for small payloads
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SessionId, StepExecutionId } from '@aflow/schemas';
import {
  PayloadKindSchema as SharedPayloadKindSchema,
  isDurablePayloadKind,
  parsePayloadRef,
} from '@aflow/schemas';
import { assertSessionSpaceAccess } from '../lib/sessionSpaceAccess.js';
import { NEUTRALIZED_CONTENT_TYPE } from '../lib/servableContentType.js';

// ============================================================================
// Schemas
// ============================================================================

const PayloadKindSchema = SharedPayloadKindSchema;

/**
 * A stored object's Content-Type is what a signed read URL serves it with, so
 * this caller-supplied label — never the bytes — decides whether a browser
 * renders the object inline instead of downloading it. Only an allowlist holds:
 * `text/html`, SVG, XHTML and XSLT-bearing XML are each script-capable in their
 * own way, and that set grows with the web platform.
 *
 * Parameters (`; charset=…`) are rejected rather than parsed — a label this
 * route re-serves should not need a parser to be understood.
 */
const StorableContentTypeSchema = z.enum([
  'application/json',
  'text/plain',
  'application/octet-stream',
]);

/**
 * Narrower than what the serving layer will render inline, and deliberately so:
 * this route always JSON-encodes the bytes it stores, so any label beyond these
 * three is a claim about content that is not what was written. The two lists
 * answer different questions and are not merged — but the storable set must
 * stay a SUBSET of the inline-safe one, since a type permitted here that the
 * serving layer considers script-capable would be stored under a label a
 * browser acts on. `payloadContentTypeGuard.test.ts` holds that direction.
 */
export const STORABLE_CONTENT_TYPES = StorableContentTypeSchema.options;

const CreatePayloadRequestSchema = z.object({
  /** Run ID this payload belongs to */
  runId: z.string().uuid(),
  /** Step execution ID (optional for run-level payloads) */
  stepExecutionId: z.string().uuid().optional(),
  /** Attempt number */
  attempt: z.number().int().min(0).default(0),
  /** Kind of payload */
  kind: PayloadKindSchema,
  /** Inline data (for small payloads) */
  data: z.unknown().optional(),
  /** Content type the stored object is served with */
  contentType: StorableContentTypeSchema.optional(),
  /** Expected size in bytes (for large uploads) */
  expectedSizeBytes: z.number().int().positive().optional(),
});

const CreatePayloadResponseSchema = z.object({
  /** Payload reference URI */
  payloadRef: z.string(),
  /** Signed upload URL (only for large payloads without inline data) */
  uploadUrl: z.string().optional(),
  /** URL expiration time (ISO 8601) */
  uploadUrlExpiresAt: z.string().optional(),
  /**
   * Content-Type the upload URL is signed for. The PUT must send exactly this
   * header — any other value fails signature verification.
   */
  uploadContentType: z.string().optional(),
  /** Whether the payload was stored inline */
  storedInline: z.boolean(),
});

// Response can be:
// 1. Raw payload data (any shape - exactly what the executor stored)
// 2. Object with downloadUrl (for large payloads)
const GetPayloadResponseSchema = z.union([
  // Raw payload data (any structure)
  z.unknown(),
  // Download URL response (for large payloads)
  z.object({
    downloadUrl: z.string(),
    downloadUrlExpiresAt: z.string().optional(),
  }),
]);

// ============================================================================
// Routes
// ============================================================================

export const payloadRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook('preHandler', app.authenticate);

  /**
   * Authorize a caller-supplied ref before it reaches the store. The tenant
   * segment of the object path is compared against the authenticated tenant,
   * so a ref belonging to another tenant is denied on its own terms — the
   * store resolves paths against one configured bucket and would otherwise
   * happily serve, sign, or delete any path it is handed.
   *
   * Denials are 404 so a probe cannot distinguish "exists elsewhere" from
   * "does not exist".
   */
  const authorizePayloadRef = async (
    request: FastifyRequest,
    reply: FastifyReply,
    args: { payloadRef: string; action: 'read' | 'write' | 'delete' },
  ): Promise<boolean> => {
    const parsed = parsePayloadRef(args.payloadRef);
    if (!parsed) {
      reply.status(404).send({ error: 'NotFound', message: 'Payload not found' });
      return false;
    }

    // Inline refs carry their own bytes — the caller is reading back what the
    // caller supplied, and no stored object is reachable through them.
    if (parsed.form === 'inline') return true;

    const { tenantId } = await request.requireTenant();
    if (parsed.tenantId !== tenantId) {
      reply.status(404).send({ error: 'NotFound', message: 'Payload not found' });
      return false;
    }

    // A content-addressed object names no run, and the space authority for its
    // bytes lives on the row that references it (a memory doc), not on the
    // path. This endpoint authorizes by run, so it has nothing to check against
    // — the owning surface serves those bytes under its own space check.
    if (parsed.layout === 'content') {
      reply.status(404).send({ error: 'NotFound', message: 'Payload not found' });
      return false;
    }

    return assertSessionSpaceAccess(fastify, request, reply, {
      action: args.action,
      sessionId: parsed.runId,
    });
  };

  // -------------------------------------------------------------------------
  // POST /v1/payloads - Create a payload reference and get upload URL
  // -------------------------------------------------------------------------
  app.post(
    '/',
    {
      config: {
        authz: { resource: 'session', action: 'write' },
      },
      schema: {
        tags: ['Payloads'],
        summary: 'Create payload reference',
        description: `
Create a payload reference for storing data.

For small payloads (< 64KB), you can include the data directly and it will be stored inline.

For large payloads, omit the data and provide expectedSizeBytes. You'll receive a signed upload URL
that can be used to upload directly to GCS — but only where the payload backend has an object host
to sign against. A deployment storing payloads on a filesystem or in Redis answers 501 instead, and
the data has to be sent on this request.

A stored object is served with the contentType given here, so the accepted types are limited to
those a browser will not render inline. The signed upload URL is issued for that one type and the
upload must send it as its Content-Type header; an upload that declares no type is pinned to
${NEUTRALIZED_CONTENT_TYPE}.
        `.trim(),
        body: CreatePayloadRequestSchema,
        response: {
          201: CreatePayloadResponseSchema,
          501: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { tenantId } = await request.requireTenant();
      const { runId, stepExecutionId, attempt, kind, data, contentType } = request.body;

      if (
        !(await assertSessionSpaceAccess(fastify, request, reply, {
          action: 'write',
          sessionId: runId,
        }))
      ) {
        return;
      }

      const payloadStore = fastify.appContext.payloadStore;

      // If no payload store configured, return mock response
      if (!payloadStore) {
        const mockRef = `inline:${crypto.randomUUID()}`;
        reply.status(201).send({
          payloadRef: mockRef,
          storedInline: true,
        });
        return;
      }

      // Build payload reference
      const payloadRef = payloadStore.buildRef({
        tenantId: tenantId,
        runId: runId as SessionId,
        stepExecutionId: (stepExecutionId ?? runId) as StepExecutionId,
        attempt,
        kind: kind,
      });

      // If data is provided, check if it should be stored
      if (data !== undefined) {
        // Small data is stored as well; only the response marks it inline.
        await payloadStore.store({
          tenantId: tenantId,
          runId: runId as SessionId,
          stepExecutionId: (stepExecutionId ?? runId) as StepExecutionId,
          attempt,
          kind,
          data,
          persist: isDurablePayloadKind(kind),
          ...(contentType ? { contentType } : {}),
        });

        reply.status(201).send({
          payloadRef,
          storedInline: !payloadStore.shouldStore(data),
        });
        return;
      }

      // No data provided, generate a signed upload URL.
      //
      // A backend with no object host cannot issue one, and there is nothing
      // for the client to do with the rejection that follows. Naming the
      // limitation is the whole of what this deployment can offer: send the
      // bytes on the request instead.
      if (!payloadStore.servesSignedUrls) {
        reply.status(501).send({
          error: 'NotImplemented',
          message:
            'This deployment stores payloads without an object host, so it cannot issue an upload URL. Send the payload data on this request instead.',
        });
        return;
      }

      //
      // The signature pins the Content-Type, so the allowlist checked here is
      // what the object ends up labelled with. Leaving it unpinned would let
      // the uploader label the bytes anything at all, and a later signed read
      // serves an object with whatever type it was stored under — the check
      // above would be defeated one hop later, by the same caller.
      //
      // An upload that declares no type is pinned to inert bytes rather than
      // left open: the route has not seen the content and cannot vouch for a
      // rendering meaning it was never told.
      const uploadContentType = contentType ?? NEUTRALIZED_CONTENT_TYPE;
      const expiresInSeconds = 3600; // 1 hour
      const uploadUrl = await payloadStore.getSignedUrl(payloadRef, {
        action: 'write',
        expiresInSeconds,
        contentType: uploadContentType,
      });

      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

      reply.status(201).send({
        payloadRef,
        uploadUrl,
        uploadUrlExpiresAt: expiresAt,
        uploadContentType,
        storedInline: false,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/payloads - Get payload data or download URL (query param)
  // GET /v1/payloads/* - Get payload data or download URL (path)
  // -------------------------------------------------------------------------

  // Handler function shared by both routes
  const getPayloadHandler = async (
    request: FastifyRequest<{
      Querystring: { ref?: string; forceUrl?: boolean };
      Params: { '*'?: string };
    }>,
    reply: FastifyReply,
  ) => {
    // Get payloadRef from wildcard path or query param
    const wildcardPath = request.params['*'];
    const { ref, forceUrl } = request.query;
    const payloadRef = ref || wildcardPath;

    // Validate payloadRef is provided
    if (!payloadRef) {
      reply.status(400).send({
        error: 'NotFound',
        message: 'Payload reference required',
      });
      return;
    }

    if (!(await authorizePayloadRef(request, reply, { payloadRef, action: 'read' }))) {
      return;
    }

    const payloadStore = fastify.appContext.payloadStore;

    // If no payload store configured, return error
    if (!payloadStore) {
      reply.status(404).send({
        error: 'NotFound',
        message: 'Payload store not configured',
      });
      return;
    }

    // Check if payload exists
    const exists = await payloadStore.exists(payloadRef);
    if (!exists) {
      reply.status(404).send({
        error: 'NotFound',
        message: `Payload not found: ${payloadRef}`,
      });
      return;
    }

    // Every branch below would rather hand the client a URL and let it fetch
    // the bytes from object storage. A backend with no object host in front of
    // it cannot, and asking anyway yields a rejection or a URL that resolves
    // nowhere — so where it cannot, this route is what delivers the payload.
    const canRedirect = payloadStore.servesSignedUrls;

    const sendSignedUrl = async (): Promise<void> => {
      const expiresInSeconds = 3600;
      const downloadUrl = await payloadStore.getSignedUrl(payloadRef, {
        action: 'read',
        expiresInSeconds,
      });
      reply.send({
        downloadUrl,
        downloadUrlExpiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      });
    };

    // Asking for a URL is asking for the payload by another route. Answering
    // with the payload serves that caller; answering with an error serves
    // nobody.
    if (forceUrl && canRedirect) {
      await sendSignedUrl();
      return;
    }

    try {
      const data = await payloadStore.retrieve(payloadRef);

      // 10 MB — images and video from AI generation pass 1 MB as base64 easily,
      // and a response that size is worth diverting to storage. Where there is
      // nowhere to divert it to, the cap would turn a readable payload into no
      // payload at all, so it only applies when a URL is actually available —
      // and measuring costs a second full copy of the payload, so it is only
      // measured where the answer can change what happens.
      const MAX_INLINE_RESPONSE_BYTES = 10 * 1024 * 1024;
      if (
        canRedirect &&
        Buffer.byteLength(JSON.stringify(data), 'utf-8') > MAX_INLINE_RESPONSE_BYTES
      ) {
        await sendSignedUrl();
        return;
      }

      // Raw data — the caller gets exactly what the executor stored.
      reply.send(data);
    } catch (err) {
      // A signed URL is a second way to reach the same bytes, so it is worth
      // trying when the first way fails. Without one, the retrieval failure is
      // the answer rather than something to paper over.
      if (!canRedirect) throw err;
      await sendSignedUrl();
    }
  };

  const getPayloadSchema = {
    tags: ['Payloads'],
    summary: 'Get payload',
    description: `
Retrieve a payload by reference.

For small payloads, the data is returned inline.
For large payloads, a signed download URL is returned where the payload backend
has an object host to sign against; where it does not, the data is returned
inline regardless of size, because no URL would resolve.

The payloadRef can be passed as a path (e.g., /v1/payloads/gs://bucket/path)
or as a query parameter (e.g., /v1/payloads?ref=gs://bucket/path).
    `.trim(),
    querystring: z.object({
      /** Payload reference (alternative to path) */
      ref: z.string().optional(),
      /**
       * Prefer a download URL over inline data. Honoured only where the payload
       * backend can sign one; where it cannot, the payload is returned inline
       * whatever its size, because no URL would resolve.
       */
      forceUrl: z.coerce.boolean().optional(),
    }),
    response: {
      200: GetPayloadResponseSchema,
      404: z.object({
        error: z.literal('NotFound'),
        message: z.string(),
      }),
    },
  };

  // Base route for query param access
  app.get(
    '/',
    { config: { authz: { resource: 'session', action: 'read' } }, schema: getPayloadSchema },
    getPayloadHandler,
  );

  // Wildcard route for path access
  app.get(
    '/*',
    { config: { authz: { resource: 'session', action: 'read' } }, schema: getPayloadSchema },
    getPayloadHandler,
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/payloads - Delete a payload
  // -------------------------------------------------------------------------
  const deletePayloadHandler = async (
    request: FastifyRequest<{
      Querystring: { ref?: string };
      Params: { '*'?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const wildcardPath = request.params['*'];
    const { ref } = request.query;
    const payloadRef = ref || wildcardPath;

    if (!payloadRef) {
      reply.status(400).send({
        error: 'NotFound',
        message: 'Payload reference required',
      });
      return;
    }

    if (!(await authorizePayloadRef(request, reply, { payloadRef, action: 'delete' }))) {
      return;
    }

    const payloadStore = fastify.appContext.payloadStore;

    if (!payloadStore) {
      reply.status(404).send({
        error: 'NotFound',
        message: 'Payload store not configured',
      });
      return;
    }

    await payloadStore.delete(payloadRef);
    reply.status(204).send(null);
  };

  const deletePayloadSchema = {
    tags: ['Payloads'],
    summary: 'Delete payload',
    description: 'Delete a payload by reference. This is an admin operation.',
    querystring: z.object({
      /** Payload reference (alternative to path) */
      ref: z.string().optional(),
    }),
    response: {
      204: z.null(),
      404: z.object({
        error: z.literal('NotFound'),
        message: z.string(),
      }),
    },
  };

  // Base route for query param access
  app.delete(
    '/',
    { config: { authz: { resource: 'session', action: 'delete' } }, schema: deletePayloadSchema },
    deletePayloadHandler,
  );

  // Wildcard route for path access
  app.delete(
    '/*',
    { config: { authz: { resource: 'session', action: 'delete' } }, schema: deletePayloadSchema },
    deletePayloadHandler,
  );
};
