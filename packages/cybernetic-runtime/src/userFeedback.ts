import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, or, sql } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import { createTenantContext, withTenantSchema, userFeedback } from '@aflow/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserFeedbackEntry {
  reasonCode: string;
  subjectKind: string;
  subjectId: string;
  freeText: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load recent user feedback for a skill, including feedback tied to runs
 * or proposals targeting that skill.
 *
 * Subject ID convention: `{skillSlug}:{entityId}` for run and proposal
 * feedback, plain `skillSlug` for direct skill feedback. This allows a
 * single LIKE query to pick up all feedback related to a skill.
 */
export async function loadUserFeedbackForSkill(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  skillSlug: string,
  limit = 20,
): Promise<UserFeedbackEntry[]> {
  const tenantCtx = createTenantContext(tenantId as TenantId);

  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        reasonCode: userFeedback.reasonCode,
        subjectKind: userFeedback.subjectKind,
        subjectId: userFeedback.subjectId,
        freeText: userFeedback.freeText,
        createdAt: userFeedback.createdAt,
      })
      .from(userFeedback)
      .where(
        and(
          eq(userFeedback.spaceId, spaceId),
          or(
            // Direct skill feedback: subjectId = skillSlug
            and(eq(userFeedback.subjectKind, 'skill'), eq(userFeedback.subjectId, skillSlug)),
            // Run feedback: subjectId = '{skillSlug}:{runId}'
            and(
              eq(userFeedback.subjectKind, 'run'),
              sql`${userFeedback.subjectId} LIKE ${skillSlug + ':%'}`,
            ),
            // Proposal rejection feedback: subjectId = '{skillSlug}:{proposalId}'
            and(
              eq(userFeedback.subjectKind, 'proposal'),
              sql`${userFeedback.subjectId} LIKE ${skillSlug + ':%'}`,
            ),
          ),
        ),
      )
      .orderBy(sql`${userFeedback.createdAt} DESC`)
      .limit(limit),
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Prompt formatter
// ---------------------------------------------------------------------------

/**
 * Format user feedback entries for inclusion in the Coach's review prompt,
 * grouped by reason code.
 */
export function formatUserFeedbackForPrompt(entries: UserFeedbackEntry[]): string {
  if (entries.length === 0) return '';

  // Group by reason code
  const groups = new Map<string, UserFeedbackEntry[]>();
  for (const e of entries) {
    const existing = groups.get(e.reasonCode);
    if (existing) {
      existing.push(e);
    } else {
      groups.set(e.reasonCode, [e]);
    }
  }

  const lines: string[] = ['User feedback:'];
  for (const [reason, items] of groups) {
    lines.push(`  ${reason}: ${String(items.length)} report(s)`);
    // Show up to 3 free-text notes per reason
    const withText = items.filter((i) => i.freeText).slice(0, 3);
    for (const item of withText) {
      lines.push(`    - "${item.freeText}"`);
    }
  }
  lines.push('');
  lines.push(
    'Address the most frequent reason codes in your review. User feedback is a primary signal.',
  );

  return lines.join('\n');
}
