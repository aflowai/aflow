/**
 * Design system catalog operations.
 *
 * Operations for retrieving the machine-readable design system contract
 * in different projections (codegen vs surface).
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

// ============================================================================
// Catalog mode — determines which projection/guidance to return
// ============================================================================

export const CatalogModeSchema = z.enum(['artifact', 'surface']);
export type CatalogMode = z.infer<typeof CatalogModeSchema>;

// ============================================================================
// Component category filter
// ============================================================================

export const ComponentCategoryFilterSchema = z.enum([
  'layout',
  'content',
  'actions',
  'forms',
  'feedback',
  'overlays',
  'data-display',
  'navigation',
  'icons',
  'media',
  'aflow',
]);
export type ComponentCategoryFilter = z.infer<typeof ComponentCategoryFilterSchema>;

// ============================================================================
// Catalog component entry — machine-readable component descriptor
// ============================================================================

export const CatalogPropSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  default: z.string().optional(),
  description: z.string(),
});
export type CatalogProp = z.infer<typeof CatalogPropSchema>;

export const CatalogComponentSchema = z.object({
  name: z.string(),
  importPath: z.string(),
  category: z.string(),
  intents: z.array(z.string()),
  description: z.string(),
  props: z.array(CatalogPropSchema),
  doNot: z.array(z.string()).optional(),
  combinesWith: z.array(z.string()).optional(),
  a11y: z.string().optional(),
  synonyms: z.array(z.string()).optional(),
  preferOver: z.string().optional(),
  /** Mode-specific examples. */
  examples: z.array(z.string()).optional(),
  /** Mode-specific guidance. */
  guidance: z.string().optional(),
});
export type CatalogComponent = z.infer<typeof CatalogComponentSchema>;

// ============================================================================
// Catalog token summary — lightweight token metadata
// ============================================================================

export const CatalogTokenSummarySchema = z.object({
  spaceTokens: z.array(z.string()),
  radiusTokens: z.array(z.string()),
  shadowTokens: z.array(z.string()),
  fontSizeTokens: z.array(z.string()),
  fontWeightTokens: z.array(z.string()),
  colorPaths: z.array(z.string()),
  iconNames: z.array(z.string()),
});
export type CatalogTokenSummary = z.infer<typeof CatalogTokenSummarySchema>;

// ============================================================================
// Allowed library entry
// ============================================================================

export const CatalogLibrarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** CDN or Phoenix-hosted URL for iframe runtime. */
  runtimeUrl: z.string().optional(),
  /** Whether this library is available for the given mode. */
  availableInArtifact: z.boolean(),
  availableInSurface: z.boolean(),
});
export type CatalogLibrary = z.infer<typeof CatalogLibrarySchema>;

// ============================================================================
// DesignSystemContractBundle — the canonical machine-readable catalog
// ============================================================================

export const DesignSystemContractBundleSchema = z.object({
  catalogId: z.string(),
  catalogVersion: z.string(),
  catalogHash: z.string(),
  generatedAt: z.string().datetime(),
  designSystemVersion: z.string(),
  mode: CatalogModeSchema,
  components: z.array(CatalogComponentSchema),
  tokens: CatalogTokenSummarySchema,
  libraries: z.array(CatalogLibrarySchema),
  /** Semantic surface component types — for surface mode only. */
  surfaceComponents: z.array(z.string()).optional(),
});
export type DesignSystemContractBundle = z.infer<typeof DesignSystemContractBundleSchema>;

// ============================================================================
// ui.catalog.get — Retrieve the design system contract
// (Moved from design_system.catalog.get — now handled by the UI executor)
// ============================================================================

export const DesignSystemCatalogGetInputSchema = z.object({
  mode: CatalogModeSchema.optional().describe(
    'Projection mode: artifact (codegen) or surface (streaming). Defaults to artifact.',
  ),
  categories: z
    .array(ComponentCategoryFilterSchema)
    .optional()
    .describe('Filter by component categories'),
  components: z.array(z.string()).optional().describe('Explicit component name allowlist'),
  libraries: z.array(z.string()).optional().describe('Allowed library ID subset'),
  includeTokens: z.boolean().optional().describe('Include token summary. Defaults to true.'),
  includeExamples: z
    .boolean()
    .optional()
    .describe('Include mode-specific examples. Defaults to true.'),
  compact: z
    .boolean()
    .optional()
    .describe('Return a token-efficient compact projection. Defaults to false.'),
});
export type DesignSystemCatalogGetInput = z.infer<typeof DesignSystemCatalogGetInputSchema>;

export const DesignSystemCatalogGetOutputSchema = z.object({
  bundle: DesignSystemContractBundleSchema,
});
export type DesignSystemCatalogGetOutput = z.infer<typeof DesignSystemCatalogGetOutputSchema>;

// ============================================================================

/** @deprecated Empty — catalog op moved to UiOperationRegistrations as ui.catalog.get */
export const DesignSystemOperationRegistrations: OperationRegistration[] = [];
