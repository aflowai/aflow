/**
 * UI artifact step handler.
 *
 * Handles: ui.artifact.generate, ui.artifact.publish,
 *          ui.artifact.get, ui.artifact.list, ui.artifact.render
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  validationError,
  internalError,
} from '@aflow/executor-runtime';
import type { AflowError, ValidationDiagnostic } from '@aflow/schemas';
import type { ChatMessage } from '@aflow/ai-client';
import {
  contentAddressForJson,
  storeArtifactViewHtml,
  type PayloadStore,
} from '@aflow/payload-store';
import {
  createAppletPersistence,
  createTenantContext,
  tenantIdToSchemaName,
} from '@aflow/database';
import type { getDatabase } from '@aflow/database';
import type postgres from 'postgres';
import type {
  ArtifactKind,
  AppletDefinition,
  AppletLibrary,
  IllustrationConfig,
} from '@aflow/schemas';
import { APPLET_LIBRARY_REGISTRY, isDurablePayloadKind } from '@aflow/schemas';
import { validateAndCompile } from '@aflow/ui-artifact-compiler';
import { AppletHandler, type AppletDeltaPublisher } from './appletHandler.js';
import {
  resolveAppletDefinition,
  type AppletDefinitionRepairFn,
} from './appletDefinitionEmission.js';
import { buildAppletDefinitionPromptSection } from './promptAppletDefinition.js';
import { publishDraftCore, type DraftRow, type PublishCoreDeps } from './publishArtifactCore.js';
import { runAstValidation } from './astValidation.js';
import { inferDataSchemaFromData } from './dataSchemaInference.js';
import { validateDataAgainstSchema } from './dataSchemaValidation.js';
import {
  getAIClientForContext,
  hasResolvableProvider,
  resolveGenerationModel,
} from '../aiClient.js';
import { DEFAULT_UI_MODEL, DEFAULT_APPLET_MODEL } from './uiModelDefaults.js';
import { SurfaceHandler } from './surfaceHandler.js';
import {
  buildAppletSystemPrompt,
  buildAppletUserPrompt,
  generateAppletTemplateSource,
} from './appletGeneration.js';
import { validateApplet } from './appletValidation.js';
import { buildAppletViewHtml } from './appletHtmlWrapper.js';
import { captureHermeticApplet, defaultAppletAssetFetcher } from './appletHermeticPublish.js';
import {
  buildIllustrationSystemPrompt,
  buildIllustrationUserPrompt,
  generateIllustrationTemplateSvg,
} from './illustrationGeneration.js';
import { validateIllustration, wrapIllustrationHtml } from './illustrationValidation.js';

// ============================================================================
// DS contract loading (loaded from @aflow/design-system at first use)
// ============================================================================

const __uiDirname = dirname(fileURLToPath(import.meta.url));

interface CompactContract {
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  mode: string;
  components: Array<{ name: string; category: string; description: string; props: unknown[] }>;
}

interface FullContractBundle {
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  generatedAt: string;
  designSystemVersion: string;
  mode: string;
  components: Array<{
    name: string;
    importPath: string;
    category: string;
    intents: string[];
    description: string;
    props: Array<{
      name: string;
      type: string;
      required: boolean;
      default?: string;
      description: string;
    }>;
    doNot?: string[];
    combinesWith?: string[];
    a11y?: string;
    synonyms?: string[];
    preferOver?: string;
    examples?: string[];
    guidance?: string;
  }>;
  tokens: {
    spaceTokens: string[];
    radiusTokens: string[];
    shadowTokens: string[];
    fontSizeTokens: string[];
    fontWeightTokens: string[];
    colorPaths: string[];
    iconNames: string[];
  };
  libraries: Array<{
    id: string;
    name: string;
    description: string;
    availableInArtifact: boolean;
    availableInSurface: boolean;
  }>;
  surfaceComponents?: string[];
}

// Compact contract (for AI generation prompts)
let cachedContract: CompactContract | null = null;
let catalogComponentNames: string[] | null = null;

// Full bundles (for catalog.get operation)
let artifactBundle: FullContractBundle | null = null;
let surfaceBundle: FullContractBundle | null = null;
let compactArtifactBundle: Record<string, unknown> | null = null;
let compactSurfaceBundle: Record<string, unknown> | null = null;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateOptionalUuidInput(
  fieldName: 'artifactId' | 'draftId' | 'versionId',
  value: string | undefined,
): AflowError | null {
  if (!value) {
    return null;
  }

  if (!UUID_REGEX.test(value)) {
    return validationError(`${fieldName} must be a valid UUID. Received: "${value}"`);
  }

  return null;
}

function getDsDistDir(): string {
  // Resolve from design-system package dist directory
  return resolve(__uiDirname, '..', '..', '..', '..', '..', 'packages', 'design-system', 'dist');
}

function loadContract(): CompactContract {
  if (cachedContract) return cachedContract;

  try {
    const require = createRequire(import.meta.url);
    const contractPath = require.resolve('@aflow/design-system/contract-compact.json');
    const raw = readFileSync(contractPath, 'utf-8');
    cachedContract = JSON.parse(raw) as CompactContract;
  } catch {
    cachedContract = {
      catalogId: 'phoenix-design-system',
      catalogVersion: '2.0.0-artifact',
      catalogHash: 'fallback',
      mode: 'artifact',
      components: [],
    };
    console.warn('Could not load DS contract — using fallback');
  }

  return cachedContract;
}

function loadFullBundles(): void {
  if (artifactBundle) return;

  const dsDistDir = getDsDistDir();
  try {
    artifactBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract.json'), 'utf-8'),
    ) as FullContractBundle;
    surfaceBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract-surface.json'), 'utf-8'),
    ) as FullContractBundle;
    compactArtifactBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract-compact.json'), 'utf-8'),
    ) as Record<string, unknown>;
    compactSurfaceBundle = JSON.parse(
      readFileSync(resolve(dsDistDir, 'design-system-contract-compact-surface.json'), 'utf-8'),
    ) as Record<string, unknown>;
  } catch (err) {
    console.error('[UiArtifactHandler] Failed to load contract bundles:', err);
    throw new Error(
      'Design system contract bundles not found. Run `yarn workspace @aflow/design-system build` first.',
    );
  }
}

function getCatalogComponentNames(): string[] {
  if (catalogComponentNames) return catalogComponentNames;

  const contract = loadContract();
  if (contract.components.length > 0) {
    catalogComponentNames = contract.components.map((c) => c.name);
  } else {
    catalogComponentNames = [
      'Row',
      'Column',
      'Grid',
      'Panel',
      'Section',
      'Box',
      'ScrollArea',
      'Spacer',
      'Text',
      'Heading',
      'Button',
      'IconButton',
      'SearchField',
      'FilterChips',
      'Field',
      'Input',
      'Badge',
      'Spinner',
      'EmptyState',
      'Dialog',
      'Tooltip',
      'Card',
      'Accordion',
      'PropertyTable',
      'KeyValueTable',
      'CodeBlock',
      'JsonViewer',
      'Timeline',
      'Tabs',
      'Toolbar',
      'Icon',
      'Avatar',
      'Logo',
      'RunStatusBadge',
      'ChatLayout',
      'ChatMessage',
      'PageHeader',
    ];
  }
  return catalogComponentNames;
}

// ============================================================================
// Compact bundle filtering
// ============================================================================

function applyCompactFilters(
  base: Record<string, unknown>,
  categories?: string[],
  componentFilter?: string[],
  libraryFilter?: string[],
  includeTokens?: boolean,
  includeExamples?: boolean,
): Record<string, unknown> {
  const result = { ...base };

  // Filter components
  if (Array.isArray(result['components'])) {
    let components = result['components'] as Array<Record<string, unknown>>;
    if (categories && categories.length > 0) {
      const catSet = new Set(categories);
      components = components.filter((c) => catSet.has(c['category'] as string));
    }
    if (componentFilter && componentFilter.length > 0) {
      const nameSet = new Set(componentFilter);
      components = components.filter((c) => nameSet.has(c['name'] as string));
    }
    if (includeExamples === false) {
      components = components.map((c) => {
        const { examples: _e, guidance: _g, ...rest } = c;
        return rest;
      });
    }
    result['components'] = components;
  }

  // Filter libraries
  if (libraryFilter && libraryFilter.length > 0 && Array.isArray(result['libraries'])) {
    const libSet = new Set(libraryFilter);
    result['libraries'] = (result['libraries'] as Array<Record<string, unknown>>).filter((l) =>
      libSet.has(l['id'] as string),
    );
  }

  // Strip tokens if not requested
  if (includeTokens === false) {
    delete result['tokens'];
  }

  return result;
}

// ============================================================================
// AI-powered structured generation (Specs 1, 2, 3, 7)
// ============================================================================

/** Structured generation output — parsed from model response (Spec 1). */
interface GenerationOutput {
  code: string;
  dataSchema?: Record<string, unknown>;
  sampleData?: Record<string, unknown>;
  name?: string;
  description?: string;
  notes?: Record<string, unknown>;
  warnings?: string[];
  /** Libraries declared by the model (applet kind). */
  libraries?: string[];
  /** Applet definition candidate (applet authoring) — validated downstream. */
  definition?: Record<string, unknown>;
}

/** Schema provenance tracking (Spec 2). */
type SchemaProvenance = 'user_supplied' | 'data_inferred' | 'model_proposed' | 'fallback_inferred';

interface AIUsageData {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCostUsd: number;
  completionCostUsd: number;
  totalCostUsd: number;
}

/** Full generation result with metadata (Spec 6). */
interface GenerationResult {
  source: string;
  resolvedDataSchema: Record<string, unknown>;
  sampleData?: Record<string, unknown>;
  schemaProvenance: SchemaProvenance;
  resolvedName?: string;
  resolvedDescription?: string;
  modelNotes?: Record<string, unknown>;
  modelWarnings?: string[];
  /** Libraries declared by the model (applet kind) — merged with user-requested libs for wrapping. */
  declaredLibraries?: string[];
  /** Unvalidated definition candidate from the applet-authoring response. */
  definitionCandidate?: Record<string, unknown>;
  model: string;
  attemptCount: number;
  repaired: boolean;
  usage?: AIUsageData;
}

type PreviewDataSource = 'input' | 'sample' | 'none';

function extractUsage(response: {
  provider?: string;
  model: string;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  cost?: { promptCost: number; completionCost: number; totalCost: number } | undefined;
}): AIUsageData | undefined {
  if (!response.usage.totalTokens) return undefined;
  return {
    provider: response.provider ?? 'unknown',
    model: response.model,
    promptTokens: response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completionTokens ?? 0,
    totalTokens: response.usage.totalTokens ?? 0,
    promptCostUsd: response.cost?.promptCost ?? 0,
    completionCostUsd: response.cost?.completionCost ?? 0,
    totalCostUsd: response.cost?.totalCost ?? 0,
  };
}

/** Merge two usage records (generation + repair). */
function mergeUsage(a?: AIUsageData, b?: AIUsageData): AIUsageData | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    provider: a.provider,
    model: a.model,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    promptCostUsd: a.promptCostUsd + b.promptCostUsd,
    completionCostUsd: a.completionCostUsd + b.completionCostUsd,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
  };
}

/**
 * Tier 1 categories — always included in generation guidance.
 * Tier 2 (chart) — only included when the prompt indicates data visualization.
 */
/**
 * Build filtered DS guidance for generation context.
 * Includes all non-internal components (all tiers). Chart components are always
 * available — the LLM decides whether to use them based on the prompt.
 * The runtime import map is built from the compiled output, not from hints.
 */
function buildDsGuidance(_prompt: string, allowedLibraries: string[]): string {
  const contract = loadContract();

  // Exclude only internal (aflow/dev-only) components
  const filteredComponents = contract.components.filter((c) => {
    return c.category !== 'aflow';
  });

  // Build compact guidance string, grouping by import path
  const baseComponents = filteredComponents.filter((c) => c.category !== 'chart');
  const chartComponents = filteredComponents.filter((c) => c.category === 'chart');

  const formatComponent = (c: (typeof filteredComponents)[0]) => {
    const propsStr = (c.props as Array<{ name: string; type: string; required: boolean }>)
      .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
      .join(', ');
    return `  ${c.name} (${c.category}): ${c.description}\n    Props: { ${propsStr} }`;
  };

  let componentList = baseComponents.map(formatComponent).join('\n');

  if (chartComponents.length > 0) {
    componentList += `\n\n  // Import chart components from '@aflow/design-system/charts'\n`;
    componentList += chartComponents.map(formatComponent).join('\n');
  }

  const libs = allowedLibraries.join(', ');

  return `AVAILABLE COMPONENTS (${String(filteredComponents.length)} of ${String(contract.components.length)}):
${componentList}

ALLOWED LIBRARIES: ${libs}
CATALOG: ${contract.catalogId} v${contract.catalogVersion}`;
}

/**
 * Build the system prompt for artifact generation (Spec 3).
 */
function buildSystemPrompt(
  kind: ArtifactKind,
  componentName: string,
  requireSampleData: boolean,
): string {
  const responseFields = [
    '  "code": "<full source code>",',
    '  "dataSchema": { <JSON Schema for the data this component expects> },',
    ...(requireSampleData
      ? [
          '  "sampleData": { <realistic sample data matching the schema — enough to fill the UI convincingly> },',
        ]
      : []),
    '  "name": "<component display name>",',
    '  "description": "<one-line description>",',
    '  "warnings": ["<any concerns about the generation>"]',
  ].join('\n');

  const sampleDataInstruction = requireSampleData
    ? '- Provide realistic, plausible sampleData that fills the UI convincingly (5-10 items for lists/tables, real-world values).'
    : '- Do NOT include sampleData when real preview data is provided by the caller.';

  return `You are a UI component generator for the Phoenix design system.

You MUST respond with a valid JSON object containing:
{
${responseFields}
}

DATA MODEL (critical):
- Define a typed interface for the data shape (e.g. interface ArtifactData { items?: Array<...>; title?: string; }).
- ALL primary domain data MUST come from the data prop — NEVER embed large arrays, fixture data, or domain records in source code.
- Small presentational constants (status label maps, color maps, format helpers) may be embedded.
- The dataSchema must describe the full expected shape.
- ${sampleDataInstruction}
- If the caller provides real preview data separately, the runtime will pass that data into the component. Your sampleData is only the fallback preview when no real data is supplied.

CODE RULES:
- Write valid ${kind === 'react_tsx' ? 'TypeScript React (TSX)' : 'JavaScript'} source code.
- Import components from '@aflow/design-system'. Import React from 'react'.
- For chart components (LineChart, BarChart, AreaChart, PieChart, Sparkline), import from '@aflow/design-system/charts'.
- Do NOT import from any other library unless explicitly requested (recharts, katex).
- The default export must be a React component named "${componentName}" that accepts a single prop: { data: ArtifactData }.
- Use design system components over raw HTML elements when a DS component exists.

DEFENSIVE CODING:
- Use optional chaining (?.) when accessing runtime data properties.
- Guard .map() calls: use (data.items ?? []).map() or data.items?.map().
- Handle empty/missing data gracefully — show EmptyState component.
- Never render raw objects — always access specific fields.

LAYOUT:
- Use Column with padding as the root container.
- Use Row/Column/Grid for internal layout with token-friendly spacing (xs, sm, md, lg, xl).
- Use the \`fill\` prop on Row/Column to make a child fill remaining space (flex: 1). Default is hug-content.
- For balanced three-zone rows (e.g. left / center / right): <Row align="center"><Column fill align="end">left</Column><Badge>center</Badge><Column fill>right</Column></Row>
- Use Divider for visual separators — never use Panel as a fake divider line.

COLLECTIONS:
- For repeated homogeneous items, use List + ListItem with structured slots.
- ListItem slots: icon, avatar, title, subtitle, value (trailing text), children (custom trailing).
- List props: dividers (boolean), gap (spacing token).
- Example: <List dividers>{items.map(item => <ListItem key={item.id} title={item.name} subtitle={item.description} value={item.price} />)}</List>

FORMATTING:
- Use Value component for formatted numbers: <Value amount={1234.56} format="currency" />, <Value amount={0.85} format="percent" />, <Value amount={1500000} format="compact" />.

CHARTS (when available):
- Import chart components from '@aflow/design-system/charts' (NOT from '@aflow/design-system').
- ALWAYS provide explicit axis keys — never auto-detect. Example: <LineChart data={data.metrics} xKey="date" yKeys={["revenue", "costs"]} />.
- PieChart uses nameKey and valueKey: <PieChart data={data.distribution} nameKey="category" valueKey="amount" />.
- Sparkline for inline trends: <Sparkline data={data.prices} valueKey="close" height={32} />.

TYPOGRAPHY:
- Use Heading (level={2..4}) for section titles.
- Use Text with color="muted" for secondary content.

IMPORTANT: Respond ONLY with the JSON object. No markdown, no explanation.`;
}

/**
 * Build the user prompt for artifact generation (Spec 3).
 */
function buildUserPrompt(
  prompt: string,
  dsGuidance: string,
  dataSchema: Record<string, unknown>,
  previewData?: Record<string, unknown>,
  styleGuidance?: string,
): string {
  let userPrompt = `Generate a React component for this request:

${prompt}

DESIGN SYSTEM REFERENCE:
${dsGuidance}`;

  if (Object.keys(dataSchema).length > 0) {
    userPrompt += `\n\nEXPECTED DATA SHAPE (authoritative — component must accept this shape):\n${JSON.stringify(dataSchema, null, 2)}`;
  } else {
    userPrompt += `\n\nNo data schema provided — propose a concrete dataSchema in your response that fits this UI.`;
  }

  if (previewData) {
    userPrompt += `\n\nREAL PREVIEW DATA (runtime will pass this exact data for the first preview if it validates against the resolved dataSchema):\n${JSON.stringify(previewData, null, 2)}`;
  }

  if (styleGuidance) {
    userPrompt += `\n\nSTYLE GUIDANCE:\n${styleGuidance}`;
  }

  return userPrompt;
}

/**
 * Parse structured generation output from model response (Spec 1).
 * Falls back to raw-code extraction for robustness.
 */
function parseGenerationOutput(raw: string): GenerationOutput {
  // Try structured JSON parse first
  const trimmed = raw.trim();

  // Strip markdown fences if present
  let cleaned = trimmed;
  cleaned = cleaned.replace(/^```(?:json)?\s*\n/m, '');
  cleaned = cleaned.replace(/\n```\s*$/m, '');

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof parsed['code'] === 'string' && parsed['code'].length > 0) {
      // Fix double-escaped JSON that models sometimes produce when embedding
      // HTML inside a JSON code field. After JSON.parse, the string still contains
      // literal \" and \n sequences instead of actual quotes and newlines.
      let code = parsed['code'];
      if (code.includes('\\"') && code.includes('\\n')) {
        // This is almost certainly a double-escaped string — unescape it
        code = code
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      const out: GenerationOutput = { code };
      if (typeof parsed['dataSchema'] === 'object' && parsed['dataSchema'] !== null) {
        out.dataSchema = parsed['dataSchema'] as Record<string, unknown>;
      }
      if (typeof parsed['sampleData'] === 'object' && parsed['sampleData'] !== null) {
        out.sampleData = parsed['sampleData'] as Record<string, unknown>;
      }
      if (typeof parsed['name'] === 'string') out.name = parsed['name'];
      if (typeof parsed['description'] === 'string') out.description = parsed['description'];
      if (typeof parsed['notes'] === 'object' && parsed['notes'] !== null) {
        out.notes = parsed['notes'] as Record<string, unknown>;
      }
      if (Array.isArray(parsed['warnings'])) {
        out.warnings = (parsed['warnings'] as unknown[]).filter(
          (w): w is string => typeof w === 'string',
        );
      }
      if (Array.isArray(parsed['libraries'])) {
        out.libraries = (parsed['libraries'] as unknown[]).filter(
          (l): l is string => typeof l === 'string',
        );
      }
      if (
        typeof parsed['definition'] === 'object' &&
        parsed['definition'] !== null &&
        !Array.isArray(parsed['definition'])
      ) {
        out.definition = parsed['definition'] as Record<string, unknown>;
      }
      return out;
    }
  } catch {
    // Fall through to raw extraction
  }

  // Fallback 1: try to extract "code" field from malformed JSON (broken by embedded backticks etc.)
  const codeFieldMatch = /"code"\s*:\s*"((?:[^"\\]|\\.)*)"/s.exec(trimmed);
  if (codeFieldMatch?.[1]) {
    try {
      // Unescape JSON string escapes
      const extracted = JSON.parse(`"${codeFieldMatch[1]}"`) as string;
      if (extracted.length > 10) {
        return { code: extracted };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback 2: extract content from code fences
  const fenceMatch = /```(?:html|svg|tsx?|jsx?|typescript|javascript)?\s*\n([\s\S]*?)\n```/.exec(
    trimmed,
  );
  if (fenceMatch?.[1] && fenceMatch[1].trim().length > 10) {
    return { code: fenceMatch[1].trim() };
  }

  // Fallback 3: treat entire response as code (strip markdown fences)
  let source = trimmed;
  source = source.replace(/^```(?:tsx?|jsx?|typescript|javascript|html|svg)?\s*\n/m, '');
  source = source.replace(/\n```\s*$/m, '');

  return { code: source.trim() };
}

/**
 * Generate artifact source via AI with structured output (Specs 1-3, 5-7).
 */
async function generateWithAI(
  ctx: ExecutorContext,
  prompt: string,
  kind: ArtifactKind,
  inputDataSchema: Record<string, unknown>,
  inputSchemaProvenance: Extract<SchemaProvenance, 'user_supplied' | 'data_inferred'> | undefined,
  previewData: Record<string, unknown> | undefined,
  allowedLibraries: string[],
  name?: string,
  model?: string,
  styleGuidance?: string,
  appletLibraries?: AppletLibrary[],
  illustrationConfig?: IllustrationConfig,
  emitAppletDefinition?: boolean,
): Promise<GenerationResult> {
  // Already resolved by the caller; a second scan here would re-probe every
  // candidate's credential for the same artifact.
  const kindModelDefault =
    kind === 'applet' || kind === 'illustration' ? DEFAULT_APPLET_MODEL : DEFAULT_UI_MODEL;
  const resolvedModel = model ?? kindModelDefault;
  const componentName = name
    ? name.replace(/[^a-zA-Z0-9]/g, '').replace(/^[a-z]/, (c) => c.toUpperCase()) || 'Artifact'
    : 'Artifact';

  let systemPrompt: string;
  let userPrompt: string;

  if (kind === 'applet') {
    // Applet: creativity-first prompt with library access hints
    systemPrompt = buildAppletSystemPrompt(
      appletLibraries ?? [],
      componentName,
      previewData == null,
    );
    userPrompt = buildAppletUserPrompt(
      prompt,
      appletLibraries ?? [],
      inputDataSchema,
      previewData,
      styleGuidance,
    );
  } else if (kind === 'illustration') {
    // Illustration: SVG specialist prompt
    systemPrompt = buildIllustrationSystemPrompt(
      illustrationConfig,
      componentName,
      previewData == null,
    );
    userPrompt = buildIllustrationUserPrompt(
      prompt,
      illustrationConfig,
      inputDataSchema,
      previewData,
      styleGuidance,
    );
  } else {
    // DS-bound artifacts: design system guidance + catalog
    const dsGuidance = buildDsGuidance(prompt, allowedLibraries);
    systemPrompt = buildSystemPrompt(kind, componentName, previewData == null);
    userPrompt = buildUserPrompt(prompt, dsGuidance, inputDataSchema, previewData, styleGuidance);
  }

  if (emitAppletDefinition === true && (kind === 'applet' || kind === 'react_tsx')) {
    systemPrompt += buildAppletDefinitionPromptSection(kind);
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const client = await getAIClientForContext(ctx, resolvedModel);
  // Applets and illustrations need more tokens — code is wrapped in JSON and can be complex
  const maxTokens = kind === 'applet' || kind === 'illustration' ? 16384 : 8192;
  const response = await client.generateText({
    model: resolvedModel,
    messages,
    maxTokens,
    temperature: 0.3,
    tenantId: ctx.tenantId,
    runId: ctx.runId,
    stepExecutionId: ctx.stepExecutionId,
  });

  // All kinds use the same JSON envelope: { code, name, description, dataSchema?, sampleData? }
  // - DS artifacts: code is React/TSX or JS source
  // - Applets: code is a complete HTML document (<!DOCTYPE html>...</html>)
  // - Illustrations: code is a complete SVG element (<svg>...</svg>)
  const genOutput = parseGenerationOutput(response.content ?? '');

  const hasInputSchema = Object.keys(inputDataSchema).length > 0;
  let resolvedDataSchema: Record<string, unknown>;
  let schemaProvenance: SchemaProvenance;

  if (hasInputSchema) {
    resolvedDataSchema = inputDataSchema;
    schemaProvenance = inputSchemaProvenance ?? 'user_supplied';
  } else if (genOutput.dataSchema && Object.keys(genOutput.dataSchema).length > 0) {
    resolvedDataSchema = genOutput.dataSchema;
    schemaProvenance = 'model_proposed';
  } else {
    resolvedDataSchema = inferDataSchema(prompt);
    schemaProvenance = 'fallback_inferred';
  }

  const usage = extractUsage(response);
  const result: GenerationResult = {
    source: genOutput.code,
    resolvedDataSchema,
    schemaProvenance,
    model: resolvedModel,
    attemptCount: 1,
    repaired: false,
    ...(usage ? { usage } : {}),
  };
  if (genOutput.sampleData) result.sampleData = genOutput.sampleData;
  if (genOutput.name) result.resolvedName = genOutput.name;
  if (genOutput.description) result.resolvedDescription = genOutput.description;
  if (genOutput.notes) result.modelNotes = genOutput.notes;
  if (genOutput.warnings) result.modelWarnings = genOutput.warnings;
  if (genOutput.libraries) result.declaredLibraries = genOutput.libraries;
  if (genOutput.definition) result.definitionCandidate = genOutput.definition;
  return result;
}

/**
 * Security validation plus the iframe document for one applet draft. The
 * generate and repair passes differ only in which source they are holding.
 */
async function buildAppletDraft(
  source: string,
  libraries: AppletLibrary[],
  sampleData: Record<string, unknown> | undefined,
): Promise<{ valid: boolean; diagnostics: ValidationDiagnostic[]; standaloneHtml?: string }> {
  const security = validateApplet(source);
  if (!security.valid) return { valid: false, diagnostics: security.diagnostics };

  const built = await buildAppletViewHtml(source, libraries, {
    catalogComponentNames: getCatalogComponentNames(),
    ...(sampleData !== undefined ? { sampleData } : {}),
  });
  const diagnostics = [...security.diagnostics, ...built.diagnostics];
  return {
    valid: built.html !== null && !diagnostics.some((d) => d.severity === 'error'),
    diagnostics,
    ...(built.html !== null ? { standaloneHtml: built.html } : {}),
  };
}

/**
 * Attempt a single repair round on failed code (Spec 5).
 */
async function attemptRepair(
  ctx: ExecutorContext,
  originalSource: string,
  diagnostics: Array<{
    severity: string;
    code: string;
    message: string;
    line?: number | undefined;
  }>,
  kind: ArtifactKind,
  model: string,
): Promise<{ source: string | null; usage?: AIUsageData }> {
  const client = await getAIClientForContext(ctx, model);

  const diagText = diagnostics
    .map(
      (d) =>
        `[${d.severity.toUpperCase()}] ${d.code}: ${d.message}${d.line != null ? ` (line ${String(d.line)})` : ''}`,
    )
    .join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a code repair assistant. Fix ONLY the reported issues in the code below.
Do NOT change working logic. Do NOT add features. Output ONLY the corrected source code.
No markdown fences, no explanations.`,
    },
    {
      role: 'user',
      content: `The following code has validation errors. Fix them.

ERRORS:
${diagText}

CODE:
${originalSource}`,
    },
  ];

  try {
    const response = await client.generateText({
      model,
      messages,
      maxTokens: 8192,
      temperature: 0.1,
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.stepExecutionId,
    });

    let repaired = response.content ?? '';
    repaired = repaired.replace(/^```(?:tsx?|jsx?|typescript|javascript)?\s*\n/m, '');
    repaired = repaired.replace(/\n```\s*$/m, '');
    const usage = extractUsage(response);
    return usage ? { source: repaired.trim() || null, usage } : { source: repaired.trim() || null };
  } catch {
    return { source: null };
  }
}

// ============================================================================
// DB row types
// ============================================================================

interface ArtifactRow {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  space_id: string;
  current_version: number;
  catalog_id: string;
  catalog_version: string;
  catalog_hash: string;
  tags: unknown;
  created_at: string;
  updated_at: string;
}

interface BundleProvenanceRow {
  artifact_id: string;
  bundle_id: string;
  binding_id: string;
  installed_content_hash: string | null;
  current_content_hash: string;
}

interface VersionRow {
  id: string;
  artifact_id: string;
  version: number;
  source_ref: string;
  compiled_ref: string;
  html_ref: string;
  content_hash: string;
  prompt: string;
  data_schema: unknown;
  validation_report: unknown;
  parent_version_id: string | null;
  created_at: string;
}

// ============================================================================
// Handler
// ============================================================================

export interface UiArtifactHandlerDeps {
  sqlClient: postgres.Sql;
  payloadStore: PayloadStore;
  db: ReturnType<typeof getDatabase>;
  /** Realtime fanout for applet actions; without it agent writes leave mounted views stale. */
  publishAppletDelta?: AppletDeltaPublisher;
}

export class UiArtifactHandler implements StepHandler {
  readonly stepType = 'ui';
  private readonly sql: postgres.Sql;
  private readonly payloadStore: PayloadStore;
  private readonly surfaceHandler = new SurfaceHandler();
  private readonly appletHandler: AppletHandler;

  constructor(deps: UiArtifactHandlerDeps) {
    this.sql = deps.sqlClient;
    this.payloadStore = deps.payloadStore;
    this.appletHandler = new AppletHandler(
      (tenantId) => createAppletPersistence(deps.db, createTenantContext(tenantId)),
      deps.publishAppletDelta,
      async (ctx, { spaceId, draftId }) => {
        const result = await publishDraftCore(this.publishCoreDeps(ctx), {
          spaceId,
          draftId,
          runId: ctx.runId,
          stepExecutionId: ctx.stepExecutionId,
          requireAppletDefinition: true,
        });
        if (!result.ok) return result;
        return { ok: true, artifactVersionId: result.versionId };
      },
    );
  }

  async validate(ctx: ExecutorContext): Promise<AflowError | null> {
    const input = await ctx.readPayload(ctx.job.inputRef);
    if (typeof input !== 'object' || input === null) {
      return validationError('Input must be an object');
    }
    return null;
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const operationId = ctx.operationId;
    const rawInput = await ctx.readPayload(ctx.job.inputRef);
    if (typeof rawInput !== 'object' || rawInput === null) {
      return await failureWithError(ctx, validationError('Input must be an object'));
    }
    const input = rawInput as Record<string, unknown>;

    try {
      switch (operationId) {
        case 'ui.catalog.get':
          return await this.handleCatalogGet(ctx, input);
        case 'ui.artifact.generate':
          return await this.handleGenerate(ctx, input);
        case 'ui.artifact.publish':
          return await this.handlePublish(ctx, input);
        case 'ui.artifact.get':
          return await this.handleGet(ctx, input);
        case 'ui.artifact.list':
          return await this.handleList(ctx, input);
        case 'ui.artifact.render':
          return await this.handleRender(ctx, input);
        case 'ui.surface.visualize':
          return await this.surfaceHandler.execute(ctx);
        case 'ui.applet.instantiate':
        case 'ui.applet.get':
        case 'ui.applet.act':
        case 'ui.applet.list':
          return await this.appletHandler.execute(ctx);
        default:
          return await failureWithError(
            ctx,
            validationError(`Unsupported operation: ${operationId}`),
          );
      }
    } catch (err) {
      return await failureWithError(
        ctx,
        internalError(err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private schemaName(ctx: ExecutorContext): string {
    return tenantIdToSchemaName(ctx.tenantId);
  }

  private async withSchema<T>(
    ctx: ExecutorContext,
    fn: (sql: postgres.Sql) => Promise<T>,
  ): Promise<T> {
    const schema = this.schemaName(ctx);
    const result = await this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schema}", public`);
      return await fn(tx as unknown as postgres.Sql);
    });
    return result as T;
  }

  private publishCoreDeps(ctx: ExecutorContext): PublishCoreDeps {
    return {
      withSchema: (fn) => this.withSchema(ctx, fn),
      loadBlob: (ref) => this.loadBlob(ref),
      captureHermeticApplet: (draftHtml) =>
        captureHermeticApplet(
          {
            fetchAsset: defaultAppletAssetFetcher,
            storeBlob: (content) => this.storeCapturedAsset(ctx, content),
          },
          draftHtml,
        ),
    };
  }

  /**
   * A payload path is deterministic per (step, attempt, kind), so every blob a
   * step keeps needs its own kind. All three of these were written as 'output'
   * — one path, three writes — so an artifact's stored source was whatever the
   * step wrote last, which is its html.
   */
  private async storeBlob(
    ctx: ExecutorContext,
    data: string,
    kind: 'artifact_source' | 'artifact_compiled' | 'artifact_html',
  ): Promise<string> {
    const ref = await this.payloadStore.store({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.stepExecutionId,
      attempt: ctx.attempt,
      kind,
      data,
      persist: isDurablePayloadKind(kind),
    });
    return ref;
  }

  /**
   * A captured asset is one of N written by a single step, and a step-scoped
   * path can only name one of them — so they are addressed by their own bytes.
   * Nothing enumerates kinds far enough to give N assets N paths.
   *
   * `persist` because the row that records the capture outlives any TTL the
   * backend would otherwise put on the object.
   */
  private async storeCapturedAsset(ctx: ExecutorContext, data: string): Promise<string> {
    return this.payloadStore.storeContentAddressed({
      tenantId: ctx.tenantId,
      contentHash: contentAddressForJson(data),
      kind: 'artifact_html',
      persist: true,
      data,
    });
  }

  private async loadBlob(ref: string): Promise<string> {
    const data = await this.payloadStore.retrieve(ref);
    return typeof data === 'string' ? data : JSON.stringify(data);
  }

  private async lazyCompileVersion(opts: {
    ctx: ExecutorContext;
    versionId: string;
    sourceRef: string;
    kind: string;
  }): Promise<{ compiledRef: string | null; htmlRef: string }> {
    if (opts.kind !== 'react_tsx' && opts.kind !== 'html_js' && opts.kind !== 'applet') {
      throw new Error(
        `Lazy compile does not support kind=${opts.kind} (version ${opts.versionId}). ` +
          `Bundle seeds must use 'react_tsx', 'html_js' or 'applet'.`,
      );
    }
    const source = await this.loadBlob(opts.sourceRef);
    const failed = (diagnostics: ValidationDiagnostic[]): Error => {
      const detail = diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => d.message)
        .join('; ');
      return new Error(
        `Lazy compile failed for version ${opts.versionId}: ${detail || 'unknown error'}`,
      );
    };

    let compiledCode: string | null;
    let html: string;
    if (opts.kind === 'applet') {
      const built = await buildAppletViewHtml(source, [], {
        catalogComponentNames: getCatalogComponentNames(),
      });
      if (built.html === null) throw failed(built.diagnostics);
      compiledCode = built.compiledCode ?? null;
      html = built.html;
    } else {
      const result = await validateAndCompile(source, opts.kind, [], getCatalogComponentNames());
      if (!result.valid || !result.compiledCode || !result.standaloneHtml) {
        throw failed(result.diagnostics);
      }
      compiledCode = result.compiledCode;
      html = result.standaloneHtml;
    }

    // A plain-DOM applet ships as the module it already is, so there is no
    // compiled form to store and the column keeps whatever it held.
    const compiledRef =
      compiledCode === null
        ? null
        : await this.storeBlob(opts.ctx, compiledCode, 'artifact_compiled');
    const htmlRef = await storeArtifactViewHtml(this.payloadStore, opts.ctx.tenantId, html);
    await this.withSchema(opts.ctx, async (sql) => {
      await sql`
        UPDATE ui_artifact_versions
          SET compiled_ref = COALESCE(${compiledRef}, compiled_ref), html_ref = ${htmlRef}
          WHERE id = ${opts.versionId}::uuid
      `;
    });
    return { compiledRef, htmlRef };
  }

  // ── ui.catalog.get ─────────────────────────────────────────────────────

  private async handleCatalogGet(
    ctx: ExecutorContext,
    input: Record<string, unknown>,
  ): Promise<StepResult> {
    loadFullBundles();

    const mode = (input['mode'] as string) ?? 'artifact';
    const categories = input['categories'] as string[] | undefined;
    const componentFilter = input['components'] as string[] | undefined;
    const libraryFilter = input['libraries'] as string[] | undefined;
    const includeTokens = input['includeTokens'] !== false;
    const includeExamples = input['includeExamples'] !== false;
    const compact = input['compact'] === true;

    // Compact mode — apply filters to the compact bundle too
    if (compact) {
      const base = mode === 'surface' ? compactSurfaceBundle! : compactArtifactBundle!;
      const filtered = applyCompactFilters(
        base,
        categories,
        componentFilter,
        libraryFilter,
        includeTokens,
        includeExamples,
      );
      return await successWithData(ctx, { bundle: filtered });
    }

    const base = mode === 'surface' ? surfaceBundle! : artifactBundle!;

    // Apply filters
    let components = base.components;
    if (categories && categories.length > 0) {
      const catSet = new Set(categories);
      components = components.filter((c) => catSet.has(c.category));
    }
    if (componentFilter && componentFilter.length > 0) {
      const nameSet = new Set(componentFilter);
      components = components.filter((c) => nameSet.has(c.name));
    }

    // Strip examples if not requested
    if (!includeExamples) {
      components = components.map((c) => {
        const { examples: _e, guidance: _g, ...rest } = c;
        return rest;
      });
    }

    // Filter libraries
    let libraries = base.libraries;
    if (libraryFilter && libraryFilter.length > 0) {
      const libSet = new Set(libraryFilter);
      libraries = libraries.filter((l) => libSet.has(l.id));
    }

    const result: Record<string, unknown> = {
      catalogId: base.catalogId,
      catalogVersion: base.catalogVersion,
      catalogHash: base.catalogHash,
      generatedAt: base.generatedAt,
      designSystemVersion: base.designSystemVersion,
      mode: base.mode,
      components,
      libraries,
    };

    if (includeTokens) {
      result['tokens'] = base.tokens;
    }

    if (base.surfaceComponents) {
      result['surfaceComponents'] = base.surfaceComponents;
    }

    ctx.log.info('Catalog get completed', { mode, componentCount: components.length });
    return await successWithData(ctx, { bundle: result });
  }

  // ── ui.artifact.generate ────────────────────────────────────────────────

  private async handleGenerate(
    ctx: ExecutorContext,
    input: Record<string, unknown>,
  ): Promise<StepResult> {
    const prompt = input['prompt'] as string;
    const artifactKind = (input['artifactKind'] as ArtifactKind) ?? 'react_tsx';
    const isApplet = artifactKind === 'applet';
    const isIllustration = artifactKind === 'illustration';
    const appletRequested = input['applet'] === true;
    if (appletRequested && !isApplet && artifactKind !== 'react_tsx') {
      return await failureWithError(
        ctx,
        validationError(
          `applet: true requires artifactKind 'react_tsx' or 'applet' — got '${artifactKind}'`,
        ),
      );
    }
    const allowedLibraries = (input['allowedLibraries'] as string[]) ?? [
      'phoenix-design-system',
      'phoenix-icons',
    ];
    // Applet-specific: resolve requested third-party libraries
    const appletLibraries: AppletLibrary[] = isApplet
      ? ((input['libraries'] as AppletLibrary[]) ?? [])
      : [];
    // Illustration-specific config
    const illustrationConfig = isIllustration
      ? (input['illustrationConfig'] as IllustrationConfig | undefined)
      : undefined;

    const inputDataSchema = (input['dataSchema'] as Record<string, unknown>) ?? {};
    const rawInputData = input['data'];
    const inputPreviewData = Array.isArray(rawInputData)
      ? ({ items: rawInputData } as Record<string, unknown>)
      : typeof rawInputData === 'object' && rawInputData !== null
        ? (rawInputData as Record<string, unknown>)
        : undefined;
    if (Array.isArray(rawInputData)) {
      ctx.log.info('Auto-wrapped array data as { items: [...] }', {
        itemCount: rawInputData.length,
      });
    }
    const name = input['name'] as string | undefined;
    const description = input['description'] as string | undefined;
    const artifactId = input['artifactId'] as string | undefined;
    const model = input['model'] as string | undefined;
    const styleGuidance = input['styleGuidance'] as string | undefined;

    const artifactIdError = validateOptionalUuidInput('artifactId', artifactId);
    if (artifactIdError) {
      return await failureWithError(ctx, artifactIdError);
    }

    const hasExplicitInputSchema = Object.keys(inputDataSchema).length > 0;
    const authoritativeInputSchema = hasExplicitInputSchema
      ? inputDataSchema
      : inputPreviewData
        ? inferDataSchemaFromData(inputPreviewData).schema
        : {};
    const authoritativeInputSchemaProvenance: SchemaProvenance = hasExplicitInputSchema
      ? 'user_supplied'
      : inputPreviewData
        ? 'data_inferred'
        : 'fallback_inferred';

    if (inputPreviewData && hasExplicitInputSchema) {
      const inputValidation = validateDataAgainstSchema(authoritativeInputSchema, inputPreviewData);
      if (!inputValidation.valid) {
        const detail = inputValidation.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join('; ');
        return await failureWithError(
          ctx,
          validationError(`data does not match dataSchema: ${detail}`),
        );
      }
    }

    // Space-boundary invariant: spaceId is system-carried from the
    // originating session (never caller-supplied). Absent = platform bug.
    const spaceId = ctx.spaceId;
    if (!spaceId) {
      return await failureWithError(
        ctx,
        validationError(
          'execution context is missing spaceId — artifact generation runs only in the originating session space (platform invariant)',
        ),
      );
    }

    // ── Generate source ──────────────────────────────────────────────────
    let genResult: GenerationResult;
    const kindDefault = isApplet || isIllustration ? DEFAULT_APPLET_MODEL : DEFAULT_UI_MODEL;
    const resolvedModel = await resolveGenerationModel(ctx, [
      model,
      ctx.callerModel,
      process.env['UI_GEN_MODEL'],
      kindDefault,
    ]);

    if (resolvedModel !== null) {
      ctx.log.info('Generating artifact source with AI', { model: resolvedModel });
      try {
        genResult = await generateWithAI(
          ctx,
          prompt,
          artifactKind,
          authoritativeInputSchema,
          Object.keys(authoritativeInputSchema).length > 0
            ? authoritativeInputSchemaProvenance === 'fallback_inferred'
              ? undefined
              : authoritativeInputSchemaProvenance
            : undefined,
          inputPreviewData,
          allowedLibraries,
          name,
          resolvedModel,
          styleGuidance,
          appletLibraries,
          illustrationConfig,
          appletRequested,
        );
      } catch (err) {
        ctx.log.warn('AI generation failed, falling back to template', {
          error: err instanceof Error ? err.message : String(err),
        });
        genResult = {
          source: generateTemplateSource(prompt, artifactKind, authoritativeInputSchema, name),
          resolvedDataSchema:
            Object.keys(authoritativeInputSchema).length > 0
              ? authoritativeInputSchema
              : inferDataSchema(prompt),
          schemaProvenance:
            Object.keys(authoritativeInputSchema).length > 0
              ? authoritativeInputSchemaProvenance
              : 'fallback_inferred',
          model: resolvedModel,
          attemptCount: 1,
          repaired: false,
        };
      }
    } else {
      ctx.log.warn('No AI provider configured — using template fallback');
      genResult = {
        source: generateTemplateSource(prompt, artifactKind, authoritativeInputSchema, name),
        resolvedDataSchema:
          Object.keys(authoritativeInputSchema).length > 0
            ? authoritativeInputSchema
            : inferDataSchema(prompt),
        schemaProvenance:
          Object.keys(authoritativeInputSchema).length > 0
            ? authoritativeInputSchemaProvenance
            : 'fallback_inferred',
        model: 'template',
        attemptCount: 0,
        repaired: false,
      };
    }

    let previewData: Record<string, unknown> | undefined;
    let previewDataSource: PreviewDataSource = 'none';
    let previewValidationDiagnostics: ValidationDiagnostic[] = [];

    if (inputPreviewData) {
      const previewValidation = validateDataAgainstSchema(
        genResult.resolvedDataSchema,
        inputPreviewData,
      );
      if (previewValidation.valid) {
        previewData = inputPreviewData;
        previewDataSource = 'input';
      } else {
        previewValidationDiagnostics = previewValidation.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          message: `Preview data invalid: ${diagnostic.message}`,
        }));
      }
    } else if (genResult.sampleData) {
      const previewValidation = validateDataAgainstSchema(
        genResult.resolvedDataSchema,
        genResult.sampleData,
      );
      if (previewValidation.valid) {
        previewData = genResult.sampleData;
        previewDataSource = 'sample';
      } else {
        previewValidationDiagnostics = previewValidation.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          message: `Generated sampleData invalid: ${diagnostic.message}`,
        }));
      }
    }

    // ── Validation + compile ────────────────────────────────────────────
    let validationResult: {
      valid: boolean;
      diagnostics: ValidationDiagnostic[];
      compiledCode?: string;
      standaloneHtml?: string;
    };

    if (isApplet) {
      // Applet: security-only validation, then wrap in our HTML template
      // Merge user-requested + model-declared libraries (deduplicated)
      const modelLibs = (genResult.declaredLibraries ?? []).filter(
        (l): l is AppletLibrary => l in APPLET_LIBRARY_REGISTRY,
      );
      const resolvedLibs: AppletLibrary[] = [...new Set([...appletLibraries, ...modelLibs])];
      validationResult = await buildAppletDraft(genResult.source, resolvedLibs, previewData);
    } else if (isIllustration) {
      // Illustration: SVG-specific validation (no JS, no external refs)
      const illustResult = validateIllustration(genResult.source);
      // Wrap SVG in minimal HTML for htmlRef storage compatibility
      const illustHtml = illustResult.valid ? wrapIllustrationHtml(genResult.source) : null;
      validationResult = {
        valid: illustResult.valid,
        diagnostics: illustResult.diagnostics,
        ...(illustHtml != null ? { standaloneHtml: illustHtml } : {}),
      };
    } else {
      // DS artifacts (react_tsx, html_js): AST validation + import/component/esbuild pipeline
      const dsKind = artifactKind;
      const astDiags = runAstValidation(genResult.source);
      const compileResult = await validateAndCompile(
        genResult.source,
        dsKind,
        allowedLibraries,
        getCatalogComponentNames(),
        previewData,
      );
      validationResult = {
        valid: compileResult.valid && !astDiags.some((d) => d.severity === 'error'),
        diagnostics: [...astDiags, ...compileResult.diagnostics],
        ...(compileResult.compiledCode != null ? { compiledCode: compileResult.compiledCode } : {}),
        ...(compileResult.standaloneHtml != null
          ? { standaloneHtml: compileResult.standaloneHtml }
          : {}),
      };
    }

    const allDiagnostics = [...validationResult.diagnostics];
    const preRepairDiagnostics = [...allDiagnostics];

    // ── Repair round (Spec 5) ────────────────────────────────────────────
    const hasErrors = allDiagnostics.some((d) => d.severity === 'error');
    if (
      hasErrors &&
      genResult.model !== 'template' &&
      (await hasResolvableProvider(ctx, genResult.model))
    ) {
      ctx.log.info('First-pass validation failed, attempting repair', {
        errorCount: allDiagnostics.filter((d) => d.severity === 'error').length,
      });

      const repairResult = await attemptRepair(
        ctx,
        genResult.source,
        allDiagnostics,
        artifactKind,
        genResult.model,
      );
      if (repairResult.usage) {
        const merged = mergeUsage(genResult.usage, repairResult.usage);
        if (merged) {
          genResult.usage = merged;
        }
      }

      if (repairResult.source) {
        const repairedSource = repairResult.source;
        let repairedResult: typeof validationResult;

        if (isApplet) {
          repairedResult = await buildAppletDraft(repairedSource, appletLibraries, previewData);
        } else if (isIllustration) {
          const illustResult = validateIllustration(repairedSource);
          const illustHtml = illustResult.valid ? wrapIllustrationHtml(repairedSource) : null;
          repairedResult = {
            valid: illustResult.valid,
            diagnostics: illustResult.diagnostics,
            ...(illustHtml != null ? { standaloneHtml: illustHtml } : {}),
          };
        } else {
          const dsKind = artifactKind;
          const repairedAstDiags = runAstValidation(repairedSource);
          const repairedCompile = await validateAndCompile(
            repairedSource,
            dsKind,
            allowedLibraries,
            getCatalogComponentNames(),
            previewData,
          );
          repairedResult = {
            valid: repairedCompile.valid && !repairedAstDiags.some((d) => d.severity === 'error'),
            diagnostics: [...repairedAstDiags, ...repairedCompile.diagnostics],
            ...(repairedCompile.compiledCode != null
              ? { compiledCode: repairedCompile.compiledCode }
              : {}),
            ...(repairedCompile.standaloneHtml != null
              ? { standaloneHtml: repairedCompile.standaloneHtml }
              : {}),
          };
        }

        const repairedErrors = repairedResult.diagnostics.filter(
          (d) => d.severity === 'error',
        ).length;
        const originalErrors = allDiagnostics.filter((d) => d.severity === 'error').length;

        if (repairedErrors < originalErrors) {
          genResult.source = repairedSource;
          genResult.attemptCount = 2;
          genResult.repaired = true;
          validationResult = repairedResult;
          allDiagnostics.length = 0;
          allDiagnostics.push(...repairedResult.diagnostics);
          ctx.log.info('Repair succeeded', {
            originalErrors,
            repairedErrors,
          });
        } else {
          ctx.log.info('Repair did not improve validation', {
            originalErrors,
            repairedErrors,
          });
        }
      }
    }

    // ── Applet definition (after source repair, so it aligns with the final code) ──
    let appletDefinition: AppletDefinition | undefined;
    if (appletRequested) {
      let definitionRepair: AppletDefinitionRepairFn | undefined;
      if (genResult.model !== 'template' && (await hasResolvableProvider(ctx, genResult.model))) {
        const repairModel = genResult.model;
        definitionRepair = async (repairMessages) => {
          const client = await getAIClientForContext(ctx, repairModel);
          const response = await client.generateText({
            model: repairModel,
            messages: repairMessages,
            maxTokens: 8192,
            temperature: 0.1,
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            stepExecutionId: ctx.stepExecutionId,
          });
          const repairUsage = extractUsage(response);
          return {
            content: response.content ?? null,
            ...(repairUsage ? { usage: repairUsage } : {}),
          };
        };
      }
      const definitionResult = await resolveAppletDefinition({
        candidate: genResult.definitionCandidate,
        source: genResult.source,
        ...(definitionRepair ? { repair: definitionRepair } : {}),
      });
      if (definitionResult.usage) {
        const merged = mergeUsage(genResult.usage, definitionResult.usage);
        if (merged) genResult.usage = merged;
      }
      if (definitionResult.diagnostics.length > 0) {
        allDiagnostics.push(...definitionResult.diagnostics);
      }
      if (definitionResult.definition === undefined) {
        ctx.log.info('Applet definition validation failed', {
          errorCount: definitionResult.diagnostics.length,
          repaired: definitionResult.repaired,
        });
      }
      appletDefinition = definitionResult.definition;
    }

    // ── Persist ──────────────────────────────────────────────────────────
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const contract = loadContract();
    const finalValid =
      !allDiagnostics.some((d) => d.severity === 'error') && validationResult.valid;

    const resolvedName = name ?? genResult.resolvedName;
    const resolvedDescription = description ?? genResult.resolvedDescription;

    // Spec 6: richer validation report with phase grouping
    const validationReport = {
      valid: finalValid,
      diagnostics: allDiagnostics,
      preRepairDiagnostics: genResult.repaired ? preRepairDiagnostics : undefined,
      checkedAt: now.toISOString(),
    };
    const previewValidation =
      previewValidationDiagnostics.length > 0 || previewDataSource !== 'none'
        ? {
            valid: previewValidationDiagnostics.length === 0,
            diagnostics: previewValidationDiagnostics,
            checkedAt: now.toISOString(),
          }
        : undefined;

    // Spec 6: generation metadata
    const generationMeta = {
      model: genResult.model,
      attemptCount: genResult.attemptCount,
      repaired: genResult.repaired,
      schemaProvenance: genResult.schemaProvenance,
      modelNotes: genResult.modelNotes,
      modelWarnings: genResult.modelWarnings,
    };

    // Store source + compiled + html in PayloadStore
    const sourceRef = await this.storeBlob(ctx, genResult.source, 'artifact_source');
    let compiledRef: string | null = null;
    let htmlRef: string | null = null;
    if (validationResult.compiledCode) {
      compiledRef = await this.storeBlob(ctx, validationResult.compiledCode, 'artifact_compiled');
    }
    if (validationResult.standaloneHtml) {
      htmlRef = await storeArtifactViewHtml(
        this.payloadStore,
        ctx.tenantId,
        validationResult.standaloneHtml,
      );
    }

    // Persist draft to DB
    const draftRows = (await this.withSchema(ctx, async (sql) => {
      return await sql`
        INSERT INTO ui_artifact_drafts (
          artifact_id, kind, space_id, prompt, source_ref, compiled_ref, html_ref,
          data_schema, validation_report, catalog_id, catalog_version, catalog_hash,
          status, applet_definition, created_by_session_id, created_by_step_execution_id, expires_at
        ) VALUES (
          ${artifactId ?? null}, ${artifactKind}, ${spaceId}::uuid, ${prompt}, ${sourceRef},
          ${compiledRef}, ${htmlRef}, ${JSON.stringify(genResult.resolvedDataSchema)}::jsonb,
          ${JSON.stringify({ ...validationReport, generation: generationMeta })}::jsonb,
          ${contract.catalogId}, ${contract.catalogVersion}, ${contract.catalogHash},
          ${finalValid ? 'draft' : 'failed'},
          ${appletDefinition !== undefined ? JSON.stringify(appletDefinition) : null}::jsonb,
          ${ctx.runId}::uuid, ${ctx.stepExecutionId}::uuid, ${expiresAt.toISOString()}::timestamptz
        ) RETURNING *
      `;
    })) as DraftRow[];

    const draft = draftRows[0]!;
    const draftId = draft.id;

    // Also store source as step output payload
    const stepSourceRef = await ctx.writePayload('output', genResult.source);

    const outputDraft = {
      draftId,
      artifactId,
      // Persisted record scope is system-stamped from the execution context.
      scope: { spaceId },
      name: resolvedName,
      description: resolvedDescription,
      kind: artifactKind,
      prompt,
      dataSchema: genResult.resolvedDataSchema,
      catalogId: contract.catalogId,
      catalogVersion: contract.catalogVersion,
      catalogHash: contract.catalogHash,
      allowedLibraries,
      sourceRef: stepSourceRef,
      compiledRef: compiledRef ?? undefined,
      warnings: allDiagnostics.filter((d) => d.severity === 'warning'),
      errors: allDiagnostics.filter((d) => d.severity === 'error'),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: draft.status,
    };

    // Include html + rendererMetadata + source at top level when compilation succeeded
    const output: Record<string, unknown> = {
      draft: outputDraft,
      validationReport,
      generation: generationMeta,
      dataSchema: genResult.resolvedDataSchema,
      diagnostics: allDiagnostics,
      previewDataSource,
    };
    if (genResult.sampleData) {
      output['sampleData'] = genResult.sampleData;
    }
    if (previewValidation) {
      output['previewValidation'] = previewValidation;
    }
    if (previewData) {
      output['previewData'] = previewData;
      output['data'] = previewData;
    }
    if (validationResult.standaloneHtml) {
      output['html'] = validationResult.standaloneHtml;
      output['source'] = genResult.source;
      output['rendererMetadata'] = {
        draftId,
        ...(artifactId != null ? { artifactId } : {}),
        ...(resolvedName != null ? { name: resolvedName } : {}),
        kind: artifactKind,
        catalogVersion: contract.catalogVersion,
        dataSchemaValid: previewValidationDiagnostics.length === 0,
      };
    }
    // Illustration: include raw SVG for inline rendering
    if (isIllustration && validationResult.valid) {
      output['svg'] = genResult.source;
    }
    if (appletDefinition !== undefined) {
      output['appletDefinition'] = appletDefinition;
    }

    if (genResult.usage) {
      return await successWithData(ctx, output, { costJson: { ...genResult.usage } });
    }
    return await successWithData(ctx, output);
  }

  // ── ui.artifact.publish ─────────────────────────────────────────────────

  private async handlePublish(
    ctx: ExecutorContext,
    input: Record<string, unknown>,
  ): Promise<StepResult> {
    const draftId = input['draftId'] as string;
    const artifactId = input['artifactId'] as string | undefined;
    const name = input['name'] as string | undefined;
    const description = input['description'] as string | undefined;
    const tags = input['tags'] as string[] | undefined;

    const spaceId = ctx.spaceId;
    if (!spaceId) {
      return await failureWithError(
        ctx,
        validationError(
          'execution context is missing spaceId — ui.artifact.publish runs only in the originating session space (platform invariant)',
        ),
      );
    }

    const draftIdError = validateOptionalUuidInput('draftId', draftId);
    if (draftIdError) {
      return await failureWithError(ctx, draftIdError);
    }
    const artifactIdError = validateOptionalUuidInput('artifactId', artifactId);
    if (artifactIdError) {
      return await failureWithError(ctx, artifactIdError);
    }

    const now = new Date();
    const coreResult = await publishDraftCore(this.publishCoreDeps(ctx), {
      spaceId,
      draftId,
      artifactId,
      name,
      description,
      tags,
      runId: ctx.runId,
      stepExecutionId: ctx.stepExecutionId,
    });
    if (!coreResult.ok) {
      return await failureWithError(ctx, coreResult.error);
    }
    const { draft, sourceContent, htmlContent, resolvedName, ...result } = coreResult;

    const stepSourceRef = await ctx.writePayload('output', sourceContent);

    const outputArtifact = {
      artifactId: result.artifactId,
      versionId: result.versionId,
      name: resolvedName,
      description,
      kind: draft.kind,
      prompt: draft.prompt,
      dataSchema: draft.data_schema,
      catalogId: draft.catalog_id,
      catalogVersion: draft.catalog_version,
      catalogHash: draft.catalog_hash,
      sourceRef: stepSourceRef,
      ...(draft.compiled_ref != null ? { compiledRef: draft.compiled_ref } : {}),
      tags,
      warnings: [],
      errors: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      status: 'published',
      parentVersionId: result.parentVersionId,
    };

    const vr = draft.validation_report as Record<string, unknown> | null;
    const validationReport = {
      valid: true,
      diagnostics: (vr?.['diagnostics'] as unknown[]) ?? [],
      checkedAt: now.toISOString(),
    };

    const output: Record<string, unknown> = { artifact: outputArtifact, validationReport };
    output['html'] = htmlContent;
    output['source'] = sourceContent;
    output['rendererMetadata'] = {
      artifactId: result.artifactId,
      versionId: result.versionId,
      name: resolvedName,
      kind: draft.kind,
      catalogVersion: draft.catalog_version,
    };

    return await successWithData(ctx, output);
  }

  // ── ui.artifact.get ─────────────────────────────────────────────────────

  private async handleGet(
    ctx: ExecutorContext,
    input: Record<string, unknown>,
  ): Promise<StepResult> {
    const artifactId = input['artifactId'] as string | undefined;
    const versionId = input['versionId'] as string | undefined;
    const draftId = input['draftId'] as string | undefined;

    const spaceId = ctx.spaceId;
    if (!spaceId) {
      return await failureWithError(
        ctx,
        validationError(
          'execution context is missing spaceId — ui.artifact.get runs only in the originating session space (platform invariant)',
        ),
      );
    }

    const artifactIdError = validateOptionalUuidInput('artifactId', artifactId);
    if (artifactIdError) {
      return await failureWithError(ctx, artifactIdError);
    }
    const versionIdError = validateOptionalUuidInput('versionId', versionId);
    if (versionIdError) {
      return await failureWithError(ctx, versionIdError);
    }
    const draftIdError = validateOptionalUuidInput('draftId', draftId);
    if (draftIdError) {
      return await failureWithError(ctx, draftIdError);
    }

    if (draftId) {
      const draftRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`SELECT * FROM ui_artifact_drafts
          WHERE id = ${draftId}::uuid AND space_id = ${spaceId}::uuid LIMIT 1`;
      })) as DraftRow[];
      const draft = draftRows[0];
      if (!draft) {
        return await failureWithError(ctx, validationError(`Draft not found: ${draftId}`));
      }
      const out: Record<string, unknown> = { draft: serializeDraftRow(draft) };
      if (draft.html_ref) {
        out['html'] = await this.loadBlob(draft.html_ref);
        out['source'] = await this.loadBlob(draft.source_ref);
        out['rendererMetadata'] = {
          draftId,
          kind: draft.kind,
          catalogVersion: draft.catalog_version,
        };
      }
      return await successWithData(ctx, out);
    }

    if (versionId) {
      const versionRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`
          SELECT v.* FROM ui_artifact_versions v
          JOIN ui_artifacts a ON v.artifact_id = a.id
          WHERE v.id = ${versionId}::uuid AND a.space_id = ${spaceId}::uuid
          LIMIT 1
        `;
      })) as VersionRow[];
      const version = versionRows[0];
      if (!version) {
        return await failureWithError(ctx, validationError(`Version not found: ${versionId}`));
      }
      const artifactRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`SELECT * FROM ui_artifacts
          WHERE id = ${version.artifact_id}::uuid AND space_id = ${spaceId}::uuid LIMIT 1`;
      })) as ArtifactRow[];
      const artifact = artifactRows[0];

      const out: Record<string, unknown> = { artifact: serializeVersionRow(version, artifact) };
      if (version.html_ref) {
        out['html'] = await this.loadBlob(version.html_ref);
      }
      out['source'] = await this.loadBlob(version.source_ref);
      out['rendererMetadata'] = {
        artifactId: version.artifact_id,
        versionId,
        name: artifact?.name,
        kind: artifact?.kind,
        catalogVersion: artifact?.catalog_version,
        compiled: version.html_ref !== null,
      };
      return await successWithData(ctx, out);
    }

    if (artifactId) {
      const artifactRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`SELECT * FROM ui_artifacts
          WHERE id = ${artifactId}::uuid AND space_id = ${spaceId}::uuid
            AND deleted_at IS NULL LIMIT 1`;
      })) as ArtifactRow[];
      const artifact = artifactRows[0];
      if (!artifact || artifact.current_version === 0) {
        return await failureWithError(ctx, validationError(`Artifact not found: ${artifactId}`));
      }
      const versionRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`
          SELECT * FROM ui_artifact_versions
          WHERE artifact_id = ${artifactId}::uuid AND version = ${artifact.current_version} LIMIT 1
        `;
      })) as VersionRow[];
      const version = versionRows[0];
      if (!version) {
        return await failureWithError(
          ctx,
          validationError(`Version data missing for artifact: ${artifactId}`),
        );
      }
      const out: Record<string, unknown> = { artifact: serializeVersionRow(version, artifact) };
      if (version.html_ref) {
        out['html'] = await this.loadBlob(version.html_ref);
      }
      out['source'] = await this.loadBlob(version.source_ref);
      out['rendererMetadata'] = {
        artifactId,
        versionId: version.id,
        compiled: version.html_ref !== null,
        name: artifact.name,
        kind: artifact.kind,
        catalogVersion: artifact.catalog_version,
      };
      return await successWithData(ctx, out);
    }

    return await failureWithError(
      ctx,
      validationError('Provide one of: artifactId, versionId, or draftId'),
    );
  }

  // ── ui.artifact.list ────────────────────────────────────────────────────

  private async handleList(
    ctx: ExecutorContext,
    input: Record<string, unknown>,
  ): Promise<StepResult> {
    const search = input['search'] as string | undefined;
    const kind = input['kind'] as string | undefined;
    const includeDrafts = input['includeDrafts'] === true;
    const limit = (input['limit'] as number) ?? 50;

    // Space scoping via the session-carried boundary invariant.
    const spaceId = ctx.spaceId;
    if (!spaceId) {
      return await failureWithError(
        ctx,
        validationError(
          'execution context is missing spaceId — ui.artifact.list runs only in the originating session space (platform invariant)',
        ),
      );
    }

    const artifacts = (await this.withSchema(ctx, async (sql) => {
      // Build parameterized query with dynamic conditions — always filtered by space
      if (kind && search) {
        const escaped = `%${search}%`;
        return await sql`
          SELECT * FROM ui_artifacts
          WHERE deleted_at IS NULL AND kind = ${kind} AND space_id = ${spaceId}::uuid
            AND (name ILIKE ${escaped} OR description ILIKE ${escaped})
          ORDER BY updated_at DESC LIMIT ${limit}
        `;
      } else if (kind) {
        return await sql`
          SELECT * FROM ui_artifacts
          WHERE deleted_at IS NULL AND kind = ${kind} AND space_id = ${spaceId}::uuid
          ORDER BY updated_at DESC LIMIT ${limit}
        `;
      } else {
        return await sql`
          SELECT * FROM ui_artifacts WHERE deleted_at IS NULL AND space_id = ${spaceId}::uuid
          ORDER BY updated_at DESC LIMIT ${limit}
        `;
      }
    })) as ArtifactRow[];

    const artifactIds = artifacts.map((a) => a.id);
    const provenanceByArtifactId = new Map<string, BundleProvenanceRow>();
    if (artifactIds.length > 0) {
      const provenanceRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`
          SELECT
            ab.artifact_id        AS artifact_id,
            ab.bundle_id          AS bundle_id,
            ab.binding_id         AS binding_id,
            ab.installed_content_hash AS installed_content_hash,
            uav.content_hash      AS current_content_hash
          FROM artifact_bindings ab
          INNER JOIN ui_artifacts ua
            ON ua.id = ab.artifact_id AND ua.deleted_at IS NULL
          INNER JOIN ui_artifact_versions uav
            ON uav.artifact_id = ab.artifact_id AND uav.version = ua.current_version
          WHERE ab.space_id = ${spaceId}::uuid
            AND ab.artifact_id = ANY(${artifactIds}::uuid[])
        `;
      })) as BundleProvenanceRow[];
      for (const row of provenanceRows) {
        provenanceByArtifactId.set(row.artifact_id, row);
      }
    }

    const result: Record<string, unknown> = {
      artifacts: artifacts.map((a) =>
        serializeArtifactRow(a, provenanceByArtifactId.get(a.id) ?? null),
      ),
      total: artifacts.length,
    };

    if (includeDrafts) {
      const draftRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`
          SELECT * FROM ui_artifact_drafts WHERE expires_at > NOW() AND space_id = ${spaceId}::uuid
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      })) as DraftRow[];
      result['drafts'] = draftRows.map(serializeDraftRow);
    }

    return await successWithData(ctx, result);
  }

  // ── ui.artifact.render ──────────────────────────────────────────────────

  private async handleRender(
    ctx: ExecutorContext,
    input: Record<string, unknown>,
  ): Promise<StepResult> {
    const artifactId = input['artifactId'] as string | undefined;
    const versionId = input['versionId'] as string | undefined;
    const draftId = input['draftId'] as string | undefined;
    const renderData = input['data'] as Record<string, unknown>;

    const spaceId = ctx.spaceId;
    if (!spaceId) {
      return await failureWithError(
        ctx,
        validationError(
          'execution context is missing spaceId — ui.artifact.render runs only in the originating session space (platform invariant)',
        ),
      );
    }

    const artifactIdError = validateOptionalUuidInput('artifactId', artifactId);
    if (artifactIdError) {
      return await failureWithError(ctx, artifactIdError);
    }
    const versionIdError = validateOptionalUuidInput('versionId', versionId);
    if (versionIdError) {
      return await failureWithError(ctx, versionIdError);
    }
    const draftIdError = validateOptionalUuidInput('draftId', draftId);
    if (draftIdError) {
      return await failureWithError(ctx, draftIdError);
    }

    let htmlRefValue: string | undefined;
    let resolvedKind = 'react_tsx';
    let catalogVersion = '';
    let resolvedArtifactId: string | undefined;
    let resolvedVersionId: string | undefined;
    let resolvedDraftId: string | undefined;
    let resolvedDataSchema: Record<string, unknown> | undefined;
    let sourceRefValue: string | undefined;

    if (draftId) {
      const draftRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`SELECT * FROM ui_artifact_drafts
          WHERE id = ${draftId}::uuid AND space_id = ${spaceId}::uuid LIMIT 1`;
      })) as DraftRow[];
      const draft = draftRows[0];
      if (!draft) {
        return await failureWithError(ctx, validationError(`Draft not found: ${draftId}`));
      }
      if (!draft.html_ref) {
        return await failureWithError(
          ctx,
          validationError('Draft has no compiled HTML. Validation may have failed.'),
        );
      }
      htmlRefValue = draft.html_ref;
      resolvedKind = draft.kind;
      catalogVersion = draft.catalog_version;
      resolvedDraftId = draftId;
      resolvedDataSchema =
        typeof draft.data_schema === 'object' && draft.data_schema !== null
          ? (draft.data_schema as Record<string, unknown>)
          : undefined;
    } else if (versionId) {
      const versionRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`
          SELECT v.* FROM ui_artifact_versions v
          JOIN ui_artifacts a ON v.artifact_id = a.id
          WHERE v.id = ${versionId}::uuid AND a.space_id = ${spaceId}::uuid
          LIMIT 1
        `;
      })) as VersionRow[];
      const version = versionRows[0];
      if (!version) {
        return await failureWithError(ctx, validationError(`Version not found: ${versionId}`));
      }
      htmlRefValue = version.html_ref;
      sourceRefValue = version.source_ref;
      resolvedArtifactId = version.artifact_id;
      resolvedVersionId = versionId;
      const artifactRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`SELECT * FROM ui_artifacts
          WHERE id = ${version.artifact_id}::uuid AND space_id = ${spaceId}::uuid LIMIT 1`;
      })) as ArtifactRow[];
      resolvedKind = artifactRows[0]?.kind ?? 'react_tsx';
      catalogVersion = artifactRows[0]?.catalog_version ?? '';
      resolvedDataSchema =
        typeof version.data_schema === 'object' && version.data_schema !== null
          ? (version.data_schema as Record<string, unknown>)
          : undefined;
    } else if (artifactId) {
      const artifactRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`SELECT * FROM ui_artifacts
          WHERE id = ${artifactId}::uuid AND space_id = ${spaceId}::uuid
            AND deleted_at IS NULL LIMIT 1`;
      })) as ArtifactRow[];
      const artifact = artifactRows[0];
      if (!artifact || artifact.current_version === 0) {
        return await failureWithError(ctx, validationError(`Artifact not found: ${artifactId}`));
      }
      const versionRows = (await this.withSchema(ctx, async (sql) => {
        return await sql`
          SELECT * FROM ui_artifact_versions
          WHERE artifact_id = ${artifactId}::uuid AND version = ${artifact.current_version} LIMIT 1
        `;
      })) as VersionRow[];
      const version = versionRows[0];
      if (!version) {
        return await failureWithError(ctx, validationError(`Version data missing: ${artifactId}`));
      }
      htmlRefValue = version.html_ref;
      sourceRefValue = version.source_ref;
      resolvedKind = artifact.kind;
      catalogVersion = artifact.catalog_version;
      resolvedArtifactId = artifactId;
      resolvedVersionId = version.id;
      resolvedDataSchema =
        typeof version.data_schema === 'object' && version.data_schema !== null
          ? (version.data_schema as Record<string, unknown>)
          : undefined;
    } else {
      return await failureWithError(
        ctx,
        validationError('Provide one of: artifactId, versionId, or draftId'),
      );
    }

    const dataValidation = validateDataAgainstSchema(resolvedDataSchema, renderData);
    if (!dataValidation.valid) {
      const detail = dataValidation.diagnostics.map((diagnostic) => diagnostic.message).join('; ');
      return await failureWithError(
        ctx,
        validationError(`Render data failed schema validation: ${detail}`),
      );
    }

    if (!htmlRefValue && resolvedVersionId && sourceRefValue) {
      const lazyRefs = await this.lazyCompileVersion({
        ctx,
        versionId: resolvedVersionId,
        sourceRef: sourceRefValue,
        kind: resolvedKind,
      });
      htmlRefValue = lazyRefs.htmlRef;
    }

    if (!htmlRefValue) {
      return await failureWithError(
        ctx,
        validationError(
          `Artifact has no compiled HTML and no source to compile from. ` +
            `versionId=${resolvedVersionId ?? '<none>'}`,
        ),
      );
    }

    const html = await this.loadBlob(htmlRefValue);

    const presentation =
      resolvedArtifactId && resolvedVersionId
        ? ({
            mode: 'rendered_inline' as const,
            substrate: 'artifact' as const,
            artifactId: resolvedArtifactId,
            versionId: resolvedVersionId,
            data: renderData,
          } as const)
        : ({ mode: 'summarize' as const } as const);

    return await successWithData(ctx, {
      html,
      data: renderData,
      ...(resolvedDataSchema ? { dataSchema: resolvedDataSchema } : {}),
      rendererMetadata: {
        ...(resolvedArtifactId ? { artifactId: resolvedArtifactId } : {}),
        ...(resolvedVersionId ? { versionId: resolvedVersionId } : {}),
        ...(resolvedDraftId ? { draftId: resolvedDraftId } : {}),
        kind: resolvedKind,
        catalogVersion,
        dataSchemaValid: true,
      },
      warnings: [],
      presentation,
    });
  }
}

// ============================================================================
// Serialization helpers
// ============================================================================

function serializeDraftRow(draft: DraftRow) {
  return {
    draftId: draft.id,
    artifactId: draft.artifact_id,
    kind: draft.kind,
    prompt: draft.prompt,
    dataSchema: draft.data_schema,
    catalogId: draft.catalog_id,
    catalogVersion: draft.catalog_version,
    catalogHash: draft.catalog_hash,
    sourceRef: draft.source_ref,
    compiledRef: draft.compiled_ref,
    htmlRef: draft.html_ref,
    validationReport: draft.validation_report,
    createdAt: draft.created_at,
    expiresAt: draft.expires_at,
    status: draft.status,
  };
}

function serializeVersionRow(version: VersionRow, artifact?: ArtifactRow | null) {
  return {
    artifactId: version.artifact_id,
    versionId: version.id,
    version: version.version,
    name: artifact?.name,
    description: artifact?.description,
    kind: artifact?.kind,
    prompt: version.prompt,
    dataSchema: version.data_schema,
    catalogId: artifact?.catalog_id,
    catalogVersion: artifact?.catalog_version,
    catalogHash: artifact?.catalog_hash,
    sourceRef: version.source_ref,
    compiledRef: version.compiled_ref,
    htmlRef: version.html_ref,
    contentHash: version.content_hash,
    validationReport: version.validation_report,
    tags: artifact?.tags,
    createdAt: version.created_at,
    updatedAt: artifact?.updated_at,
    status: 'published',
    parentVersionId: version.parent_version_id,
  };
}

function serializeArtifactRow(row: ArtifactRow, provenance: BundleProvenanceRow | null) {
  const out: Record<string, unknown> = {
    artifactId: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    spaceId: row.space_id,
    currentVersion: row.current_version,
    catalogId: row.catalog_id,
    catalogVersion: row.catalog_version,
    catalogHash: row.catalog_hash,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (provenance) {
    out['bundleProvenance'] = {
      bundleId: provenance.bundle_id,
      bindingId: provenance.binding_id,
      installedContentHash: provenance.installed_content_hash,
      currentContentHash: provenance.current_content_hash,
      // Null when `installed_content_hash` is unrecorded (legacy
      // pre-Migration-97 rows). Mirrors `getArtifactBundleProvenance`
      // helper semantics so consumers get one shape across both paths.
      divergedFromBundle:
        provenance.installed_content_hash === null
          ? null
          : provenance.installed_content_hash !== provenance.current_content_hash,
    };
  }
  return out;
}

// ============================================================================
// Template source generation (fallback when no AI provider)
// ============================================================================

function generateTemplateSource(
  prompt: string,
  kind: ArtifactKind,
  dataSchema: Record<string, unknown>,
  name?: string,
): string {
  const componentName = name
    ? name.replace(/[^a-zA-Z0-9]/g, '').replace(/^[a-z]/, (c) => c.toUpperCase()) || 'Artifact'
    : 'Artifact';

  if (kind === 'applet') {
    return generateAppletTemplateSource(prompt, componentName);
  }

  if (kind === 'illustration') {
    return generateIllustrationTemplateSvg(prompt, componentName);
  }

  if (kind === 'html_js') {
    return `// Generated HTML/JS artifact
// Prompt: ${prompt.slice(0, 200)}
const root = document.getElementById('root');
root.innerHTML = '<div style="padding: 16px;"><h2>${componentName}</h2><p>Generated from prompt.</p></div>';
`;
  }

  return `import React from 'react';
import { Panel, Column, Heading, Text, Row, Badge } from '@aflow/design-system';

// Generated artifact: ${componentName}
// Prompt: ${prompt.slice(0, 200)}

interface ArtifactProps {
  data: Record<string, unknown>;
}

export default function ${componentName}({ data }: ArtifactProps) {
  return (
    <Panel padding="lg" radius="md">
      <Column gap="md">
        <Row gap="sm" align="center">
          <Heading level={2}>${componentName}</Heading>
          <Badge variant="info">Generated</Badge>
        </Row>
        <Text color="muted">Generated from: ${prompt.slice(0, 100).replace(/'/g, "\\'")}...</Text>
        <Text>Data keys: {Object.keys(data).join(', ') || 'none'}</Text>
      </Column>
    </Panel>
  );
}
`;
}

function inferDataSchema(prompt: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
    },
    description: `Inferred data schema for: ${prompt.slice(0, 100)}`,
  };
}
