import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { termsAcceptances, users } from '@aflow/database';
import { CURRENT_TERMS_VERSION, type TermsAcceptanceStatus } from '@aflow/schemas';

/**
 * Whether `userId` has accepted the current Terms version.
 *
 * Acceptance is checked against the exact current version rather than "any
 * acceptance", so bumping {@link CURRENT_TERMS_VERSION} re-gates every existing
 * account at their next request.
 */
export async function hasAcceptedCurrentTerms(
  db: PostgresJsDatabase,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: termsAcceptances.id })
    .from(termsAcceptances)
    .where(
      and(eq(termsAcceptances.userId, userId), eq(termsAcceptances.version, CURRENT_TERMS_VERSION)),
    )
    .limit(1);
  return rows.length > 0;
}

/** The user's acceptance state, for the client to decide whether to gate. */
export async function getTermsAcceptanceStatus(
  db: PostgresJsDatabase,
  userId: string,
): Promise<TermsAcceptanceStatus> {
  const rows = await db
    .select({ version: termsAcceptances.version, acceptedAt: termsAcceptances.acceptedAt })
    .from(termsAcceptances)
    .where(eq(termsAcceptances.userId, userId))
    .orderBy(desc(termsAcceptances.acceptedAt))
    .limit(1);

  const latest = rows[0];
  const accepted = rows.some((r) => r.version === CURRENT_TERMS_VERSION);
  return {
    required: !accepted,
    currentVersion: CURRENT_TERMS_VERSION,
    acceptedVersion: latest?.version ?? null,
    acceptedAt: latest?.acceptedAt.toISOString() ?? null,
  };
}

/**
 * Record acceptance. Idempotent on (user, version) so a double-submit or a
 * retried request cannot produce duplicate evidence rows.
 */
export async function recordTermsAcceptance(
  db: PostgresJsDatabase,
  userId: string,
  version: string,
  ipAddress: string | null,
): Promise<void> {
  await db
    .insert(termsAcceptances)
    .values({ userId, version, ...(ipAddress ? { ipAddress } : {}) })
    .onConflictDoNothing();
}

/**
 * Service principals and API keys are not people and have no Terms to accept;
 * gating them would break machine integrations for a consent that has no
 * meaning.
 */
export async function isHumanAccount(db: PostgresJsDatabase, userId: string): Promise<boolean> {
  const rows = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.kind === 'human';
}
