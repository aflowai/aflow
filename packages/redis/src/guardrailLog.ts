import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

const GUARDRAIL_LOG_TTL_SECONDS = 86400; // 24h, same as run_events
const GUARDRAIL_LOG_MAXLEN = 5000;

/**
 * Serialize a record into flat key-value pairs for Redis XADD.
 */
function serializeRecord(record: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (value === null) {
      result.push(key, 'null');
    } else if (typeof value === 'object') {
      result.push(key, JSON.stringify(value));
    } else if (typeof value === 'boolean') {
      result.push(key, value ? 'true' : 'false');
    } else {
      result.push(
        key,
        typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : String(value as string | number | bigint | symbol | null | undefined),
      );
    }
  }
  return result;
}

/**
 * Deserialize flat Redis stream fields back into a record.
 */
function deserializeRecord(fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i]!;
    const raw = fields[i + 1]!;
    if (raw === 'null') {
      result[key] = null;
    } else if (raw === 'true') {
      result[key] = true;
    } else if (raw === 'false') {
      result[key] = false;
    } else {
      // Try JSON parse for objects/arrays
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object') {
          result[key] = parsed;
        } else {
          result[key] = raw;
        }
      } catch {
        // Not JSON — keep as string (or parse as number)
        const num = Number(raw);
        result[key] = !Number.isNaN(num) && raw !== '' ? num : raw;
      }
    }
  }
  return result;
}

/**
 * Append a guardrail check record to the per-run guardrail log stream.
 * Fire-and-forget — callers should not await in the hot path.
 */
export async function appendGuardrailCheck(
  redis: Redis,
  tenantId: string,
  runId: string,
  record: Record<string, unknown>,
): Promise<string> {
  const streamKey = StreamKeys.guardrailLogStream(tenantId, runId);
  const fields = serializeRecord(record);
  const messageId = await redis.xadd(
    streamKey,
    'MAXLEN',
    '~',
    String(GUARDRAIL_LOG_MAXLEN),
    '*',
    ...fields,
  );
  await redis.expire(streamKey, GUARDRAIL_LOG_TTL_SECONDS);
  return messageId ?? '';
}

/**
 * Read guardrail check records from the per-run log stream.
 */
export async function readGuardrailLog(
  redis: Redis,
  tenantId: string,
  runId: string,
  count = 1000,
): Promise<Array<Record<string, unknown>>> {
  const streamKey = StreamKeys.guardrailLogStream(tenantId, runId);
  const entries = await redis.xrange(streamKey, '-', '+', 'COUNT', count);
  return entries.map(([, fields]) => deserializeRecord(fields));
}
