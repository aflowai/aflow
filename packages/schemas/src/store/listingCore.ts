/**
 * Zod-only leaf for listing identity + requirements shapes. Imported by both
 * the catalog entry union and the cybernetic StagedChange IR — keeping it
 * dependency-free avoids the store ↔ cybernetic module cycle (catalogEntry
 * pulls in skill/bundle payload schemas that import stagedChange).
 */
import { z } from 'zod';

export const CatalogIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/, 'Must contain only lowercase letters, numbers, underscores, and hyphens')
  .describe('Listing identifier, globally unique across all catalog kinds');
export type CatalogId = z.infer<typeof CatalogIdSchema>;

/**
 * The listing kinds. `bundle` is the user-facing "Skill" (a capability
 * pack: 1..n skills + their integrations + seeds); `connector` is the
 * user-facing "Integration"; `applet` is a curated stateful applet (view +
 * definition installed as one ui_artifact, instantiated in the space).
 * Skills are never standalone listings — the skill registry is the member
 * source bundles resolve through.
 */
export const CatalogEntryKindSchema = z.enum(['bundle', 'connector', 'applet']);
export type CatalogEntryKind = z.infer<typeof CatalogEntryKindSchema>;

/**
 * Read-surface summary of what a listing needs before it can run — derived
 * from the payload at read time, never authored on the entry.
 */
export const ListingRequirementsSchema = z.object({
  credentialKeys: z.array(z.string().min(1).max(256)).default([]),
  oauthIssuers: z.array(z.string().min(1).max(128)).default([]),
  needsRepo: z.boolean().default(false),
  needsModelKey: z.boolean().default(false),
});
export type ListingRequirements = z.infer<typeof ListingRequirementsSchema>;
