/**
 * One-time rollout seed for the elicitation lease candidate index.
 *
 * The index is armed by lease grant and by the holder's heartbeat, so every
 * lease with a live holder enters it within one heartbeat period without help.
 * The population that never does is the one the reconciler exists for: leases
 * whose holder is already gone. The deploy that installs the index is also the
 * deploy that restarts the MCP executors, so that population is at its largest
 * exactly when nothing is left to arm it — an unseeded index would let one
 * rollout strand every open elicitation card behind a holder that will never
 * heartbeat again.
 *
 * Guarded by a fleet-wide marker rather than run per boot: this walks the
 * keyspace once, in the rollout, and then never again. It is the "bounded
 * one-time rollout" the background-work contract allows in place of the
 * recurring scan it replaces, and it is deletable once the index is live
 * everywhere.
 */
import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';
import { mcpElicitationCandidateMember } from './mcpElicitationLeaseCandidates.js';

const SEEDED_MARKER_KEY = 'aflow:mcp:elicitation:lease:candidates:seeded';
const SEEDING_LOCK_KEY = 'aflow:mcp:elicitation:lease:candidates:seeding';
const SEEDING_LOCK_TTL_MS = 60_000;

export interface McpElicitationLeaseSeedResult {
  /** False when another instance had already seeded or is seeding right now. */
  ran: boolean;
  scanned: number;
  armed: number;
}

export async function seedMcpElicitationLeaseCandidatesOnce(
  redis: Redis,
): Promise<McpElicitationLeaseSeedResult> {
  if ((await redis.exists(SEEDED_MARKER_KEY)) === 1) return { ran: false, scanned: 0, armed: 0 };
  const lock = await redis.set(SEEDING_LOCK_KEY, '1', 'PX', SEEDING_LOCK_TTL_MS, 'NX');
  if (lock === null) return { ran: false, scanned: 0, armed: 0 };

  const prefix = StreamKeys.mcpElicitationLeaseKey('');
  const keys: string[] = [];
  const stream = redis.scanStream({ match: `${prefix}*`, count: 200 });
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (batch: string[]) => {
      for (const key of batch) if (key.startsWith(prefix)) keys.push(key);
    });
    stream.on('end', () => {
      resolve();
    });
    stream.on('error', (err: Error) => {
      reject(err);
    });
  });

  let armed = 0;
  // Due immediately: a seeded candidate may be examined earlier than it needs
  // to be, never later, and the first examination is the one that finds the
  // holders this rollout just killed.
  const dueNow = String(Date.now());
  for (const key of keys) {
    const holder = await redis.hget(key, 'executorInstanceId');
    if (holder === null || holder === '') continue;
    await redis.zadd(
      StreamKeys.mcpElicitationLeaseCandidatesKey,
      dueNow,
      mcpElicitationCandidateMember(holder, key.slice(prefix.length)),
    );
    armed++;
  }

  await redis.set(SEEDED_MARKER_KEY, '1');
  await redis.del(SEEDING_LOCK_KEY);
  return { ran: true, scanned: keys.length, armed };
}
