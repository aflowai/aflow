import { z } from 'zod';
import { estimateStringTokens } from '../runtime/tokenEstimate.js';

export const CapabilityPlacementSchema = z.enum(['always_on', 'on_demand', 'off']);
export type CapabilityPlacement = z.infer<typeof CapabilityPlacementSchema>;
export const INSTALLED_SKILLS_GUIDANCE =
  'Use catalog.skill.search to find installed skills by purpose. Only explicitly pinned summaries appear here. Fetch the selected skill’s invocation contract before starting it; readiness is checked at use time.';
export const SKILL_AWARENESS_TOKEN_BUDGET = 1500;
export const SKILL_SEARCH_TOKEN_BUDGET = 1800;
export const MAX_CAPABILITY_SCHEMA_TOKENS = 16000;
export const CAPABILITY_AWARENESS_TOKEN_BUDGET = 1000;

export const SkillDiscoveryEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  mode: z.enum(['optimization', 'process', 'project']),
  status: z.string(),
  origin: z.enum(['platform', 'space']),
  revision: z.number().int(),
});
export const SkillAwarenessEntrySchema = SkillDiscoveryEntrySchema.omit({ revision: true }).extend({
  progress: z.string(),
});
export type SkillDiscoveryEntry = z.infer<typeof SkillDiscoveryEntrySchema>;
export const SkillSearchInputSchema = z.object({
  query: z
    .string()
    .default('')
    .describe('Find an installed skill by its purpose, name or slug. Empty browses the playbook.'),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
});
export type SkillSearchInput = z.infer<typeof SkillSearchInputSchema>;
export const SkillDiscoveryReadinessSchema = z.object({
  canRun: z.boolean(),
  contractValid: z.boolean(),
  activationStatus: z.string(),
  missingCapabilities: z.array(z.string()),
  missingCapabilityCount: z.number().int().optional(),
});
export const SkillSearchOutputSchema = z.object({
  skills: z.array(
    SkillDiscoveryEntrySchema.extend({
      placement: CapabilityPlacementSchema,
      descriptionOmitted: z.boolean().optional(),
      readiness: SkillDiscoveryReadinessSchema.optional(),
      suggestedInspectCall: z.object({
        operation: z.literal('workflow.manage.get'),
        input: z.object({ slug: z.string(), view: z.literal('invocation') }),
      }),
    }),
  ),
  total: z.number().int(),
  returned: z.number().int(),
  nextCursor: z.string().optional(),
  guidance: z.string(),
});

export function skillPlacement(
  slug: string,
  placements?: Readonly<Record<string, string>>,
): CapabilityPlacement {
  const value = placements?.[slug];
  return value === 'always_on' || value === 'off' ? value : 'on_demand';
}

export function skillAwarenessEntry(entry: SkillDiscoveryEntry) {
  return {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    mode: entry.mode,
    status: entry.status,
    origin: entry.origin,
    progress: 'Inspect before starting; search returns the invocation call.',
  };
}

export function skillAwarenessTokens(entries: readonly SkillDiscoveryEntry[]): number {
  return estimateStringTokens(JSON.stringify(entries.map(skillAwarenessEntry)));
}
