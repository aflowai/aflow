import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getCoachLearningById, updateCoachLearningResolution } from './coachLearningsStore.js';

/**
 * Operator resolution of a Coach learning — the skill's durable "memory muscle".
 * Learnings accumulate and can grow redundant; the operator ratifies the ones
 * worth keeping and rejects the rest. This is a soft status transition (not a
 * delete), so the audit trail and supersession chain stay intact. The one
 * authority behind both the REST resolve route and `learner.learning.resolve`.
 */
export type LearningResolveResult =
  { ok: true } | { ok: false; status: 404 | 409 | 422; detail: string };

export async function resolveLearning(params: {
  tenantId: string;
  spaceId: string;
  /** When set, the learning must be scoped to this skill (skill-scoped routes). */
  slug?: string;
  learningId: string;
  action: 'ratify' | 'reject';
  operatorUserId: string;
  db: PostgresJsDatabase;
}): Promise<LearningResolveResult> {
  const { tenantId, spaceId, slug, learningId, action, operatorUserId, db } = params;

  const learning = await getCoachLearningById(db, tenantId, spaceId, learningId);
  if (!learning) {
    return { ok: false, status: 404, detail: 'Learning not found.' };
  }

  // Don't resolve a learning that belongs to another skill.
  if (slug !== undefined) {
    const belongs =
      (learning.scope.kind === 'skill' || learning.scope.kind === 'campaign') &&
      learning.scope.skillSlug === slug;
    if (!belongs) {
      return { ok: false, status: 409, detail: `Learning is not scoped to skill '${slug}'.` };
    }
  }

  // Ratification only applies to a staged (`proposed`) learning; an `auto_recorded`
  // one is already active and can only be pruned (rejected), not ratified.
  if (action === 'ratify' && learning.status !== 'proposed') {
    return {
      ok: false,
      status: 409,
      detail: 'Only a staged (proposed) learning can be ratified.',
    };
  }

  const updated = await updateCoachLearningResolution(db, tenantId, {
    spaceId,
    learningId,
    status: action === 'ratify' ? 'ratified' : 'rejected',
    resolvedBy: operatorUserId,
  });
  if (!updated) {
    return { ok: false, status: 404, detail: 'Learning not found.' };
  }

  return { ok: true };
}
