/**
 * Per-request correlation ids for providers that require one on every call
 * and treat it as a replay key on their write routes.
 */
import { createHash } from 'node:crypto';
import type { ExecutorContext } from '@aflow/executor-runtime';

/** Arbitrary fixed namespace. Changing it re-mints every id, so it never moves. */
const REQUEST_ID_NAMESPACE = 'b6c8f4a2-1e5d-4c3b-9f7a-2d8e6b1c4a90';

/**
 * RFC 4122 §4.3 name-based UUIDv5 — SHA-1 over the namespace bytes followed by
 * the name, with the version and variant nibbles overwritten. Hand-rolled
 * because `uuid` is a resolutions pin here, not a declared dependency.
 */
export function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, Buffer.from(name, 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A request id that is stable across retries of one logical call and distinct
 * across every other call.
 *
 * Both halves of the seed are load-bearing (Plan 290 §1.2a, §1.2b):
 *
 * `runId` cannot be dropped. On the workflow path `logicalExecutionId` is
 * `task:<taskId>`, and that taskId is the author-supplied slug from the
 * workflow definition — it repeats across every run of the same workflow, so
 * seeding on it alone would send one id for every call that task ever makes.
 *
 * `attempt` cannot be added. Reusing the id across attempts is the entire
 * point: a provider that deduplicates on it will not double-execute a write
 * that timed out after reaching them. `mediaRequestIdentity` does include
 * attempt, and is not a template to copy here — it builds an identity record
 * where each attempt is a distinct row, not a replay key.
 */
export function mintRequestId(ctx: ExecutorContext): string {
  return uuidV5(`${ctx.runId}:${ctx.logicalExecutionId}`, REQUEST_ID_NAMESPACE);
}
