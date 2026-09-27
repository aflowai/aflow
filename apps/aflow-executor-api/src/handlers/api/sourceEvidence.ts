import { createHash, randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createMemoryDocRepository,
  createMemoryDirRepository,
  createTenantContext,
} from '@aflow/database';
import { SIMULATED_PROVENANCE, SIMULATED_PROVENANCE_TAG, type TenantId } from '@aflow/schemas';

const EVIDENCE_DIR = '/coach/evidence/api-calls';

export interface WriteSourceEvidenceParams {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  runId: string;
  apiId: string;
  bindingId: string;
  endpointId: string;
  responseStatus: number;
  responseHash?: string;
  /** `simulated` when the call this evidences was answered by a simulation. */
  provenance: 'live' | 'simulated';
}

export interface WriteSourceEvidenceResult {
  callId: string;
  /** Best-effort: returns null when evidence write failed (logged separately). */
  ok: boolean;
}

/**
 * Hash an arbitrary response body for the evidence record. Bounded — only
 * hashes the first 1MB to keep large responses cheap to evidence.
 */
export function hashResponseBody(data: unknown): string | undefined {
  try {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data ?? null);
    if (serialized.length === 0) return undefined;
    const truncated = serialized.length > 1_000_000 ? serialized.slice(0, 1_000_000) : serialized;
    return createHash('sha256').update(truncated).digest('hex').slice(0, 64);
  } catch {
    return undefined;
  }
}

/**
 * Write a `SourceEvidence` doc and return the `callId`. Caller surfaces
 * the callId to the runner via `result.sourceEvidenceRef` so the agent
 * can pass it through into provenance blocks.
 *
 * If the database is unavailable (executor running without DB), this
 * returns `{ ok: false }` and the caller skips the evidence ref. Real
 * deployments always have DB access; the fallback is for self-hosted dev
 * mode.
 */
export async function writeSourceEvidence(
  params: WriteSourceEvidenceParams,
): Promise<WriteSourceEvidenceResult> {
  const callId = randomUUID();
  const docPath = `${EVIDENCE_DIR}/${callId}.json`;
  const evidence = {
    callId,
    sourceId: params.apiId,
    bindingId: params.bindingId,
    endpointOrTool: params.endpointId,
    executedAtMs: Date.now(),
    ...(params.responseHash ? { responseHash: params.responseHash } : {}),
    issuedBy: 'platform:api.http.call' as const,
    runId: params.runId,
    responseStatus: params.responseStatus,
    provenance: params.provenance,
  };
  const simulated = params.provenance === SIMULATED_PROVENANCE;

  try {
    const tenantCtx = createTenantContext(params.tenantId as TenantId);
    const docRepo = createMemoryDocRepository(params.db, tenantCtx);
    const dirRepo = createMemoryDirRepository(params.db, tenantCtx);
    await dirRepo.ensureParentDirs(docPath, { spaceId: params.spaceId });
    const content = JSON.stringify(evidence);
    await docRepo.put({
      path: docPath,
      writeMode: 'create',
      docType: 'json',
      mimeType: 'application/json',
      inlineContent: content,
      payloadRef: null,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      contentHash: '',
      preview: content.substring(0, 200),
      tags: ['coach', 'evidence', 'api-call', ...(simulated ? [SIMULATED_PROVENANCE_TAG] : [])],
      summary: `api.http.call evidence${simulated ? ' (simulated)' : ''}: ${params.apiId}/${params.endpointId}`,
      semanticType: 'source_evidence',
      indexing: 'disabled',
      scope: { spaceId: params.spaceId },
      provenance: { actor: 'system:api.http.call' },
    });
    return { callId, ok: true };
  } catch {
    return { callId, ok: false };
  }
}
