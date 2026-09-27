import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { MAX_INLINE_PAYLOAD_BYTES } from '@aflow/schemas';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import { getOrchestratorLogger } from './orchestratorLogger.js';

/**
 * Encode a task/run input as a payload ref, honouring the inline-size
 * discipline: at or below `MAX_INLINE_PAYLOAD_BYTES` the value is inlined
 * (`inline:<base64>`); above it the value is spilled to the payload store so
 * oversized inputs never land on task rows, Redis streams, or hot state.
 * Spilling needs a store and the run identity to address the object under, so
 * an oversized value is refused when either is absent: a ref past the cap is
 * not one the store resolves, so inlining it loses the value at the read
 * instead of here.
 */
export async function encodeTaskInput(
  payloadStore: PayloadStore | undefined,
  meta: { tenantId: string | undefined; runId: string | undefined; label: string },
  value: unknown,
): Promise<string> {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, 'utf-8');
  if (bytes <= MAX_INLINE_PAYLOAD_BYTES) {
    return `inline:${Buffer.from(json).toString('base64')}`;
  }
  const { tenantId, runId } = meta;
  if (!payloadStore || !tenantId || !runId) {
    // Inlining it anyway used to trade a fat ref for a lost input. It no longer
    // buys anything: a ref over the cap is not one the store resolves, so the
    // value would be as lost as if it had been dropped, and lost at the far end
    // where nothing recalls which encode produced it.
    const missing = !payloadStore ? 'no payloadStore' : 'no tenant/run identity';
    throw new Error(
      `${meta.label}: ${String(bytes)} bytes exceeds the inline cap (${String(MAX_INLINE_PAYLOAD_BYTES)}) ` +
        `and there is ${missing} to carry it`,
    );
  }
  getOrchestratorLogger().warn(
    `[encodeTaskInput] ${meta.label}: ${String(bytes)} bytes exceeds the inline threshold (${String(MAX_INLINE_PAYLOAD_BYTES)}) — spilling to payload store`,
  );
  // Fresh path identity per encode: the returned ref is what rows and jobs
  // carry, and a unique object per attempt prevents cross-attempt overwrites.
  return payloadStore.store({
    tenantId: tenantId as TenantId,
    runId: runId as SessionId,
    stepExecutionId: randomUUID() as StepExecutionId,
    attempt: 1,
    kind: 'input',
    data: value,
  });
}
