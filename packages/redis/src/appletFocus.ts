import type { Redis } from 'ioredis';
import {
  APPLET_FOCUS_TTL_SECONDS,
  AppletFocusSchema,
  StreamKeys,
  type AppletFocus,
} from '@aflow/schemas';

/**
 * Session-scoped applet focus — which instance the agent is operating right
 * now. One slot per session: setting focus overwrites whatever was there,
 * because a turn has exactly one current instance. The waking-action producer
 * (Plan 264 Phase 4) writes through this same slot with source
 * 'waking_action'; precedence between sources is last-write-wins by design —
 * the ordering in §4.13 governs resolution, not storage.
 */
export async function setAppletFocus(
  redis: Redis,
  tenantId: string,
  focus: AppletFocus,
): Promise<void> {
  const key = StreamKeys.sessionAppletFocusKey(tenantId, focus.sessionId);
  await redis.set(key, JSON.stringify(focus), 'EX', APPLET_FOCUS_TTL_SECONDS);
}

/** Null when unset, expired, or unreadable — a corrupt slot degrades to the sole-active fallback, never an error. */
export async function getAppletFocus(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<AppletFocus | null> {
  const key = StreamKeys.sessionAppletFocusKey(tenantId, sessionId);
  const raw = await redis.get(key);
  if (raw === null) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = AppletFocusSchema.safeParse(candidate);
  if (!parsed.success) return null;
  if (parsed.data.expiresAt !== undefined && Date.parse(parsed.data.expiresAt) <= Date.now()) {
    await redis.del(key).catch(() => {
      /* the key TTL is the backstop */
    });
    return null;
  }
  return parsed.data;
}

export async function clearAppletFocus(
  redis: Redis,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await redis.del(StreamKeys.sessionAppletFocusKey(tenantId, sessionId));
}
