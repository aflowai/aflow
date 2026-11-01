/**
 * The Coach's pending anomaly reports, as the Helmsman's attention block
 * counts and lists them: the reports under `/coach/anomalies/` that no one has
 * acknowledged.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { createTenantContext, memoryDocs, withTenantSchema } from '@aflow/database';

export interface PendingAnomalyDetail {
  id: string;
  kind: string;
  severity: string;
  summary: string;
  reportedAt: string;
}

interface AnomalyDoc {
  id?: string;
  kind?: string;
  severity?: string;
  summary?: string;
  reportedAt?: string;
  acknowledged?: boolean;
}

export async function countPendingAnomalies(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
): Promise<number> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({ inlineContent: memoryDocs.inlineContent })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`${memoryDocs.path} LIKE '/coach/anomalies/%'`,
          isNull(memoryDocs.deletedAt),
        ),
      ),
  );

  let pending = 0;
  for (const row of rows) {
    if (!row.inlineContent) {
      // Missing body — count conservatively as pending so the operator
      // still sees something. Better than silently dropping.
      pending += 1;
      continue;
    }
    try {
      const doc = JSON.parse(row.inlineContent) as { acknowledged?: boolean };
      if (doc.acknowledged !== true) pending += 1;
    } catch {
      // Malformed — count as pending so the operator sees it and can
      // either fix or remove it.
      pending += 1;
    }
  }

  return pending;
}

export async function loadAnomalyDetails(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  limit: number,
): Promise<PendingAnomalyDetail[]> {
  const tenantContext = createTenantContext(tenantId as TenantId);

  const rows = await withTenantSchema(db, tenantContext, async (tx) =>
    tx
      .select({
        path: memoryDocs.path,
        inlineContent: memoryDocs.inlineContent,
      })
      .from(memoryDocs)
      .where(
        and(
          eq(memoryDocs.spaceId, spaceId),
          sql`${memoryDocs.path} LIKE '/coach/anomalies/%'`,
          isNull(memoryDocs.deletedAt),
        ),
      )
      .orderBy(sql`${memoryDocs.createdAt} DESC`)
      .limit(limit),
  );

  const details: PendingAnomalyDetail[] = [];
  for (const row of rows) {
    if (!row.inlineContent) continue;
    try {
      const doc = JSON.parse(row.inlineContent) as AnomalyDoc;
      if (doc.acknowledged === true) continue;
      const pathMatch = /\/coach\/anomalies\/([^/]+)\.json$/.exec(row.path);
      const id = doc.id ?? pathMatch?.[1] ?? 'unknown';

      details.push({
        id,
        kind: doc.kind ?? 'unknown',
        severity: doc.severity ?? 'unknown',
        summary: doc.summary ?? '(no summary)',
        reportedAt: doc.reportedAt ?? new Date().toISOString(),
      });
    } catch {
      // Skip malformed docs
    }
  }

  return details;
}
