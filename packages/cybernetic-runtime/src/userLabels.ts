/**
 * User id → human display label resolution.
 *
 * Surfaces (the workflow-run card's resolved-decision pill, etc.) persist and
 * emit the actor's user id (a UUID). For display we want the person's name, so
 * this resolves ids → `displayName ?? email ?? id` from the public `users`
 * table. Resolution is display-only and best-effort: callers fall back to the
 * raw id on any error (a missing name must never break an approval or a read).
 */
import { inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { users } from '@aflow/database';

/** Pick the best display label for a user row. Pure — unit-testable. */
export function pickUserLabel(row: {
  id: string;
  displayName?: string | null;
  email?: string | null;
}): string {
  return row.displayName || row.email || row.id;
}

/**
 * Resolve a set of user ids to display labels in a single batched query.
 * Unknown ids are simply absent from the returned map (callers fall back to
 * the raw id). De-dupes and drops empty ids before querying; returns an empty
 * map for an empty input without touching the database.
 */
export async function resolveUserLabels(
  db: PostgresJsDatabase,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id) => id.length > 0))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  for (const r of rows) out.set(r.id, pickUserLabel(r));
  return out;
}

/** Single-id convenience. Returns the resolved label, or the id if unknown. */
export async function resolveUserLabel(db: PostgresJsDatabase, userId: string): Promise<string> {
  const labels = await resolveUserLabels(db, [userId]);
  return labels.get(userId) ?? userId;
}

/**
 * Display labels with collisions disambiguated: when two people resolve to
 * the same label, each gets a short id suffix — two accounts with one name
 * must never be conflated by the agent or the humans.
 */
export function disambiguateLabels(
  entries: Array<{ userId: string; label: string | undefined }>,
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.label) continue;
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.label) continue;
    out.set(
      entry.userId,
      (counts.get(entry.label) ?? 0) > 1
        ? `${entry.label} (${entry.userId.slice(0, 6)})`
        : entry.label,
    );
  }
  return out;
}

/**
 * What a roster may call someone: their display name, or a neutral short-id
 * handle. Email never reaches a roster surface — the generic label chain
 * falls back to it, and even the local part leaks the address alias into
 * agent context and transcripts.
 */
export function rosterUserLabel(label: string | undefined, userId: string): string {
  if (label !== undefined && !label.includes('@')) return label;
  return `member-${userId.slice(0, 6)}`;
}
