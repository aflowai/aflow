import { z } from 'zod';
import { SkillOriginSchema } from './skill.js';

export const SkillTombstoneSchema = z.object({
  skillId: z.string().min(1).max(128),
  workflowSlug: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  origin: SkillOriginSchema,
  archivedAt: z.string().datetime(),
  purgedAt: z.string().datetime(),
  purgedByUserId: z.string().uuid().nullable(),
  workflowRevision: z.number().int().nonnegative(),
  danglingRunCount: z.number().int().nonnegative(),
});

export type SkillTombstone = z.infer<typeof SkillTombstoneSchema>;

/** Path helper — keep deterministic so the run inspector can fetch by skillId. */
export function skillTombstonePath(skillId: string): string {
  return `/skills/${skillId}/tombstone.json`;
}

/** Internal `doc_type` value used in `memory_docs.doc_type`. */
export const SKILL_TOMBSTONE_DOC_TYPE = 'skill_tombstone' as const;
