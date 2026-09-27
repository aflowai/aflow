import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, createMemoryDocRepository } from '@aflow/database';
import type { AnomalyReport } from '@aflow/schemas';
import { AnomalyReportSchema } from '@aflow/schemas';
import { appendEntityEvent } from '@aflow/redis';

const AnomalySummarySchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.string(),
  summary: z.string(),
  reportedAt: z.string(),
  acknowledged: z.boolean(),
  acknowledgedBy: z.string().optional(),
  acknowledgedAt: z.string().optional(),
  coachSessionId: z.string().uuid().optional(),
  relatedStagedChangeId: z.string().optional(),
});

const ANOMALY_PATH_PREFIX = '/coach/anomalies/';

function anomalyPath(anomalyId: string): string {
  return `${ANOMALY_PATH_PREFIX}${anomalyId}.json`;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin
export const anomaliesRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  const db = fastify.appContext.db as PostgresJsDatabase;

  // -------------------------------------------------------------------------
  // GET /v1/spaces/:spaceId/anomalies
  // -------------------------------------------------------------------------
  //
  // Default `onlyPending=true` returns docs with `acknowledged !== true`.
  // Pass `onlyPending=false` to see acknowledged history too.
  app.get(
    '/:spaceId/anomalies',
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
        summary: 'List Coach anomalies for a space',
        params: z.object({ spaceId: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
          onlyPending: z
            .union([z.boolean(), z.enum(['true', 'false'])])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .default(true),
        }),
        response: {
          200: z.object({
            anomalies: z.array(AnomalySummarySchema),
            total: z.number().int().min(0),
            onlyPending: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const tenant = await request.requireTenant();
      const { spaceId } = request.params;
      const { limit, offset, onlyPending } = request.query;

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(db, tenantCtx);

      // List docs under the prefix. Fetch a bit more than `limit` to allow
      // filtering by acknowledged without pagination drift.
      const docs = await repo.list({
        pathPrefix: ANOMALY_PATH_PREFIX,
        scope: { spaceId },
        filters: { docType: ['json'] },
        // Cap to a reasonable scan size — anomalies grow slowly; if a space
        // has thousands, the operator has bigger problems.
        limit: 500,
      });

      const parsed: AnomalyReport[] = [];
      for (const d of docs) {
        if (!d.path.endsWith('.json')) continue;
        const full = await repo.getById(d.id, spaceId);
        if (!full?.inlineContent) continue;
        try {
          const ar = AnomalyReportSchema.parse(JSON.parse(full.inlineContent));
          if (onlyPending && ar.acknowledged) continue;
          parsed.push(ar);
        } catch {
          // Skip malformed
        }
      }

      // Most recent first.
      parsed.sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));

      const total = parsed.length;
      const page = parsed.slice(offset, offset + limit);

      return {
        anomalies: page.map((ar) => ({
          id: ar.id,
          kind: ar.kind,
          severity: ar.severity,
          summary: ar.summary,
          reportedAt: ar.reportedAt,
          acknowledged: ar.acknowledged,
          ...(ar.acknowledgedBy !== undefined ? { acknowledgedBy: ar.acknowledgedBy } : {}),
          ...(ar.acknowledgedAt !== undefined ? { acknowledgedAt: ar.acknowledgedAt } : {}),
          coachSessionId: ar.coachSessionId,
          ...(ar.relatedStagedChangeId !== undefined
            ? { relatedStagedChangeId: ar.relatedStagedChangeId }
            : {}),
        })),
        total,
        onlyPending,
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/spaces/:spaceId/anomalies/:anomalyId/acknowledge
  // -------------------------------------------------------------------------
  //
  // Marks the anomaly doc `acknowledged: true` + stamps `acknowledgedBy` /
  // `acknowledgedAt`. The aggregator's `pendingAnomalies` count decrements
  // on the next refresh. Idempotent: acknowledging an already-acknowledged
  // anomaly returns 200 with `alreadyAcknowledged: true`.
  app.post(
    '/:spaceId/anomalies/:anomalyId/acknowledge',
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
        summary: 'Acknowledge a Coach anomaly',
        params: z.object({
          spaceId: z.string().uuid(),
          anomalyId: z.string().min(1).max(200),
        }),
        response: {
          200: z.object({
            anomalyId: z.string(),
            acknowledged: z.literal(true),
            alreadyAcknowledged: z.boolean(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const tenant = await request.requireTenant();
      const { spaceId, anomalyId } = request.params;
      const operatorUserId = request.authUser?.userId ?? 'operator';

      const tenantCtx = createTenantContext(tenant.tenantId);
      const repo = createMemoryDocRepository(db, tenantCtx);

      const path = anomalyPath(anomalyId);
      const doc = await repo.getByPath(path, spaceId);
      if (!doc?.inlineContent) {
        return reply.status(404).send({ error: 'Anomaly not found' });
      }

      let ar: AnomalyReport;
      try {
        ar = AnomalyReportSchema.parse(JSON.parse(doc.inlineContent));
      } catch {
        return reply.status(404).send({ error: 'Anomaly is malformed' });
      }

      if (ar.acknowledged) {
        return { anomalyId: ar.id, acknowledged: true as const, alreadyAcknowledged: true };
      }

      const updated: AnomalyReport = {
        ...ar,
        acknowledged: true,
        acknowledgedBy: operatorUserId,
        acknowledgedAt: new Date().toISOString(),
      };
      const content = JSON.stringify(updated, null, 2);

      await repo.put({
        path,
        writeMode: 'upsert',
        docType: 'json',
        mimeType: 'application/json',
        inlineContent: content,
        payloadRef: null,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        contentHash: '',
        preview: content.substring(0, 200),
        tags: ['coach', 'anomaly'],
        summary: updated.summary,
        semanticType: 'anomaly_report',
        indexing: 'disabled',
        scope: { spaceId },
        provenance: { actor: 'system:operator-acknowledge' },
      });

      const redis = fastify.appContext.redis;
      if (redis) {
        try {
          await appendEntityEvent(redis, {
            tenantId: tenant.tenantId,
            spaceId,
            event: {
              eventId: randomUUID(),
              eventType: 'entity.coach.anomaly_acknowledged',
              spaceId,
              tenantId: tenant.tenantId,
              timestamp: Date.now(),
              operatingMode: 'supervisory',
              payload: {
                anomalyId: ar.id,
                kind: ar.kind,
                severity: ar.severity,
                acknowledgedBy: operatorUserId,
              },
              summary: `Anomaly acknowledged: ${ar.summary}`,
            },
          });
        } catch {
          // Best-effort
        }
      }

      return { anomalyId: ar.id, acknowledged: true as const, alreadyAcknowledged: false };
    },
  );
};
