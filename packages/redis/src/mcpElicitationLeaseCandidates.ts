/**
 * Held MCP elicitation leases, as one sorted set scored by the next instant the
 * reconciler needs to look at one.
 *
 * The reconciler's subject is holder death, not lease expiry. A healthy lease
 * sits a full TTL — fifteen minutes by default — from its own deadline while its
 * holder can die at any moment, so a set scored by `leaseExpiresAt` would find
 * the right leases fifteen minutes after a human stopped being able to answer
 * the form in front of them. The score is a re-check time instead: it decides
 * when the reconciler looks, never what it finds, and the executor heartbeat
 * remains the only authority on whether a holder is gone.
 *
 * The member carries the holder's instance id so a cycle can resolve many
 * candidates to a handful of liveness reads. Without it every due candidate
 * costs a hash read to learn who holds it, which is the per-lease cost the
 * keyspace walk had; with it a hash is read only for a holder already known to
 * be dead.
 *
 * Reading is non-destructive. A candidate whose holder is alive is pushed
 * forward, one whose lease has vanished is dropped against the score it was
 * seen at, and one that is reaped is removed by the write that reaps it.
 */
import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

/** How often the reconciler re-examines a lease whose holder is still alive. */
export const MCP_ELICITATION_RECHECK_MS = 30_000;

export interface McpElicitationLeaseCandidate {
  executorInstanceId: string;
  elicitationId: string;
  /** The score the candidate was seen at. Settling compares against it. */
  dueAtMs: number;
}

/**
 * `instanceId|elicitationId`. The instance id is platform-generated and the
 * elicitation id comes from the upstream MCP server, so the untrusted half goes
 * last and the split takes the first separator.
 */
export function mcpElicitationCandidateMember(
  executorInstanceId: string,
  elicitationId: string,
): string {
  return `${executorInstanceId}|${elicitationId}`;
}

export function parseMcpElicitationCandidateMember(
  member: string,
): { executorInstanceId: string; elicitationId: string } | null {
  const idx = member.indexOf('|');
  if (idx <= 0 || idx === member.length - 1) return null;
  return { executorInstanceId: member.slice(0, idx), elicitationId: member.slice(idx + 1) };
}

/**
 * When to look at a lease that was just granted, refreshed, or found healthy.
 *
 * The re-check interval, or the lease's own deadline when the configured TTL is
 * shorter than one interval — a second-scale TTL would otherwise outlive every
 * look the reconciler took at it.
 */
export function mcpElicitationNextCheckAtMs(nowMs: number, leaseTtlMs: number): number {
  return nowMs + Math.min(MCP_ELICITATION_RECHECK_MS, Math.max(1, leaseTtlMs));
}

/** Candidates whose re-check time has passed, oldest first. */
export async function peekDueMcpElicitationLeaseCandidates(
  redis: Redis,
  limit: number,
  nowMs: number = Date.now(),
): Promise<McpElicitationLeaseCandidate[]> {
  if (limit <= 0) return [];
  const raw = await redis.zrangebyscore(
    StreamKeys.mcpElicitationLeaseCandidatesKey,
    '-inf',
    nowMs,
    'WITHSCORES',
    'LIMIT',
    0,
    limit,
  );
  const out: McpElicitationLeaseCandidate[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const parsed = parseMcpElicitationCandidateMember(String(raw[i]));
    if (parsed) out.push({ ...parsed, dueAtMs: Number(raw[i + 1]) });
  }
  return out;
}

const CAS_RESCORE_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ARGV[3], ARGV[1])
return 1
`;

/**
 * Take a due candidate for this cycle by pushing its score past the cycle's own
 * budget, but only if nobody else moved it first.
 *
 * This is the whole exclusion story for the reconciler: reaping emits an event
 * and deletes two keys, and two orchestrators that both found the same dead
 * holder would otherwise both emit. The claim leases rather than removes, so a
 * claimant that dies before reaping leaves the candidate where the next cycle
 * finds it.
 */
export async function claimMcpElicitationLeaseCandidate(
  redis: Redis,
  candidate: McpElicitationLeaseCandidate,
  leaseUntilMs: number,
): Promise<boolean> {
  const claimed = await redis.eval(
    CAS_RESCORE_LUA,
    1,
    StreamKeys.mcpElicitationLeaseCandidatesKey,
    mcpElicitationCandidateMember(candidate.executorInstanceId, candidate.elicitationId),
    String(candidate.dueAtMs),
    String(leaseUntilMs),
  );
  return Number(claimed) === 1;
}

/**
 * Push a candidate whose holder is still alive forward.
 *
 * `XX` so a release that landed between the peek and here is not undone — a
 * resurrected member names a lease that no longer exists and would be re-read
 * every cycle until something noticed.
 */
export async function refreshMcpElicitationLeaseCandidate(
  redis: Redis,
  candidate: McpElicitationLeaseCandidate,
  nowMs: number = Date.now(),
): Promise<void> {
  await redis.zadd(
    StreamKeys.mcpElicitationLeaseCandidatesKey,
    'XX',
    String(nowMs + MCP_ELICITATION_RECHECK_MS),
    mcpElicitationCandidateMember(candidate.executorInstanceId, candidate.elicitationId),
  );
}

/** Drop a candidate whose lease hash is gone — expired, or released out of band. */
export async function dropMcpElicitationLeaseCandidate(
  redis: Redis,
  candidate: McpElicitationLeaseCandidate,
): Promise<void> {
  await redis.zrem(
    StreamKeys.mcpElicitationLeaseCandidatesKey,
    mcpElicitationCandidateMember(candidate.executorInstanceId, candidate.elicitationId),
  );
}
