import type { Redis } from 'ioredis';
import {
  StreamKeys,
  McpElicitationRequestSchema,
  type McpElicitationRequest,
} from '@aflow/schemas';

export interface StoredMcpElicitationRequest {
  request: McpElicitationRequest;
  tenantId: string;
  /**
   * Session that owns the in-flight `mcp.tool.call`. Used by the
   * response REST route to verify the URL's `:sessionId` matches the
   * elicitation's actual home — otherwise a user with write access to
   * S1 within the same tenant could respond to an elicitation parked
   * on S2 and (worse) the resolved event would land on S1's stream
   * leaving S2's UI stuck. Absent for workflow-task dispatch (no host
   * session); the response route refuses such elicitations regardless.
   */
  sessionId?: string;
  /** Step that issued the call — surfaced on the resolved event for UI symmetry. */
  stepExecutionId: string;
}

const SLACK_MS = 30 * 1000;

export interface StoreMcpElicitationRequestOptions {
  tenantId: string;
  stepExecutionId: string;
  sessionId?: string;
}

export async function setMcpElicitationRequest(
  redis: Redis,
  request: McpElicitationRequest,
  opts: StoreMcpElicitationRequestOptions,
  ttlMs: number,
): Promise<void> {
  const key = StreamKeys.mcpElicitationRequestKey(opts.tenantId, request.elicitationId);
  const ttlSec = Math.max(1, Math.ceil((ttlMs + SLACK_MS) / 1000));
  const payload: StoredMcpElicitationRequest = {
    request,
    tenantId: opts.tenantId,
    stepExecutionId: opts.stepExecutionId,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  };

  await redis.set(key, JSON.stringify(payload), 'EX', ttlSec);
}

export async function getMcpElicitationRequest(
  redis: Redis,
  tenantId: string,
  elicitationId: string,
): Promise<StoredMcpElicitationRequest | null> {
  const key = StreamKeys.mcpElicitationRequestKey(tenantId, elicitationId);
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      request?: unknown;
      tenantId?: unknown;
      sessionId?: unknown;
      stepExecutionId?: unknown;
    };
    if (typeof parsed.tenantId !== 'string') return null;
    if (typeof parsed.stepExecutionId !== 'string') return null;
    const reqCheck = McpElicitationRequestSchema.safeParse(parsed.request);
    if (!reqCheck.success) return null;
    return {
      request: reqCheck.data,
      tenantId: parsed.tenantId,
      stepExecutionId: parsed.stepExecutionId,
      ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Drop the captured request — called after a successful response or by
 * the reconciler when transitioning to executor_lost / timeout. Idempotent
 * (DEL on missing key is a no-op).
 */
export async function deleteMcpElicitationRequest(
  redis: Redis,
  tenantId: string,
  elicitationId: string,
): Promise<void> {
  const key = StreamKeys.mcpElicitationRequestKey(tenantId, elicitationId);
  await redis.del(key);
}
