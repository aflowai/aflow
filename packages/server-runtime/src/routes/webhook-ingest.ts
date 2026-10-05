import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  tenantIdToSchemaName,
  webhookEndpoints,
  decryptCredentialAsync,
} from '@aflow/database';
import type { TenantId, ActorContext, SessionAgentTarget } from '@aflow/schemas';
import { createSessionService } from '../services/sessions.js';
import { evaluateFilter, applyMapping } from '../lib/jsonata-utils.js';
import { resolveApiBaseUrl } from '../lib/apiBaseUrl.js';
import { registerJsonBodyParser } from '../lib/jsonBodyParser.js';

// ============================================================================
// Routes
// ============================================================================

export const webhookIngestRoutes: FastifyPluginAsync = (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * The bytes as received, kept for signature verification.
   *
   * A sender signs the body it transmitted. Re-serializing our parse of it
   * produces a different string whenever key order, whitespace, escaping or
   * number formatting differ — so an HMAC computed over `JSON.stringify` is
   * not the one the sender computed, and honest deliveries fail. Encapsulated
   * to this plugin, so every other route keeps the shared parser.
   *
   * The signed material is `{timestamp}.{body}`: the delivery's freshness has
   * to be inside the signature, or it is a claim the sender never made.
   */
  const receivedBytes = new WeakMap<object, Buffer>();

  app.removeContentTypeParser('application/json');
  registerJsonBodyParser(app, {
    onRawBody: (req, raw) => {
      receivedBytes.set(req, raw);
    },
  });

  // NO app.addHook('preHandler', app.authenticate) — this is a public endpoint

  app.post(
    '/:tenantId/:endpointId',
    {
      // Third-party senders hold no Phoenix credential; the endpoint's HMAC
      // secret is the authorization.
      config: { public: true },
      schema: {
        tags: ['webhooks'],
        summary: 'Receive a webhook delivery (public, HMAC-verified)',
        params: z.object({
          tenantId: z.string().uuid(),
          endpointId: z.string().uuid(),
        }),
      },
    },
    async (request, reply) => {
      const { tenantId: tenantIdParam, endpointId } = request.params;
      const tenantId = tenantIdParam as TenantId;
      const redis = app.appContext.redis;

      // ----------------------------------------------------------------
      // 1. Counter store
      // ----------------------------------------------------------------
      // Both the per-endpoint rate limit and deduplication are security
      // controls on an unauthenticated endpoint rather than optimisations, so
      // losing their store withdraws a control and neither may proceed without
      // it. Refusing is recoverable — senders retry a 503 — where accepting
      // silently is not. Answered before the tenant read and the credential
      // decrypt below, so a caller who has proven nothing cannot spend that
      // work on a request that cannot be accepted whatever it carries.
      if (!redis) {
        return reply
          .status(503)
          .send({ error: 'Service Unavailable', message: 'Webhook ingestion unavailable' });
      }

      // ----------------------------------------------------------------
      // 2. Rate limit (per-endpoint, Redis-backed)
      // ----------------------------------------------------------------
      const rateKey = `aflow:webhook:rate:${endpointId}`;
      const count = await redis.incr(rateKey);
      if (count === 1) {
        await redis.expire(rateKey, 60);
      }
      if (count > 60) {
        return reply
          .status(429)
          .send({ error: 'Too Many Requests', message: 'Rate limit exceeded' });
      }

      // ----------------------------------------------------------------
      // 3. Load endpoint from tenant schema
      // ----------------------------------------------------------------
      const db = getDatabase();

      // Validate tenantId format by attempting schema name derivation
      try {
        tenantIdToSchemaName(tenantId);
      } catch {
        return reply.status(404).send({ error: 'Not Found', message: 'Unknown tenant' });
      }
      const tenantCtx = createTenantContext(tenantId);

      const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
        return tx
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, endpointId))
          .limit(1);
      });

      const endpoint = rows[0];
      if (endpoint?.status !== 'active') {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Webhook endpoint not found' });
      }

      // ----------------------------------------------------------------
      // 4. Get raw body for HMAC verification
      // ----------------------------------------------------------------
      const rawBody = receivedBytes.get(request);
      if (!rawBody) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: 'Body must be application/json' });
      }

      // ----------------------------------------------------------------
      // 5. Verify HMAC signature over timestamp and body
      // ----------------------------------------------------------------
      const receivedSignature = request.headers[endpoint.signatureHeader.toLowerCase()] as
        string | undefined;

      if (!receivedSignature) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Missing signature header' });
      }

      // The timestamp is half the credential, not an advisory hint: freshness
      // only means something over material the sender authenticated. A
      // timestamp outside the signature is attacker-supplied, so a captured
      // body resent under a fresh one verifies and the window check waves it
      // through — which is why a delivery arriving without one is rejected
      // rather than accepted as timestamp-less.
      const timestampStr = request.headers[endpoint.timestampHeader.toLowerCase()] as
        string | undefined;

      if (timestampStr === undefined) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: 'Missing timestamp header' });
      }

      let secret: string;
      try {
        secret = await decryptCredentialAsync(endpoint.secretEncrypted);
      } catch {
        request.log.error({ endpointId }, 'Failed to decrypt webhook secret');
        return reply
          .status(500)
          .send({ error: 'Internal Server Error', message: 'Decryption failure' });
      }

      // The timestamp exactly as sent, then the bytes exactly as received:
      // re-formatting either side computes an HMAC the sender never computed.
      const signedMaterial = Buffer.concat([Buffer.from(`${timestampStr}.`, 'utf8'), rawBody]);
      const expectedSignature = createHmac('sha256', secret).update(signedMaterial).digest('hex');

      // Constant-time comparison
      const sigBuffer = Buffer.from(receivedSignature, 'utf8');
      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
      if (
        sigBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(sigBuffer, expectedBuffer)
      ) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid signature' });
      }

      // ----------------------------------------------------------------
      // 6. Freshness
      // ----------------------------------------------------------------
      // Read only after the signature matched, so the shape of an endpoint's
      // replay policy is not something an unauthenticated prober can map out.
      // Whole seconds only, and checked as text before it is a number.
      // `Number` also accepts ` 1700000000 `, `1.7e9`, `0x654…` and fractions —
      // and a fractional stamp makes the signed material ambiguous, since
      // `"1700000000.5" + "." + "0"` is the same bytes as
      // `"1700000000" + "." + "5.0"`. One delimiter cannot separate two fields
      // when the left one may itself contain it.
      if (!/^\d{1,15}$/.test(timestampStr)) {
        return reply.status(400).send({
          error: 'INVALID_TIMESTAMP',
          message: 'Timestamp must be whole seconds since the epoch',
        });
      }
      const ts = Number(timestampStr);
      if (!Number.isFinite(ts)) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Invalid timestamp' });
      }
      // Timestamp is in seconds
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - ts) > endpoint.replayWindowSeconds) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: 'Timestamp outside replay window' });
      }

      // ----------------------------------------------------------------
      // 7. Deduplication
      // ----------------------------------------------------------------
      const suppliedDeliveryId = request.headers[endpoint.deliveryIdHeader.toLowerCase()] as
        string | undefined;

      if (!suppliedDeliveryId && endpoint.requireDeliveryId) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: 'Missing delivery ID header' });
      }

      // A delivery stamped `ts` verifies anywhere in `[ts - window, ts + window]`,
      // so the record of having seen it has to outlive that whole span or the
      // two controls leave a gap between them. Deriving the lifetime from the
      // operator's window means widening the window cannot reopen that gap.
      // Floored because Redis refuses a non-positive expiry.
      const dedupTtlSeconds = Math.max(1, endpoint.replayWindowSeconds * 2);
      const markSeen = async (identity: string): Promise<boolean> => {
        // Hashed so a sender-chosen id cannot decide the shape, length or
        // namespace of a key we store.
        const digest = createHash('sha256').update(identity).digest('hex');
        const stored = await redis.set(
          `aflow:webhook:dedup:${endpointId}:${digest}`,
          '1',
          'EX',
          dedupTtlSeconds,
          'NX',
        );
        return stored === null;
      };

      // The RUN identity, which is a different question from the dedup one and
      // has to agree with it. Dedup admits two genuine deliveries that share a
      // body under different timestamps, because they sign differently — so a
      // run identity keyed on the body alone would collapse exactly the pair
      // dedup just let through, and the second delivery would silently reuse
      // the first run's session.
      //
      // Derived from the signed material rather than the signature: it carries
      // the same (timestamp, body) uniqueness without putting MAC-derived bytes
      // into the flow input this value is copied into.
      const deliveryIdentity = createHash('sha256').update(signedMaterial).digest('hex');
      const deliveryId = suppliedDeliveryId ?? deliveryIdentity;

      // The signature covers the timestamp and the bytes, so it is the one
      // identity a sender cannot vary without the secret and the one every
      // delivery carries. It decides, and it decides ALONE.
      //
      // Alone for two reasons. Keying on anything the sender chooses puts the
      // decision in a namespace the sender picks: a captured delivery replayed
      // with the id header simply removed would land under a different key than
      // the one the original wrote, and be admitted. And checking a PAIR of
      // keys together loses deliveries — two concurrent identical copies can
      // each win one key and lose the other, so both are told `duplicate`,
      // no run starts, and the 200 tells the sender not to retry.
      if (await markSeen(`signature:${expectedSignature}`)) {
        return reply.status(200).send({ status: 'duplicate' as const });
      }

      // An honest redelivery restates its timestamp, so it signs differently
      // and passes the check above; the sender's own id is what says it is the
      // same event. Checked second and only after the signature was won, so a
      // sender-chosen value can suppress a delivery but never cost one that
      // already claimed the primary identity.
      if (suppliedDeliveryId !== undefined && (await markSeen(`id:${suppliedDeliveryId}`))) {
        return reply.status(200).send({ status: 'duplicate' as const });
      }

      // ----------------------------------------------------------------
      // 8. Filter expression (JSONata)
      // ----------------------------------------------------------------
      if (endpoint.filterExpression) {
        const matches = await evaluateFilter(endpoint.filterExpression, request.body);
        if (!matches) {
          return reply.status(200).send({ status: 'filtered' as const });
        }
      }

      // ----------------------------------------------------------------
      // 9. Input mapping (JSONata)
      // ----------------------------------------------------------------
      let flowInput: unknown = request.body;

      if (endpoint.inputMapping && typeof endpoint.inputMapping === 'object') {
        flowInput = await applyMapping(
          endpoint.inputMapping as Record<string, string>,
          request.body,
        );
      }

      // ----------------------------------------------------------------
      // 10. Enrich input with webhook context
      // ----------------------------------------------------------------
      const enrichedInput = {
        _webhook: {
          endpointId,
          endpointName: endpoint.name,
          deliveryId,
          receivedAt: new Date().toISOString(),
        },
        ...(typeof flowInput === 'object' && flowInput !== null
          ? (flowInput as Record<string, unknown>)
          : { payload: flowInput }),
      };

      // ----------------------------------------------------------------
      // 11. Start flow run
      // ----------------------------------------------------------------
      const actorContext: ActorContext = {
        userId: endpoint.creatorUserId ?? '00000000-0000-0000-0000-000000000000',
        kind: 'system' as const,
        authMethod: 'system' as const,
        tenantId,
        tenantRole: endpoint.creatorTenantRole ?? 'member',
        spaceId: endpoint.spaceId,
        spaceRole: endpoint.creatorSpaceRole ?? 'viewer',
        displayName: 'Webhook Ingestion',
        capturedAt: new Date().toISOString(),
      };

      const sessionService = createSessionService(app.appContext);
      const baseUrl = resolveApiBaseUrl();

      const idempotencyKey = `webhook:${endpointId}:${deliveryId}`;

      const envelopedInput = { input: enrichedInput };

      const endpointTarget: SessionAgentTarget | undefined =
        endpoint.targetKind === 'platform-role' && endpoint.targetSystemRole
          ? { kind: 'platform-role', systemRole: endpoint.targetSystemRole as never }
          : endpoint.targetKind === 'custom-agent' && endpoint.targetAgentId
            ? { kind: 'custom-agent', agentId: endpoint.targetAgentId as never }
            : undefined;
      if (!endpointTarget) {
        request.log.error(
          { endpointId: endpoint.id },
          'Webhook endpoint has no valid target columns',
        );
        return reply.status(500).send({ error: 'Webhook endpoint misconfigured' });
      }
      const result = await sessionService.startSession(
        {
          tenantId,
          target: endpointTarget,
          input: envelopedInput,
          idempotencyKey,
          spaceId: endpoint.spaceId,
          createdBy: endpoint.creatorUserId ?? undefined,
          trigger: 'webhook',
          activatedByPerson: false,
          actorContext,
        },
        baseUrl,
      );

      // ----------------------------------------------------------------
      // 12. Update last_received_at
      // ----------------------------------------------------------------
      withTenantSchema(db, tenantCtx, async (tx) => {
        await tx
          .update(webhookEndpoints)
          .set({ lastReceivedAt: new Date(), lastError: null })
          .where(eq(webhookEndpoints.id, endpointId));
      }).catch((err: unknown) => {
        request.log.warn({ endpointId, err }, 'Failed to update last_received_at');
      });

      return reply.status(200).send({
        status: 'accepted' as const,
        sessionId: result.sessionId,
      });
    },
  );

  return Promise.resolve();
};
