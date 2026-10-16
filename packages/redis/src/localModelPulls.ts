/**
 * Downloads to a model runtime on the operator's machine, one per runtime and
 * tag (Plan 323 D10).
 *
 * The record is the pull's claim as well as its progress. Whoever starts a
 * pull holds it with a lifetime its progress renews, so a second request finds
 * it and joins rather than starting another, and a server that dies mid-pull
 * leaves nothing behind once the lifetime runs out — the runtime itself kept
 * what it downloaded, and the next pull resumes from there. A pull that ended
 * badly keeps its record a while longer, so the operator reads why.
 */
import type { Redis } from 'ioredis';
import type { LocalModelPull } from '@aflow/schemas';

const KEY_PREFIX = 'aflow:local-pull';
/**
 * Progress arrives several times a second while bytes flow, but the runtime
 * says nothing while it checks a large layer's digest, which takes minutes on
 * a slow disk. Ten minutes of silence is a pull nobody holds.
 */
export const LOCAL_PULL_LEASE_MS = 600_000;
/** How long a stopped or failed pull stays readable. */
export const LOCAL_PULL_ENDED_TTL_MS = 600_000;

function pullKey(runtimeId: string, tag: string): string {
  return `${KEY_PREFIX}:{${runtimeId}}:${tag}`;
}

function parse(fields: Record<string, string>): LocalModelPull | null {
  const status = fields['status'];
  if (status !== 'downloading' && status !== 'interrupted' && status !== 'failed') return null;
  const total = fields['totalBytes'];
  return {
    status,
    completedBytes: Number(fields['completedBytes'] ?? 0),
    totalBytes: total ? Number(total) : null,
    detail: fields['detail'] || null,
    error: fields['error'] || null,
    startedAt: fields['startedAt'] ?? new Date(0).toISOString(),
  };
}

/**
 * KEYS: the pull. ARGV: startedAt, lease ms.
 * Claims the pull unless one is downloading; a stopped or failed one is replaced.
 */
const CLAIM = `
if redis.call('HGET', KEYS[1], 'status') == 'downloading' then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'status', 'downloading', 'completedBytes', '0', 'startedAt', ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

/** Starts a pull's record, or answers false when one is already downloading — the caller joins it. */
export async function claimLocalPull(
  redis: Redis,
  runtimeId: string,
  tag: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await redis.eval(
    CLAIM,
    1,
    pullKey(runtimeId, tag),
    now.toISOString(),
    String(LOCAL_PULL_LEASE_MS),
  );
  return claimed === 1;
}

/**
 * Records progress and renews the claim in one round trip, answering whether
 * the operator asked to stop it — read here so a cancel reaches whichever
 * server holds the pull.
 */
export async function recordLocalPullProgress(
  redis: Redis,
  runtimeId: string,
  tag: string,
  progress: { completedBytes: number; totalBytes: number | null; detail: string },
): Promise<{ cancelled: boolean }> {
  const key = pullKey(runtimeId, tag);
  const results = await redis
    .multi()
    // The status rides every write, so a record that lapsed under a pull
    // still running is rebuilt whole rather than as one nothing can read.
    .hset(key, {
      status: 'downloading',
      completedBytes: String(progress.completedBytes),
      totalBytes: progress.totalBytes === null ? '' : String(progress.totalBytes),
      detail: progress.detail,
    })
    .pexpire(key, LOCAL_PULL_LEASE_MS)
    .hget(key, 'cancel')
    .exec();
  return { cancelled: results?.[2]?.[1] === '1' };
}

export async function requestLocalPullCancel(
  redis: Redis,
  runtimeId: string,
  tag: string,
): Promise<boolean> {
  const key = pullKey(runtimeId, tag);
  if ((await redis.hget(key, 'status')) !== 'downloading') return false;
  await redis.hset(key, 'cancel', '1');
  return true;
}

/** A pull that installed its model leaves no record: the runtime lists the model instead. */
export async function endLocalPull(
  redis: Redis,
  runtimeId: string,
  tag: string,
  outcome: { status: 'installed' } | { status: 'interrupted' | 'failed'; error: string | null },
): Promise<void> {
  const key = pullKey(runtimeId, tag);
  if (outcome.status === 'installed') {
    await redis.del(key);
    return;
  }
  await redis
    .multi()
    .hset(key, { status: outcome.status, error: outcome.error ?? '', cancel: '' })
    .pexpire(key, LOCAL_PULL_ENDED_TTL_MS)
    .exec();
}

export async function readLocalPulls(
  redis: Redis,
  runtimeId: string,
  tags: readonly string[],
): Promise<Map<string, LocalModelPull>> {
  const pulls = new Map<string, LocalModelPull>();
  if (tags.length === 0) return pulls;
  const pipeline = redis.pipeline();
  for (const tag of tags) pipeline.hgetall(pullKey(runtimeId, tag));
  const results = (await pipeline.exec()) ?? [];
  tags.forEach((tag, i) => {
    const fields = results[i]?.[1] as Record<string, string> | undefined;
    const pull = fields ? parse(fields) : null;
    if (pull) pulls.set(tag, pull);
  });
  return pulls;
}
