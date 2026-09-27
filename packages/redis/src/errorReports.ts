import type { Redis } from 'ioredis';
import { StreamKeys, type ErrorReport } from '@aflow/schemas';

/**
 * Append an error report to the Redis error reports stream.
 * Called by the projection worker after writing to Postgres.
 *
 * The stream message stores the report as a JSON payload under the `data` field.
 * Consumer groups can be added later for dashboard consumption.
 */
export async function appendErrorReport(redis: Redis, report: ErrorReport): Promise<string> {
  const streamKey = StreamKeys.errorReportsStream;
  const id = await redis.xadd(
    streamKey,
    '*',
    'data',
    JSON.stringify(report),
    'tenantId',
    report.tenantId,
    'runId',
    report.runId,
    'classification',
    report.classification,
    'severity',
    report.severity,
    'fingerprint',
    report.fingerprint,
  );
  // xadd returns null only if a maxlen/minid filter drops the entry, which we don't use
  return id ?? '';
}
