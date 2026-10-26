import type { SkillCatalogEntry } from '@aflow/schemas';

/**
 * Everything a skill tells the Helmsman about choosing and running it: its
 * Store description, its workflow's description and its usage block — what
 * skill search, the pinned summary and the invocation view carry. Guidance a
 * test pins may live in any of them.
 */
export function skillGuidance(entry: SkillCatalogEntry): string {
  const { workflow } = entry.bundle;
  const usage = workflow.usage;
  return [
    entry.description,
    workflow.description ?? '',
    ...(usage?.whenToUse ?? []),
    ...(usage?.whenNotToUse ?? []),
    ...(usage?.next ?? []).map((next) => `${next.skill ?? next.operation ?? ''}: ${next.when}`),
    ...(usage?.pitfalls ?? []),
  ].join('\n\n');
}
