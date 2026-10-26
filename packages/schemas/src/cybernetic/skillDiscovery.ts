import { z } from 'zod';
import { estimateStringTokens } from '../runtime/tokenEstimate.js';
import {
  SkillUsageNextSchema,
  SkillUsageSchema,
  type SkillUsage,
} from '../operations/workflow/definition.js';

export const CapabilityPlacementSchema = z.enum(['always_on', 'on_demand', 'off']);
export type CapabilityPlacement = z.infer<typeof CapabilityPlacementSchema>;
export const INSTALLED_SKILLS_GUIDANCE =
  'Use catalog.skill.search to find installed skills by purpose. Only explicitly pinned summaries appear here. Fetch the selected skill’s invocation contract before starting it; readiness is checked at use time.';
export const SKILL_AWARENESS_TOKEN_BUDGET = 1500;
export const SKILL_SEARCH_TOKEN_BUDGET = 1800;
export const MAX_CAPABILITY_SCHEMA_TOKENS = 16000;
export const CAPABILITY_AWARENESS_TOKEN_BUDGET = 1000;

const EMPTY_USAGE: SkillUsage = { whenToUse: [], whenNotToUse: [], next: [], pitfalls: [] };

/** A JSON column a driver handed back as text; anything unparsable is no value. */
function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export const SkillDiscoveryEntrySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  // A stored workflow whose usage block does not parse is still found; it is
  // found without the account it failed to give.
  usage: z.preprocess(parseJsonText, SkillUsageSchema).catch(EMPTY_USAGE),
  mode: z.enum(['optimization', 'process', 'project']),
  status: z.string(),
  origin: z.enum(['platform', 'space']),
  revision: z.number().int(),
});

/**
 * A skill's usage as search results and pinned summaries carry it: when to
 * pick it, when not, and what follows it. Its pitfalls are counted, not
 * carried — they apply once the skill is chosen, and the invocation view
 * returns them whole beside the input contracts they are about.
 */
export const SkillUsageSummarySchema = z.object({
  whenToUse: z.array(z.string()).optional(),
  whenNotToUse: z.array(z.string()).optional(),
  next: z.array(SkillUsageNextSchema).optional(),
  pitfallCount: z.number().int().optional(),
});
export type SkillUsageSummary = z.infer<typeof SkillUsageSummarySchema>;

export function skillUsageSummary(usage: SkillUsage | undefined): SkillUsageSummary | undefined {
  if (!usage) return undefined;
  const summary: SkillUsageSummary = {
    ...(usage.whenToUse.length ? { whenToUse: usage.whenToUse } : {}),
    ...(usage.whenNotToUse.length ? { whenNotToUse: usage.whenNotToUse } : {}),
    ...(usage.next.length ? { next: usage.next } : {}),
    ...(usage.pitfalls.length ? { pitfallCount: usage.pitfalls.length } : {}),
  };
  return Object.keys(summary).length ? summary : undefined;
}

export const SkillAwarenessEntrySchema = SkillDiscoveryEntrySchema.omit({
  revision: true,
  usage: true,
}).extend({
  usage: SkillUsageSummarySchema.optional(),
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
      usage: SkillUsageSummarySchema.optional(),
      usageOmitted: z.boolean().optional(),
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
  const usage = skillUsageSummary(entry.usage);
  return {
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    ...(usage ? { usage } : {}),
    mode: entry.mode,
    status: entry.status,
    origin: entry.origin,
    progress: usage?.pitfallCount
      ? 'Inspect before starting: the invocation view returns its input contracts and pitfalls.'
      : 'Inspect before starting; search returns the invocation call.',
  };
}

export function skillAwarenessTokens(entries: readonly SkillDiscoveryEntry[]): number {
  return estimateStringTokens(JSON.stringify(entries.map(skillAwarenessEntry)));
}
