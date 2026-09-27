import { z } from 'zod';
import { SkillComposeBundleSchema } from './stagedChange.js';
import type { DirectiveTemplateId } from './directiveTemplates.js';

// ============================================================================
// TaskCapabilityRequirement — portable API requirement (not a concrete grant)
// ============================================================================

export const TaskCapabilityRequirementSchema = z.object({
  /** Stable API identity (e.g., 'github', 'kaggle'). Matches requiredCapabilities prefix. */
  apiId: z.string().min(1).max(128),
  /** Required endpoint IDs (e.g., ['repos.list', 'repos.get']). */
  endpoints: z.array(z.string().min(1).max(256)).max(50).default([]),
  /** Expected auth mechanism — helps the operator prepare credentials. */
  authKind: z.enum(['bearer', 'api_key', 'oauth2', 'basic', 'custom']).optional(),
});

export type TaskCapabilityRequirement = z.infer<typeof TaskCapabilityRequirementSchema>;

// ============================================================================
// CapabilityHint — integration setup guidance
// ============================================================================

/**
 * Describes an external integration the skill needs, with enough detail
 * to guide the operator through setup. Advisory metadata only — the
 * authoritative dependency list is `SkillManifest.requiredCapabilities`.
 */
export const CapabilityHintSchema = z.object({
  /** Matches a prefix in the skill's requiredCapabilities (e.g., 'github'). */
  apiId: z.string().min(1).max(128),
  /** Human-readable description for the Store UI (e.g., 'GitHub REST API'). */
  description: z.string().min(1).max(500),
  /** OpenAPI spec URL that bind-capability can fetch to bootstrap the definition. */
  suggestedSpecUrl: z.string().url().optional(),
  /** Minimum endpoints the skill actually uses — helps scope the binding. */
  requiredEndpoints: z.array(z.string().min(1).max(256)).max(50).optional(),
  /** Expected auth mechanism — helps the operator prepare credentials. */
  authKind: z.enum(['bearer', 'api_key', 'oauth2', 'basic', 'custom']).optional(),
  /** Setup guidance shown in the Store UI (e.g., "Create a GitHub PAT with repo scope"). */
  setupNote: z.string().max(1000).optional(),
});

export type CapabilityHint = z.infer<typeof CapabilityHintSchema>;

// ============================================================================
// SkillCatalogEntry — a curated, installable skill bundle
// ============================================================================

/**
 * A curated skill in the catalog store.
 *
 * Wraps the existing `SkillComposeBundle` (same shape as skill_compose
 * proposals) with store-specific metadata: tags, description, capability
 * hints, version, and template affinity.
 *
 * Code-backed in Phase 1 (`packages/platform-artifacts/src/skillCatalog.ts`);
 * DB-backed in Phase 5 (`skill_catalog` table).
 */
export const SkillCatalogEntrySchema = z.object({
  /** Unique catalog ID (URL-safe slug). */
  catalogId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_-]+$/),
  /** Monotonically increasing revision number. Bumped on any content change. */
  version: z.number().int().min(1),
  /** Display name for the Store UI. */
  name: z.string().min(1).max(200),
  /** One-line summary shown on the card. */
  tagline: z.string().min(1).max(300),
  /** Multi-paragraph description shown in the detail view. */
  description: z.string().min(1).max(5000),
  /** Domain tags for filtering/search (e.g., 'ml', 'sales', 'operations'). */
  tags: z.array(z.string().min(1).max(50)).max(10).default([]),
  /** Which directive template this pairs well with (optional). */
  recommendedForTemplates: z
    .array(z.string() as z.ZodType<DirectiveTemplateId>)
    .max(5)
    .optional(),
  /** The installable skill bundle — same shape as skill_compose proposals. */
  bundle: SkillComposeBundleSchema,
  /** Describes external integrations the skill needs — guides the operator through setup. */
  capabilityHints: z.array(CapabilityHintSchema).max(10).optional(),
  /** If true, hidden from the Store UI. Used for test fixtures. */
  hidden: z.boolean().optional(),
});

export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;
