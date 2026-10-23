/**
 * UI step operation schemas.
 *
 * Generative UI artifact operations: generate, publish, get, list, render.
 * Plus surface projection shape (Track B placeholder — defined early to
 * prevent the catalog from biasing too much toward codegen).
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { AppletDefinitionSchema } from '../applet/definition.js';
import {
  DesignSystemCatalogGetInputSchema,
  DesignSystemCatalogGetOutputSchema,
} from './designSystem.js';
import { enumWithCustom, TEXT_MODELS } from './enums.js';
import { SurfaceSnapshotSchema } from '../surface/messages.js';
import { StepOutputPresentationSchema } from '../runtime/stepPresentation.js';

// ============================================================================
// Shared primitives
// ============================================================================

/**
 * Persisted-record scope metadata (draft/version rows). System-stamped from
 * the execution context at write time — NOT an operation input: spaceId is
 * the cybernetic boundary, carried invariantly from the originating session
 * and never caller-supplied (see ExecutorContext.spaceId).
 */
export const UiScopeSchema = z.object({
  spaceId: z.string().optional(),
  userId: z.string().optional(),
  flowId: z.string().optional(),
  runId: z.string().optional(),
});
export type UiScope = z.infer<typeof UiScopeSchema>;

/** Artifact kind discriminator. */
export const ArtifactKindSchema = z.enum([
  'react_tsx', // DS-bound React component
  'html_js', // DS-bound HTML/JS bundle
  'applet', // Standalone HTML/CSS/JS mini-app (no DS dependency)
  'illustration', // Pure SVG illustration (no JS)
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** Allowed library identifier — referenced by stable IDs, not npm package names. */
export const AllowedLibraryIdSchema = z.enum([
  'phoenix-design-system',
  'phoenix-icons',
  'phoenix-charts',
  'd3-core',
  'd3-scale',
  'recharts',
  'katex',
  'mermaid',
]);
export type AllowedLibraryId = z.infer<typeof AllowedLibraryIdSchema>;

/**
 * Applet library identifier — vetted libraries injected via `<script>` tags
 * into the applet iframe. Separate from AllowedLibraryIdSchema which covers
 * DS-bound artifact libraries loaded via import maps.
 */
export const AppletLibrarySchema = z.enum([
  // Visualization
  'd3', // D3.js — data-driven documents, bindable SVG/Canvas
  'chart-js', // Chart.js — simple declarative charts
  'three', // three.js — 3D scenes, WebGL, shaders
  'p5', // p5.js — creative coding, generative art, canvas
  'pixi', // PixiJS — 2D WebGL renderer (games, particle effects)

  // Physics / Simulation
  'matter', // Matter.js — 2D rigid-body physics
  'cannon', // cannon-es — 3D physics (pairs with three.js)

  // Animation
  'gsap', // GreenSock — timeline animation, morphing, scroll
  'anime', // anime.js — lightweight keyframe animation

  // Audio
  'tone', // Tone.js — audio synthesis, sequencing, effects

  // Maps / Geo
  'leaflet', // Leaflet — interactive tile maps
  'maplibre', // MapLibre GL — vector tile maps with WebGL

  // Utility
  'lodash', // Data manipulation
]);
export type AppletLibrary = z.infer<typeof AppletLibrarySchema>;

/** Loading strategy for applet libraries. */
export type AppletLibraryLoading = 'umd' | 'esm';

/** Per-library loading contract for applet iframe injection. */
export interface AppletLibraryEntry {
  readonly id: AppletLibrary;
  readonly version: string;
  readonly loading: AppletLibraryLoading;
  /** UMD: `<script src>` URL that sets a global. ESM: import map entry URL. */
  readonly url: string;
  /** SHA-256 (hex) of the bytes at `url` — publish capture refuses a mismatch. */
  readonly sha256: string;
  /** UMD only: the global variable name (e.g., `window.d3`). */
  readonly global?: string;
  /** Bare specifier for the import map when it differs from the id (e.g., `'maplibre-gl'`). */
  readonly specifier?: string;
  /** Optional stylesheet URL (e.g., Leaflet CSS). */
  readonly css?: string;
  /** SHA-256 (hex) of the bytes at `css` when present. */
  readonly cssSha256?: string;
  /** One-liner for the AI system prompt. */
  readonly promptHint: string;
  /** Approximate bundle size in KB. */
  readonly sizeKb: number;
}

/**
 * Static registry of vetted applet libraries with pinned CDN URLs.
 * UMD libraries are injected via `<script src>` and expose a global.
 * ESM libraries are injected via an import map and accessed via `import`.
 *
 * Every URL must point at a real single-file build published in the npm
 * package (never a CDN-generated `.min` alias, never an esm.sh shim that
 * re-exports further URLs) — publish hermiticity captures exactly these bytes
 * and verifies them against the pinned sha256.
 */
export const APPLET_LIBRARY_REGISTRY: Record<AppletLibrary, AppletLibraryEntry> = {
  d3: {
    id: 'd3',
    version: '7.9.0',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
    sha256: 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539',
    global: 'd3',
    promptHint: 'D3.js — bindable SVG/Canvas data visualizations via window.d3',
    sizeKb: 273,
  },
  'chart-js': {
    id: 'chart-js',
    version: '4.4.7',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.js',
    sha256: '2812cb8825fdc57469eb2f7bb055e9429244e599920511ee477e828499b632cb',
    global: 'Chart',
    promptHint: 'Chart.js — simple declarative charts via window.Chart',
    sizeKb: 201,
  },
  three: {
    id: 'three',
    version: '0.170.0',
    loading: 'esm',
    url: 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
    sha256: '08fd7545d13d2c7fb65ab691530a802dafefd638596501854f267d0fb13c39e7',
    specifier: 'three',
    promptHint: 'three.js — 3D scenes, WebGL via import * as THREE from "three"',
    sizeKb: 675,
  },
  p5: {
    id: 'p5',
    version: '1.11.0',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/p5@1.11.0/lib/p5.min.js',
    sha256: 'b6f0ef3dee06b7e7bd1636c3a130b1a76ca75f5cd8a236500161bc117fca327b',
    global: 'p5',
    promptHint: 'p5.js — creative coding, canvas via new p5(sketch) instance mode',
    sizeKb: 1030,
  },
  pixi: {
    id: 'pixi',
    version: '8.6.6',
    loading: 'esm',
    url: 'https://cdn.jsdelivr.net/npm/pixi.js@8.6.6/dist/pixi.min.mjs',
    sha256: '77549c6fb22228d0aa69194b33d5f6162881d9d883815a779438cacdbd435afb',
    specifier: 'pixi.js',
    promptHint: 'PixiJS — 2D WebGL renderer via import * as PIXI from "pixi.js"',
    sizeKb: 651,
  },
  matter: {
    id: 'matter',
    version: '0.20.0',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/matter-js@0.20.0/build/matter.min.js',
    sha256: '72d30be0f579eb02ce1e0b6f9d359a4f392e6837e5a26ba8be5dbee7f88e24ae',
    global: 'Matter',
    promptHint: 'Matter.js — 2D rigid-body physics via window.Matter',
    sizeKb: 82,
  },
  cannon: {
    id: 'cannon',
    version: '0.20.0',
    loading: 'esm',
    url: 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js',
    sha256: 'f0700cbd3a482954949b9d58c1b0f76dcc74767750297647a39d8c40dd63d37c',
    specifier: 'cannon-es',
    promptHint: 'cannon-es — 3D physics via import * as CANNON from "cannon-es"',
    sizeKb: 338,
  },
  gsap: {
    id: 'gsap',
    version: '3.12.5',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js',
    sha256: '28033e449a31ebcc396e5be8b13b63152bf03094288fb5867034321927bce087',
    global: 'gsap',
    promptHint: 'GSAP — timeline animation, morphing, scroll via window.gsap',
    sizeKb: 71,
  },
  anime: {
    id: 'anime',
    version: '3.2.2',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js',
    sha256: 'b5ce1be3c3f530f192e0f2571d1942846096d66119cbada34bfdc912c4873f35',
    global: 'anime',
    promptHint: 'anime.js — lightweight keyframe animation via window.anime',
    sizeKb: 17,
  },
  tone: {
    id: 'tone',
    version: '15.0.4',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/tone@15.0.4/build/Tone.js',
    sha256: '33c3fdc2f26f66f203631deb2c51a5ade54cdffb8271d2d98106c295de89bc0d',
    global: 'Tone',
    promptHint: 'Tone.js — audio synthesis, sequencing via window.Tone',
    sizeKb: 338,
  },
  leaflet: {
    id: 'leaflet',
    version: '1.9.4',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
    sha256: 'db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a',
    global: 'L',
    css: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
    cssSha256: 'a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6',
    promptHint: 'Leaflet — interactive tile maps via window.L',
    sizeKb: 144,
  },
  maplibre: {
    id: 'maplibre',
    version: '4.7.1',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    sha256: 'be9633c4d870e26fb37f1cfe5c5a77181667114003ea16207ac7850d8da8add1',
    global: 'maplibregl',
    specifier: 'maplibre-gl',
    css: 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css',
    cssSha256: '576b085fdd9487a65a19215328c1e086c07ce5bf6da09b666b3806d3d008dae9',
    promptHint: 'MapLibre GL — vector tile maps via window.maplibregl',
    sizeKb: 784,
  },
  lodash: {
    id: 'lodash',
    version: '4.17.21',
    loading: 'umd',
    url: 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js',
    sha256: 'a9705dfc47c0763380d851ab1801be6f76019f6b67e40e9b873f8b4a0603f7a9',
    global: '_',
    promptHint: 'Lodash — data manipulation via window._',
    sizeKb: 71,
  },
};

/** One captured library asset pinned to a published applet version. */
export const AppletAssetManifestEntrySchema = z.object({
  library: AppletLibrarySchema,
  asset: z.enum(['js', 'css']),
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  payloadRef: z.string(),
});
export type AppletAssetManifestEntry = z.infer<typeof AppletAssetManifestEntrySchema>;

/**
 * Captured-assets record on a published applet version — the proof that its
 * HTML was rewritten to render with no external fetch.
 */
export const AppletAssetsManifestSchema = z.object({
  capturedAt: z.string().datetime(),
  assets: z.array(AppletAssetManifestEntrySchema),
});
export type AppletAssetsManifest = z.infer<typeof AppletAssetsManifestSchema>;
/** Illustration intended purpose — shapes generation prompt and validation. */
export const IllustrationPurposeSchema = z.enum([
  'loader',
  'error',
  'avatar',
  'decorative',
  'badge',
  'icon',
  'hero',
]);
export type IllustrationPurpose = z.infer<typeof IllustrationPurposeSchema>;

/** Illustration animation intensity. */
export const IllustrationAnimationSchema = z.enum(['none', 'subtle', 'playful', 'complex']);
export type IllustrationAnimation = z.infer<typeof IllustrationAnimationSchema>;

/** Illustration target display size — affects detail level. */
export const IllustrationSizeHintSchema = z.enum(['xs', 'sm', 'md', 'lg', 'xl']);
export type IllustrationSizeHint = z.infer<typeof IllustrationSizeHintSchema>;

/** Illustration-specific generation configuration. */
export const IllustrationConfigSchema = z.object({
  /** Intended use — shapes the system prompt and validation strictness. */
  purpose: IllustrationPurposeSchema.optional(),
  /** Preferred animation style. */
  animation: IllustrationAnimationSchema.optional(),
  /** Named CSS custom properties to define for theming (e.g., `--primary`, `--accent`). */
  themeProperties: z.array(z.string().regex(/^--[\w-]+$/)).optional(),
  /** Target display size hint (helps the model choose appropriate detail level). */
  sizeHint: IllustrationSizeHintSchema.optional(),
});
export type IllustrationConfig = z.infer<typeof IllustrationConfigSchema>;

/** Validation severity level. */
export const ValidationSeveritySchema = z.enum(['error', 'warning', 'info']);

/** A single validation diagnostic. */
export const ValidationDiagnosticSchema = z.object({
  severity: ValidationSeveritySchema,
  code: z.string().max(128),
  message: z.string().max(2000),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
});
export type ValidationDiagnostic = z.infer<typeof ValidationDiagnosticSchema>;

/** Validation report attached to artifact drafts and published versions. */
export const ValidationReportSchema = z.object({
  valid: z.boolean(),
  diagnostics: z.array(ValidationDiagnosticSchema),
  checkedAt: z.string().datetime(),
});
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

export const UiArtifactPreviewDataSourceSchema = z.enum(['input', 'sample', 'none']);
export type UiArtifactPreviewDataSource = z.infer<typeof UiArtifactPreviewDataSourceSchema>;

/** Stable UUID of a published UI artifact. */
export const UiArtifactIdSchema = z.string().uuid().describe('UUID of a published UI artifact');

/** UUID of an ephemeral generated draft. */
export const UiArtifactDraftIdSchema = z.string().uuid().describe('UUID of an artifact draft');

/** UUID of an immutable published artifact version. */
export const UiArtifactVersionIdSchema = z.string().uuid().describe('UUID of an artifact version');

// ============================================================================
// UiArtifact — Draft
// ============================================================================

export const UiArtifactDraftSchema = z.object({
  draftId: UiArtifactDraftIdSchema,
  /** If iterating on an existing published artifact. */
  artifactId: UiArtifactIdSchema.optional(),
  scope: UiScopeSchema,
  name: z.string().max(256).optional(),
  description: z.string().max(4000).optional(),
  kind: ArtifactKindSchema,
  prompt: z.string().max(32_000),
  dataSchema: z.record(z.unknown()).describe('JSON Schema for the data this artifact expects'),
  catalogId: z.string(),
  catalogVersion: z.string(),
  catalogHash: z.string(),
  allowedLibraries: z.array(AllowedLibraryIdSchema),
  sourceRef: z.string().describe('PayloadRef to the generated source code'),
  compiledRef: z.string().optional().describe('PayloadRef to the compiled bundle'),
  validationReportRef: z.string().optional().describe('PayloadRef to the validation report'),
  previewRef: z.string().optional().describe('PayloadRef to a preview screenshot'),
  warnings: z.array(ValidationDiagnosticSchema),
  errors: z.array(ValidationDiagnosticSchema),
  createdBy: z.string().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  status: z.enum(['draft', 'failed']),
});
export type UiArtifactDraft = z.infer<typeof UiArtifactDraftSchema>;

// ============================================================================
// UiArtifact — Published Version
// ============================================================================

export const UiArtifactBundleProvenanceSchema = z.object({
  bundleId: z.string(),
  bindingId: z.string(),
  /** Seed `content_hash` at the last bundle install. Null for legacy
   *  rows from before Migration 97 added the column. */
  installedContentHash: z.string().nullable(),
  /** Current version's `content_hash`. */
  currentContentHash: z.string(),
  /** `true` when current ≠ installed (operator regenerated or Coach
   *  proposal ratified). `false` when still pinned to the seed. Null
   *  for legacy rows whose installedContentHash is unrecorded. */
  divergedFromBundle: z.boolean().nullable(),
});
export type UiArtifactBundleProvenance = z.infer<typeof UiArtifactBundleProvenanceSchema>;

export const UiArtifactVersionSchema = z.object({
  artifactId: UiArtifactIdSchema,
  versionId: UiArtifactVersionIdSchema,
  scope: UiScopeSchema,
  name: z.string().max(256),
  description: z.string().max(4000).optional(),
  kind: ArtifactKindSchema,
  prompt: z.string().max(32_000),
  dataSchema: z.record(z.unknown()),
  catalogId: z.string(),
  catalogVersion: z.string(),
  catalogHash: z.string(),
  allowedLibraries: z.array(AllowedLibraryIdSchema),
  sourceRef: z.string(),
  /** PayloadRef to compiled bundle. Absent for non-compiled kinds (applet, illustration). */
  compiledRef: z.string().optional(),
  validationReportRef: z.string().optional(),
  previewRef: z.string().optional(),
  warnings: z.array(ValidationDiagnosticSchema),
  errors: z.array(ValidationDiagnosticSchema),
  tags: z.array(z.string().max(64)).max(20).optional(),
  createdBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(['published', 'failed']),
  parentVersionId: z.string().optional(),
  bundleProvenance: UiArtifactBundleProvenanceSchema.optional(),
});
export type UiArtifactVersion = z.infer<typeof UiArtifactVersionSchema>;

// ============================================================================
// ui.artifact.generate — Generate a draft artifact
// ============================================================================

export const UiArtifactGenerateInputSchema = z.object({
  /** UUID of an existing published artifact to iterate on. Omit to create a new draft lineage. */
  artifactId: UiArtifactIdSchema.optional(),
  name: z.string().max(256).optional(),
  description: z.string().max(4000).optional(),
  prompt: z.string().min(1).max(32_000).describe('What UI to generate'),
  dataSchema: z
    .record(z.unknown())
    .optional()
    .describe(
      'JSON Schema for data the UI expects. If omitted and data is provided, schema is inferred from the data; otherwise the model proposes one.',
    ),
  data: z
    .union([z.record(z.unknown()), z.array(z.unknown())])
    .optional()
    .describe(
      'Optional real data for the immediate preview. Accepts an object or an array (arrays are auto-wrapped as { items: [...] }). Prefer passing this together with dataSchema when available.',
    ),
  artifactKind: ArtifactKindSchema.optional().describe('Defaults to react_tsx'),
  allowedLibraries: z
    .array(AllowedLibraryIdSchema)
    .optional()
    .describe('Subset of allowed libraries. Defaults to [phoenix-design-system, phoenix-icons].'),
  catalogRef: z
    .string()
    .optional()
    .describe('PayloadRef or inline catalog contract to use. If omitted, latest is fetched.'),
  styleGuidance: z
    .string()
    .max(8000)
    .optional()
    .describe('Additional style/composition guidance for the model'),
  model: enumWithCustom(TEXT_MODELS)
    .optional()
    .describe(
      'AI model to use. Omitted, the platform picks one the space has a credential for — preferring the model the calling agent is itself running on.',
    ),
  /** Libraries to inject for applet kind. Ignored for other kinds. */
  libraries: z
    .array(AppletLibrarySchema)
    .optional()
    .describe(
      'Libraries to inject into the applet iframe. Only used when artifactKind is applet. ' +
        'If omitted, the model declares which libraries it needs.',
    ),
  /** Illustration-specific generation config. Ignored for non-illustration kinds. */
  illustrationConfig: IllustrationConfigSchema.optional().describe(
    'Illustration-specific config (purpose, animation, theme properties, size hint). ' +
      'Only used when artifactKind is illustration.',
  ),
  applet: z
    .boolean()
    .optional()
    .describe(
      'Author a stateful applet: generation additionally emits an applet definition (state ' +
        'schema, initial state, declared actions) and wires the view to the injected ' +
        'window.aflow.act bridge. Valid for artifactKind react_tsx or applet. Make the draft ' +
        'durable with ui.applet.instantiate, which publishes it and creates the live instance.',
    ),
});
export type UiArtifactGenerateInput = z.infer<typeof UiArtifactGenerateInputSchema>;

export const UiArtifactGenerateOutputSchema = z.object({
  draft: UiArtifactDraftSchema,
  validationReport: ValidationReportSchema,
  previewValidation: ValidationReportSchema.optional(),
  dataSchema: z.record(z.unknown()).optional(),
  sampleData: z.record(z.unknown()).optional(),
  previewData: z.record(z.unknown()).optional(),
  previewDataSource: UiArtifactPreviewDataSourceSchema.optional(),
  html: z.string().optional(),
  source: z.string().optional(),
  diagnostics: z.array(ValidationDiagnosticSchema).optional(),
  rendererMetadata: z
    .object({
      artifactId: UiArtifactIdSchema.optional(),
      draftId: UiArtifactDraftIdSchema.optional(),
      kind: ArtifactKindSchema,
      name: z.string().optional(),
      catalogVersion: z.string(),
      dataSchemaValid: z.boolean(),
    })
    .optional(),
  /** Raw SVG string. Present when artifactKind is illustration. */
  svg: z.string().optional(),
  /** Validated applet definition emitted alongside the source when applet authoring was
   *  requested. Persisted on the draft; pinned to the artifact version at publish. */
  appletDefinition: AppletDefinitionSchema.optional(),
});
export type UiArtifactGenerateOutput = z.infer<typeof UiArtifactGenerateOutputSchema>;

// ============================================================================
// ui.artifact.publish — Promote a draft to a published version
// ============================================================================

export const UiArtifactPublishInputSchema = z.object({
  draftId: UiArtifactDraftIdSchema,
  /** UUID of an existing published artifact. If omitted, creates a new logical artifact. */
  artifactId: UiArtifactIdSchema.optional(),
  name: z.string().max(256).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
});
export type UiArtifactPublishInput = z.infer<typeof UiArtifactPublishInputSchema>;

export const UiArtifactPublishOutputSchema = z.object({
  artifact: UiArtifactVersionSchema,
  validationReport: ValidationReportSchema,
});
export type UiArtifactPublishOutput = z.infer<typeof UiArtifactPublishOutputSchema>;

// ============================================================================
// ui.artifact.get — Retrieve artifact metadata or version
// ============================================================================

export const UiArtifactGetInputSchema = z.object({
  /** Latest published version of this artifact. */
  artifactId: UiArtifactIdSchema.optional(),
  /** Exact published version. */
  versionId: UiArtifactVersionIdSchema.optional(),
  /** Exact draft. */
  draftId: UiArtifactDraftIdSchema.optional(),
  /** Include source/compiled refs in response. */
  includeRefs: z.boolean().optional(),
});
export type UiArtifactGetInput = z.infer<typeof UiArtifactGetInputSchema>;

export const UiArtifactGetOutputSchema = z.object({
  /** Populated when retrieving a published version. */
  artifact: UiArtifactVersionSchema.optional(),
  /** Populated when retrieving a draft. */
  draft: UiArtifactDraftSchema.optional(),
});
export type UiArtifactGetOutput = z.infer<typeof UiArtifactGetOutputSchema>;

// ============================================================================
// ui.artifact.list — Explore published artifacts
// ============================================================================

export const UiArtifactListInputSchema = z.object({
  search: z.string().max(500).optional(),
  tags: z.array(z.string().max(64)).optional(),
  kind: ArtifactKindSchema.optional(),
  includeDrafts: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
});
export type UiArtifactListInput = z.infer<typeof UiArtifactListInputSchema>;

export const UiArtifactListOutputSchema = z.object({
  artifacts: z.array(UiArtifactVersionSchema),
  drafts: z.array(UiArtifactDraftSchema).optional(),
  nextCursor: z.string().optional(),
  total: z.number().int().nonnegative(),
});
export type UiArtifactListOutput = z.infer<typeof UiArtifactListOutputSchema>;

// ============================================================================
// ui.artifact.render — Render an artifact with data
// ============================================================================

export const UiArtifactRenderInputSchema = z.object({
  artifactId: UiArtifactIdSchema.optional(),
  versionId: UiArtifactVersionIdSchema.optional(),
  draftId: UiArtifactDraftIdSchema.optional(),
  /** Runtime data to inject into the artifact. Validated against dataSchema. */
  data: z.record(z.unknown()),
});
export type UiArtifactRenderInput = z.infer<typeof UiArtifactRenderInputSchema>;

export const UiArtifactRenderOutputSchema = z.object({
  /** Standalone HTML to render in iframe. */
  html: z.string(),
  data: z.record(z.unknown()),
  dataSchema: z.record(z.unknown()).optional(),
  /** Metadata for the iframe host. */
  rendererMetadata: z.object({
    artifactId: UiArtifactIdSchema.optional(),
    versionId: UiArtifactVersionIdSchema.optional(),
    draftId: UiArtifactDraftIdSchema.optional(),
    kind: ArtifactKindSchema,
    catalogVersion: z.string(),
    dataSchemaValid: z.boolean(),
  }),
  warnings: z.array(ValidationDiagnosticSchema),
  /** Raw SVG source. Present when kind is illustration. */
  svg: z.string().optional(),
  presentation: StepOutputPresentationSchema,
});
export type UiArtifactRenderOutput = z.infer<typeof UiArtifactRenderOutputSchema>;

// ============================================================================
// Track B shapes — Surface projection (defined early, not implemented yet)
// ============================================================================

// Surface foundational types — imported from surface/types.ts (breaks circular dep).
// These are exported to consumers via surface/index.ts, not re-exported here.
import {
  SurfaceComponentTypeSchema,
  SurfaceEventTypeSchema,
  SurfaceActionTargetSchema,
  SurfaceActionDefinitionSchema,
  SurfaceMessageTypeSchema,
} from '../surface/types.js';

/**
 * Fired action event — the runtime shape when an action is triggered.
 * Used by both artifacts (via postMessage) and surfaces (via event system).
 * Artifacts dispatch: parent.postMessage({ type: 'phoenix:action', ...event }, '*')
 */
export const UiActionEventSchema = z.object({
  eventName: z.string().max(128),
  eventType: SurfaceEventTypeSchema,
  target: SurfaceActionTargetSchema.optional(),
  payload: z.record(z.unknown()).optional(),
  /** Source artifact or surface ID */
  sourceId: z.string().optional(),
  /** Timestamp of the event */
  timestamp: z.string().optional(),
});
export type UiActionEvent = z.infer<typeof UiActionEventSchema>;

/** A single component in the flat surface component graph. */
export const SurfaceComponentSchema = z.object({
  id: z.string(),
  component: SurfaceComponentTypeSchema,
  props: z.record(z.unknown()).optional(),
  children: z.array(z.string()).optional().describe('Child component IDs'),
  bindings: z.record(z.string()).optional().describe('Prop-name → data-model JSON pointer'),
  actions: z.array(SurfaceActionDefinitionSchema).optional(),
});
export type SurfaceComponent = z.infer<typeof SurfaceComponentSchema>;

/**
 * UiSurfaceMessage — a single mutation in the streamable surface protocol.
 * Shape defined early for projection planning. Implementation is Track B.
 */
export const UiSurfaceMessageSchema = z.object({
  surfaceId: z.string(),
  messageId: z.string(),
  type: SurfaceMessageTypeSchema,
  catalogVersion: z.string(),
  timestamp: z.string().datetime(),
  /** Components to create or update (for createSurface / updateComponents). */
  components: z.array(SurfaceComponentSchema).optional(),
  /** Root component IDs defining render order. */
  rootIds: z.array(z.string()).optional(),
  /** Data model patch (for updateDataModel). */
  dataModel: z.record(z.unknown()).optional(),
  /** Error details (for surfaceError). */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type UiSurfaceMessage = z.infer<typeof UiSurfaceMessageSchema>;

/**
 * Surface action event envelope — client-to-server structured event.
 * CloudEvents-inspired Phoenix envelope for surface interactions.
 */
export const SurfaceActionEventSchema = z.object({
  eventId: z.string(),
  eventName: z.string().max(256),
  eventType: SurfaceEventTypeSchema,
  source: z.string().max(512),
  subject: z.string().max(512).optional(),
  timestamp: z.string().datetime(),
  surfaceId: z.string(),
  runId: z.string(),
  stepExecutionId: z.string().optional(),
  componentId: z.string().optional(),
  catalogVersion: z.string(),
  payload: z.record(z.unknown()),
  dataModel: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type SurfaceActionEvent = z.infer<typeof SurfaceActionEventSchema>;

// ============================================================================
// ui.surface.visualize — Generate streamable realtime surface (Track B)
// ============================================================================

export const UiSurfaceVisualizeInputSchema = z.object({
  /** What to visualize — natural language prompt. */
  prompt: z
    .string()
    .min(1)
    .max(32_000)
    .describe('Describe the UI to generate as a streamable surface'),
  /** JSON Schema for the data this surface expects. */
  dataSchema: z
    .record(z.unknown())
    .optional()
    .describe('JSON Schema for data the surface expects. If omitted, model proposes one.'),
  /** Initial data to populate the surface. */
  data: z
    .union([z.record(z.unknown()), z.array(z.unknown())])
    .optional()
    .describe('Initial data for the surface. Arrays are auto-wrapped as { items: [...] }.'),
  /** Allowed surface component types. If omitted, all catalog components are available. */
  allowedComponents: z
    .array(SurfaceComponentTypeSchema)
    .optional()
    .describe('Restrict which surface component types the model can use.'),
  /** Additional style/composition guidance for the model. */
  styleGuidance: z
    .string()
    .max(8000)
    .optional()
    .describe('Additional style and composition guidance'),
  /** AI model to use for generation. */
  model: enumWithCustom(TEXT_MODELS)
    .optional()
    .describe(
      'AI model to use. Omitted, the platform picks one the space has a credential for — preferring the model the calling agent is itself running on.',
    ),
  /** Surface ID. If omitted, a unique ID is generated. */
  surfaceId: z.string().max(256).optional(),
});
export type UiSurfaceVisualizeInput = z.infer<typeof UiSurfaceVisualizeInputSchema>;

export const UiSurfaceVisualizeOutputSchema = z.object({
  /** The surface ID. */
  surfaceId: z.string(),
  /** Catalog version used for generation. */
  catalogVersion: z.string(),
  /** Final surface snapshot after generation completes. */
  snapshot: SurfaceSnapshotSchema.optional(),
  /** All mutation messages emitted during generation. */
  mutations: z.array(z.record(z.unknown())).optional(),
  /** Total number of components in the final surface. */
  componentCount: z.number().int().nonnegative(),
  /** Total number of mutation messages emitted. */
  mutationCount: z.number().int().nonnegative(),
  /** Generation duration in milliseconds. */
  durationMs: z.number().nonnegative(),
  /** Data schema (provided or model-proposed). */
  dataSchema: z.record(z.unknown()).optional(),
  presentation: StepOutputPresentationSchema,
});
export type UiSurfaceVisualizeOutput = z.infer<typeof UiSurfaceVisualizeOutputSchema>;

// ============================================================================

export const UiOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'ui',
    group: 'catalog',
    verb: 'get',
    name: 'Get Design System Catalog',
    actionLabel: 'Fetching catalog…',
    semanticDescription:
      'Retrieve the Phoenix design system contract as a machine-readable catalog. ' +
      'Supports two modes: "artifact" returns a codegen-optimized projection with fuller examples ' +
      'and broader prop flexibility; "surface" returns a mutation-friendly projection with semantic ' +
      'surface components, constrained props, and stronger defaults. Both modes share the same ' +
      'canonical component identity and prop definitions.',
    tags: ['ui', 'catalog', 'design_system', 'generation'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Retrieve the design system catalog for UI generation (codegen or surface mode).',
      whenToUse: [
        'Before calling ui.artifact.generate — pass the catalog to the generation prompt',
        "Before calling ui.surface.visualize — constrain the model's generation surface",
        'Exploring available components and their props/examples',
      ],
      whenNotToUse: ['Looking for operation schemas — use catalog.tool.list instead'],
      pitfalls: [
        'Always pass the catalogVersion/catalogHash to generation ops for deterministic replay',
      ],
      minimalExampleInput: {
        mode: 'artifact',
      },
    },
    accessMode: 'read',
    inputZod: DesignSystemCatalogGetInputSchema,
    outputZod: DesignSystemCatalogGetOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'artifact',
    verb: 'generate',
    name: 'Generate UI Artifact',
    actionLabel: 'Generating UI…',
    semanticDescription:
      'Generate a UI artifact: a DS-bound component (react_tsx, html_js), a standalone interactive ' +
      'applet with third-party libraries (applet), or a pure SVG illustration with CSS/SMIL ' +
      'animations (illustration). The model produces source code that is validated and stored as a draft. ' +
      'DS-bound kinds are compiled via esbuild; applets and illustrations skip compilation. ' +
      'Optionally provide a dataSchema and real preview data; generate returns immediate preview HTML ' +
      'using the supplied data when it validates, otherwise it falls back to sample data or empty-state rendering.',
    tags: ['ui', 'generation', 'artifact'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Generate a validated UI artifact as a draft (component, applet, or illustration).',
      whenToUse: [
        'Creating reusable UI views/dashboards/cards against a data schema (react_tsx or html_js)',
        'Building generated UI that will be rendered later with runtime data',
        'Creating a draft and immediately previewing it with real runtime data in the same step',
        'Iterating on an existing artifact with a new prompt',
        'Building interactive mini-apps, games, simulations, or creative tools (applet kind with libraries)',
        'Authoring a stateful applet — a shared work item people and the agent operate together — set applet: true so the definition is emitted with the view',
        'Creating animated SVG illustrations, loaders, avatars, or decorative graphics (illustration kind)',
        'When previewing with data from a prior tool call, pass it by reference (`{ "$ref": "output.<previousToolCallId>/<field>" }`) — do not transcribe the payload inline',
      ],
      whenNotToUse: [
        'Streaming live progressive UI — use ui.surface.visualize instead',
        'Simple text responses — use ai.text.generate instead',
      ],
      pitfalls: [
        'Generated artifacts are drafts — call ui.artifact.publish to make them durable',
        'Applet drafts (applet: true) are made durable by ui.applet.instantiate instead — it publishes the draft and creates the live instance in one step',
        'Provide a dataSchema when possible to improve generation accuracy',
        'If you already have the real data for the first preview, pass it as data so generate can return preview HTML directly',
        'artifactId must be the UUID of an existing published artifact; omit it when creating a new artifact',
        'For applet kind, pass libraries to select specific third-party libraries; omit to let the model choose',
        'Illustration kind outputs SVG — use the svg field in the output for inline rendering',
        'Do not transcribe prior tool output inline into `data`. Pass `{ "$ref": "output.<toolCallId>/<field>" }` so the platform resolves it server-side; inline copying wastes tokens and risks numeric precision loss.',
      ],
      minimalExampleInput: {
        prompt:
          'A card showing a user profile with avatar, name, email, and a list of recent activities',
        data: { $ref: 'output.<previousToolCallId>/user' },
      },
    },
    accessMode: 'write',
    inputZod: UiArtifactGenerateInputSchema,
    outputZod: UiArtifactGenerateOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'artifact',
    verb: 'publish',
    name: 'Publish UI Artifact',
    actionLabel: 'Publishing artifact…',
    semanticDescription:
      'Promote a validated draft to a durable published artifact version. ' +
      'Creates a new immutable version under an artifactId. If artifactId is omitted, ' +
      'creates a new logical artifact.',
    tags: ['ui', 'artifact', 'publish'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Promote a draft to a durable published artifact version.',
      whenToUse: [
        'After generating and reviewing a draft, publish it for reuse',
        'Creating a new version of an existing artifact after iteration',
      ],
      whenNotToUse: ['Generating a new artifact — use ui.artifact.generate first'],
      minimalExampleInput: {
        draftId: '550e8400-e29b-41d4-a716-446655440000',
        name: 'User Profile Card',
      },
    },
    accessMode: 'write',
    inputZod: UiArtifactPublishInputSchema,
    outputZod: UiArtifactPublishOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'artifact',
    verb: 'get',
    name: 'Get UI Artifact',
    actionLabel: 'Retrieving artifact…',
    semanticDescription:
      'Retrieve a published artifact version, a specific historical version, or a draft. ' +
      'Supports latest-by-artifactId, exact-by-versionId, or draft-by-draftId.',
    tags: ['ui', 'artifact', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Retrieve a UI artifact by ID (published, version, or draft).',
      whenToUse: [
        'Loading an existing artifact for rendering with new or later-arriving runtime data',
        'Inspecting artifact metadata, source, or validation report',
      ],
      whenNotToUse: ['Searching/browsing artifacts — use ui.artifact.list instead'],
      minimalExampleInput: {
        artifactId: '550e8400-e29b-41d4-a716-446655440000',
      },
    },
    accessMode: 'read',
    inputZod: UiArtifactGetInputSchema,
    outputZod: UiArtifactGetOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'artifact',
    verb: 'list',
    name: 'List UI Artifacts',
    actionLabel: 'Listing artifacts…',
    semanticDescription:
      'List published UI artifacts with optional filtering by scope, search text, tags, ' +
      'kind, and pagination. Optionally include drafts.',
    tags: ['ui', 'artifact', 'list'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Browse and search published UI artifacts.',
      whenToUse: [
        'Discovering existing artifacts before generating new ones',
        'Finding an artifact to render or iterate on',
      ],
      whenNotToUse: ['Retrieving a specific known artifact — use ui.artifact.get instead'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: UiArtifactListInputSchema,
    outputZod: UiArtifactListOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'artifact',
    verb: 'render',
    name: 'Render UI Artifact',
    actionLabel: 'Rendering artifact…',
    semanticDescription:
      'Render a published artifact or draft with runtime data. Returns standalone HTML for ' +
      "sandboxed iframe rendering. Validates data against the artifact's stored dataSchema. " +
      'For illustration kind, also returns the raw SVG in the svg output field.',
    tags: ['ui', 'artifact', 'render'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Render a UI artifact with data into standalone HTML for iframe display.',
      whenToUse: [
        'Displaying a previously generated artifact with fresh runtime data',
        'Re-rendering a published artifact later or with a different dataset than generate used',
        'Previewing a draft before publishing',
        'When `data` comes from a prior tool call, pass it by reference (`{ "$ref": "output.<previousToolCallId>/<field>" }`) instead of copying the payload inline',
      ],
      whenNotToUse: [
        'Streaming live progressive UI — use ui.surface.visualize instead',
        'Generating a new artifact — use ui.artifact.generate first',
      ],
      pitfalls: [
        "Data must validate against the artifact's dataSchema or render will fail",
        'Do not transcribe prior tool output inline into `data`. Pass `{ "$ref": "output.<toolCallId>/<field>" }` so the platform resolves it server-side; inline copying wastes tokens, risks numeric precision loss, and can fail schema validation.',
      ],
      minimalExampleInput: {
        artifactId: '550e8400-e29b-41d4-a716-446655440000',
        data: { $ref: 'output.<previousToolCallId>/user' },
      },
    },
    accessMode: 'read',
    inputZod: UiArtifactRenderInputSchema,
    outputZod: UiArtifactRenderOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'surface',
    verb: 'visualize',
    name: 'Visualize Surface',
    actionLabel: 'Generating surface…',
    semanticDescription:
      'Generate a streamable realtime UI surface by emitting declarative mutation messages. ' +
      'The model generates a flat component graph using semantic surface types (Page, Section, Panel, ' +
      'DataTable, Chart, Form, etc.) that the client renderer maps to full design system components. ' +
      'Mutations stream progressively — the UI appears incrementally as the model generates. ' +
      'Surfaces support data-model bindings, declarative actions, and two-way form binding.',
    tags: ['ui', 'surface', 'generation', 'streaming'],
    idempotency: 'non_idempotent',
    usage: {
      oneLine: 'Generate a live streamable UI surface with progressive rendering.',
      whenToUse: [
        'Displaying data as a rich interactive UI that streams in progressively',
        'Building dashboards, forms, data tables, or metric views from runtime data',
        'Creating interactive surfaces that need user input (forms, chat composers)',
        'Showing results of tool calls or agent work as structured UI instead of raw text',
        'When `data` comes from a prior tool call, pass it by reference (`{ "$ref": "output.<previousToolCallId>/<field>" }`) — the surface engine resolves it server-side and you avoid transcribing the payload inline',
      ],
      whenNotToUse: [
        'Reusable published UI components — use ui.artifact.generate instead',
        'Simple text responses — use ai.text.generate instead',
        'Static data display with no interactivity — consider ui.artifact.generate',
      ],
      pitfalls: [
        'Surfaces are ephemeral — they live as long as the run is active',
        'Always specify a data model and bind components to it for dynamic content',
        'Actions must declare a target (agent, flow, step, client) for routing',
        'The model generates a flat component graph with IDs — not nested markup',
        'Do not transcribe prior tool output inline into `data`. Pass `{ "$ref": "output.<toolCallId>/<field>" }` so the platform resolves it server-side; inline copying wastes tokens and risks numeric precision loss on large datasets.',
      ],
      minimalExampleInput: {
        prompt: 'A dashboard showing sales metrics with a line chart and data table',
        data: { $ref: 'output.<previousToolCallId>/dashboard' },
      },
    },
    accessMode: 'write',
    inputZod: UiSurfaceVisualizeInputSchema,
    outputZod: UiSurfaceVisualizeOutputSchema,
  },
];
