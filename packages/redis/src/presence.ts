import type { Redis } from 'ioredis';
import {
  PRESENCE_TTL_SECONDS,
  PresenceEntrySchema,
  StreamKeys,
  type PresenceActivity,
  type PresenceEntry,
  type PresenceParticipant,
} from '@aflow/schemas';

function entryField(userId: string, tabId: string): string {
  return `${userId}:${tabId}`;
}

/**
 * Record that someone is here, and say so on the channel.
 *
 * Entries carry their own timestamp and the whole key carries a TTL, so a
 * browser that closes without saying goodbye ages out rather than haunting
 * the roster. The key's TTL is refreshed on every heartbeat, which is also
 * what keeps a busy room's presence alive.
 */
export async function markPresent(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  entry: Omit<PresenceEntry, 'at'> & { at?: number },
): Promise<void> {
  const key = StreamKeys.sessionPresenceKey(tenantId, sessionId);
  const full: PresenceEntry = { ...entry, at: entry.at ?? Date.now() };

  await redis.hset(key, entryField(full.userId, full.tabId), JSON.stringify(full));
  await redis.expire(key, PRESENCE_TTL_SECONDS);
  await publishPresenceChanged(redis, tenantId, sessionId);
}

export async function markAway(
  redis: Redis,
  tenantId: string,
  sessionId: string,
  who: { userId: string; tabId: string },
): Promise<void> {
  const key = StreamKeys.sessionPresenceKey(tenantId, sessionId);
  await redis.hdel(key, entryField(who.userId, who.tabId));
  await publishPresenceChanged(redis, tenantId, sessionId);
}

/**
 * The roster, folded from tabs to people.
 *
 * Expired entries are filtered on read and swept opportunistically: a Redis
 * hash has no per-field TTL, so the key's expiry alone would keep a departed
 * tab visible for as long as anyone else in the room keeps refreshing it.
 */
export async function readPresence(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<PresenceParticipant[]> {
  const key = StreamKeys.sessionPresenceKey(tenantId, sessionId);
  const raw = await redis.hgetall(key);
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;

  const live: PresenceEntry[] = [];
  const stale: string[] = [];
  for (const [field, value] of Object.entries(raw)) {
    let parsed: PresenceEntry | null = null;
    try {
      const candidate = PresenceEntrySchema.safeParse(JSON.parse(value));
      if (candidate.success) parsed = candidate.data;
    } catch {
      /* unreadable entry — treat as stale */
    }
    if (!parsed || parsed.at < cutoff) {
      stale.push(field);
      continue;
    }
    live.push(parsed);
  }
  if (stale.length > 0) await redis.hdel(key, ...stale);

  const byUser = new Map<string, PresenceParticipant>();
  for (const entry of live) {
    const existing = byUser.get(entry.userId);
    if (!existing || entry.at > existing.at) {
      byUser.set(entry.userId, {
        userId: entry.userId,
        activity: mergeActivity(existing?.activity, entry.activity),
        at: entry.at,
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
        ...(entry.driving || existing?.driving ? { driving: true } : {}),
      });
    } else if (entry.activity === 'typing' || entry.driving) {
      byUser.set(entry.userId, {
        ...existing,
        activity: mergeActivity(existing.activity, entry.activity),
        ...(entry.driving ? { driving: true } : {}),
      });
    }
  }

  return [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}

/** Typing in any tab means typing, however idle the others are. */
function mergeActivity(a: PresenceActivity | undefined, b: PresenceActivity): PresenceActivity {
  return a === 'typing' || b === 'typing' ? 'typing' : 'viewing';
}

async function publishPresenceChanged(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  const channel = StreamKeys.sessionPresenceChannel(tenantId, sessionId);
  // The payload is only a nudge: every instance re-reads the roster, so two
  // changes racing converge on the same answer instead of on whichever
  // message arrived last.
  await redis.publish(channel, JSON.stringify({ sessionId, ts: Date.now() })).catch(() => {
    /* a missed nudge costs a late roster, never a wrong one */
  });
}

/**
 * Watch for roster changes on one session. The connection must be a
 * dedicated subscriber — once in subscribe mode it cannot issue commands.
 */
export function subscribeToPresence(
  subscriberRedis: Redis,
  tenantId: string,
  sessionId: string,
  onChanged: () => void,
): () => Promise<void> {
  const channel = StreamKeys.sessionPresenceChannel(tenantId, sessionId);
  const handler = (received: string): void => {
    if (received === channel) onChanged();
  };
  void subscriberRedis.subscribe(channel).catch(() => {
    /* the topic handler reports subscription failure separately */
  });
  subscriberRedis.on('message', handler);
  return async () => {
    subscriberRedis.off('message', handler);
    await subscriberRedis.unsubscribe(channel).catch(() => {
      /* swallowed */
    });
  };
}

/**
 * The roster for several rooms at once.
 *
 * The Workbench lists a space's conversations together, and "who is in this
 * one" is the question that makes a shared list navigable. The reads are
 * issued concurrently rather than one row at a time; rooms nobody is in are
 * omitted, so a quiet space costs almost nothing to report.
 */
export async function readPresenceForSessions(
  redis: Redis,
  tenantId: string,
  sessionIds: string[],
): Promise<Record<string, PresenceParticipant[]>> {
  const rosters: Record<string, PresenceParticipant[]> = {};
  if (sessionIds.length === 0) return rosters;

  await Promise.all(
    sessionIds.map(async (sessionId) => {
      const participants = await readPresence(redis, tenantId, sessionId);
      if (participants.length > 0) rosters[sessionId] = participants;
    }),
  );

  return rosters;
}
