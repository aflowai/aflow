/**
 * Build script: generates design-system-contract.json
 *
 * Reads the component registry, tokens, and icon map to produce the canonical
 * DesignSystemContractBundle in both artifact and surface projections.
 *
 * Output: dist/design-system-contract.json (full bundle, artifact mode)
 *         dist/design-system-contract-surface.json (surface projection)
 *         dist/design-system-contract-compact.json (token-efficient for LLM prompts)
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { componentRegistry } from '../src/registry.js';
import { ICON_MAP } from '../src/icons/iconMap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

// ============================================================================
// Token extraction (from generated tokens.ts type literals)
// ============================================================================

const SPACE_TOKENS = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '8',
  '10',
  '12',
  '16',
  '20',
  '24',
  'none',
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '0-5',
  '1-5',
  '2-5',
];

const RADIUS_TOKENS = ['none', 'sm', 'md', 'lg', 'xl', 'full'];
const SHADOW_TOKENS = ['none', 'xs', 'sm', 'md', 'lg', 'xl'];
const FONT_SIZE_TOKENS = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'];
const FONT_WEIGHT_TOKENS = ['thin', 'light', 'normal', 'medium', 'semibold', 'bold'];

const COLOR_PATHS = [
  'surface.canvas',
  'surface.raised',
  'surface.overlay',
  'surface.sunken',
  'content.primary',
  'content.secondary',
  'content.muted',
  'content.inverse',
  'content.link',
  'border.default',
  'border.subtle',
  'border.strong',
  'interactive.default',
  'interactive.hover',
  'interactive.muted',
  'interactive.secondary',
  'interactive.secondaryHover',
  'highlight.default',
  'highlight.bg',
  'highlight.fg',
  'status.queued.fg',
  'status.queued.bg',
  'status.running.fg',
  'status.running.bg',
  'status.paused.fg',
  'status.paused.bg',
  'status.succeeded.fg',
  'status.succeeded.bg',
  'status.failed.fg',
  'status.failed.bg',
  'status.cancelled.fg',
  'status.cancelled.bg',
  'status.stalled.fg',
  'status.stalled.bg',
  'focus.ring',
  'focus.ringOffset',
  'danger.default',
  'danger.hover',
  'danger.bg',
  'danger.fg',
  'warning.default',
  'warning.hover',
  'warning.bg',
  'warning.fg',
  'success.default',
  'success.hover',
  'success.bg',
  'success.fg',
  'info.default',
  'info.hover',
  'info.bg',
  'info.fg',
  'accent.default',
  'accent.hover',
  'accent.bg',
  'accent.fg',
];

const ICON_NAMES = Object.keys(ICON_MAP);

// ============================================================================
// Allowed libraries
// ============================================================================

interface LibraryEntry {
  id: string;
  name: string;
  description: string;
  availableInArtifact: boolean;
  availableInSurface: boolean;
}

const LIBRARIES: LibraryEntry[] = [
  {
    id: 'phoenix-design-system',
    name: 'Phoenix Design System',
    description:
      'Core layout, content, actions, forms, feedback, data-display, and navigation components',
    availableInArtifact: true,
    availableInSurface: true,
  },
  {
    id: 'phoenix-icons',
    name: 'Phoenix Icons',
    description: 'Curated icon set via name-based Icon component',
    availableInArtifact: true,
    availableInSurface: true,
  },
  {
    id: 'phoenix-charts',
    name: 'Phoenix Charts',
    description: 'Chart components (bar, line, area, pie) built on Recharts',
    availableInArtifact: true,
    availableInSurface: true,
  },
  {
    id: 'recharts',
    name: 'Recharts',
    description: 'Composable charting library for React',
    availableInArtifact: true,
    availableInSurface: false,
  },
  {
    id: 'd3-core',
    name: 'D3 Core',
    description: 'D3 selections, scales, and axes for custom data visualizations',
    availableInArtifact: true,
    availableInSurface: false,
  },
  {
    id: 'd3-scale',
    name: 'D3 Scale',
    description: 'D3 scale functions (linear, ordinal, time, etc.)',
    availableInArtifact: true,
    availableInSurface: false,
  },
  {
    id: 'katex',
    name: 'KaTeX',
    description: 'Fast math typesetting for LaTeX expressions',
    availableInArtifact: true,
    availableInSurface: false,
  },
  {
    id: 'mermaid',
    name: 'Mermaid',
    description: 'Diagram and flowchart rendering from text definitions',
    availableInArtifact: true,
    availableInSurface: false,
  },
];

// ============================================================================
// Semantic surface components (Track B reference)
// ============================================================================

const SURFACE_COMPONENTS = [
  'Page',
  'Section',
  'Panel',
  'Heading',
  'Text',
  'MetricGrid',
  'DataTable',
  'List',
  'Form',
  'Field',
  'Button',
  'Chart',
  'ChatComposer',
  'Image',
  'CodeBlock',
  'Divider',
  'Badge',
  'Icon',
];

// ============================================================================
// Mode-specific examples and guidance
// ============================================================================

/**
 * Returns mode-specific examples for a component.
 * Artifact mode: richer composition, broader DS coverage.
 * Surface mode: mutation-friendly, fewer props, stronger defaults.
 */
function getExamples(componentName: string, mode: 'artifact' | 'surface'): string[] {
  const artifactExamples: Record<string, string[]> = {
    Row: [
      '<Row gap="lg" align="center"><Avatar size="md" /><Column gap="xs"><Text weight="semibold">{name}</Text><Text size="sm" color="muted">{email}</Text></Column></Row>',
    ],
    Column: [
      '<Column gap="md"><Heading level={2}>{title}</Heading><Text>{description}</Text><Row gap="sm"><Button>Save</Button><Button variant="ghost">Cancel</Button></Row></Column>',
    ],
    Panel: [
      '<Panel padding="lg" radius="md" shadow="sm"><Heading level={3}>Summary</Heading><PropertyTable items={metrics} /></Panel>',
    ],
    Card: [
      '<Card padding="lg"><Column gap="md"><Row gap="sm" align="center"><Icon name="chart-bar" /><Heading level={3}>Revenue</Heading></Row><Text size="3xl" weight="bold">{value}</Text><Badge variant="success">{change}</Badge></Column></Card>',
    ],
    Button: [
      '<Button variant="primary" size="md" loading={isSubmitting}>Submit</Button>',
      '<Row gap="sm"><Button variant="primary">Confirm</Button><Button variant="ghost">Cancel</Button></Row>',
    ],
    SelectTrigger: [
      '<SelectTrigger leadingIcon={<Icon name="git-branch" size="sm" />} popup="dialog" isPlaceholder={!flow} onClick={openPicker}>{flow?.name ?? "Select a flow"}</SelectTrigger>',
    ],
    DataTable: [
      '<Panel><PropertyTable items={[{ label: "Status", value: <Badge variant="success">Active</Badge> }, { label: "Created", value: formatDate(createdAt) }]} /></Panel>',
    ],
  };

  const surfaceExamples: Record<string, string[]> = {
    Row: ['{ "component": "Row", "props": { "gap": "md" }, "children": ["heading_1", "badge_1"] }'],
    Panel: ['{ "component": "Panel", "props": { "padding": "lg" }, "children": ["section_1"] }'],
    Button: [
      '{ "component": "Button", "props": { "variant": "primary" }, "actions": [{ "eventName": "submit", "eventType": "submit", "target": "agent" }] }',
    ],
    SelectTrigger: [
      '{ "component": "SelectTrigger", "props": { "popup": "dialog", "isPlaceholder": true }, "actions": [{ "eventName": "openPicker", "eventType": "click", "target": "agent" }] }',
    ],
    DataTable: [
      '{ "component": "DataTable", "props": {}, "bindings": { "rows": "/data/items", "columns": "/schema/columns" } }',
    ],
    Form: [
      '{ "component": "Form", "children": ["field_1", "field_2", "submit_btn"], "actions": [{ "eventName": "form.submit", "eventType": "submit", "target": "agent", "includeDataModel": true }] }',
    ],
  };

  const examples = mode === 'artifact' ? artifactExamples : surfaceExamples;
  return examples[componentName] ?? [];
}

function getGuidance(componentName: string, mode: 'artifact' | 'surface'): string | undefined {
  if (mode === 'surface') {
    const surfaceGuidance: Record<string, string> = {
      Panel:
        'Use as the primary container. Renderer adds elevation and spacing defaults for generated content.',
      Form: 'Declare fields as children. Submit action should use includeDataModel: true to send the full form state.',
      DataTable:
        'Bind rows and columns via bindings. Renderer handles responsive overflow and pagination.',
      Chart:
        'Specify chart type in props. Renderer maps to constrained chart preset with safe defaults.',
      Button: 'Always declare actions. Renderer handles loading states and disabled styling.',
    };
    return surfaceGuidance[componentName];
  }
  return undefined;
}

// ============================================================================
// Bundle generation
// ============================================================================

interface ContractBundle {
  catalogId: string;
  catalogVersion: string;
  catalogHash: string;
  generatedAt: string;
  designSystemVersion: string;
  mode: 'artifact' | 'surface';
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
  libraries: LibraryEntry[];
  surfaceComponents?: string[];
}

function buildBundle(mode: 'artifact' | 'surface'): ContractBundle {
  const now = new Date().toISOString();
  const dsVersion = '2.0.0';

  // Filter components by availableInModes — default to ['artifact', 'surface'] if omitted
  const filteredRegistry = componentRegistry.filter((comp) => {
    const modes = comp.availableInModes ?? ['artifact', 'surface'];
    return modes.includes(mode);
  });

  const components = filteredRegistry.map((comp) => {
    const entry: ContractBundle['components'][number] = {
      name: comp.name,
      importPath: comp.importPath,
      category: comp.category,
      intents: comp.intents,
      description: comp.description,
      props: comp.props.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        ...(p.default != null ? { default: p.default } : {}),
        description: p.description,
      })),
    };

    if (comp.doNot) entry.doNot = comp.doNot;
    if (comp.combinesWith) entry.combinesWith = comp.combinesWith;
    if (comp.a11y) entry.a11y = comp.a11y;
    if (comp.synonyms) entry.synonyms = comp.synonyms;
    if (comp.preferOver) entry.preferOver = comp.preferOver;

    const examples = getExamples(comp.name, mode);
    if (examples.length > 0) entry.examples = examples;

    const guidance = getGuidance(comp.name, mode);
    if (guidance) entry.guidance = guidance;

    return entry;
  });

  const libs = LIBRARIES.filter((lib) =>
    mode === 'artifact' ? lib.availableInArtifact : lib.availableInSurface,
  );

  const bundle: ContractBundle = {
    catalogId: 'phoenix-design-system',
    catalogVersion: `${dsVersion}-${mode}`,
    catalogHash: '', // computed below
    generatedAt: now,
    designSystemVersion: dsVersion,
    mode,
    components,
    tokens: {
      spaceTokens: SPACE_TOKENS,
      radiusTokens: RADIUS_TOKENS,
      shadowTokens: SHADOW_TOKENS,
      fontSizeTokens: FONT_SIZE_TOKENS,
      fontWeightTokens: FONT_WEIGHT_TOKENS,
      colorPaths: COLOR_PATHS,
      iconNames: ICON_NAMES,
    },
    libraries: libs,
  };

  if (mode === 'surface') {
    bundle.surfaceComponents = SURFACE_COMPONENTS;
  }

  // Compute deterministic hash (exclude generatedAt and catalogHash for stability)
  const hashInput = JSON.stringify(
    {
      ...bundle,
      generatedAt: undefined,
      catalogHash: undefined,
    },
    Object.keys(bundle).sort(),
  );
  bundle.catalogHash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);

  return bundle;
}

/**
 * Build a compact/token-efficient projection for LLM prompts.
 * Strips verbose fields, keeps only essential metadata.
 */
function buildCompact(bundle: ContractBundle): Record<string, unknown> {
  return {
    catalogId: bundle.catalogId,
    catalogVersion: bundle.catalogVersion,
    catalogHash: bundle.catalogHash,
    mode: bundle.mode,
    components: bundle.components.map((c) => ({
      name: c.name,
      ...(c.importPath !== '@aflow/design-system' ? { importPath: c.importPath } : {}),
      category: c.category,
      description: c.description,
      props: c.props.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        ...(p.default != null ? { default: p.default } : {}),
      })),
      ...(c.examples && c.examples.length > 0 ? { examples: c.examples } : {}),
      ...(c.guidance ? { guidance: c.guidance } : {}),
    })),
    tokens: {
      space: bundle.tokens.spaceTokens.filter((t) => /^[a-z]/.test(t)), // named only
      radius: bundle.tokens.radiusTokens,
      fontSize: bundle.tokens.fontSizeTokens,
      fontWeight: bundle.tokens.fontWeightTokens,
    },
    iconNames: bundle.tokens.iconNames,
    libraries: bundle.libraries.map((l) => l.id),
    ...(bundle.surfaceComponents ? { surfaceComponents: bundle.surfaceComponents } : {}),
  };
}

// ============================================================================
// Main
// ============================================================================

mkdirSync(DIST, { recursive: true });

const artifactBundle = buildBundle('artifact');
const surfaceBundle = buildBundle('surface');
const compactArtifact = buildCompact(artifactBundle);
const compactSurface = buildCompact(surfaceBundle);

writeFileSync(
  resolve(DIST, 'design-system-contract.json'),
  JSON.stringify(artifactBundle, null, 2),
);

writeFileSync(
  resolve(DIST, 'design-system-contract-surface.json'),
  JSON.stringify(surfaceBundle, null, 2),
);

writeFileSync(
  resolve(DIST, 'design-system-contract-compact.json'),
  JSON.stringify(compactArtifact, null, 2),
);

writeFileSync(
  resolve(DIST, 'design-system-contract-compact-surface.json'),
  JSON.stringify(compactSurface, null, 2),
);

console.log(
  `✓ Generated design-system-contract.json (${artifactBundle.components.length} components, artifact mode)`,
);
console.log(
  `✓ Generated design-system-contract-surface.json (${surfaceBundle.components.length} components, surface mode)`,
);
console.log(`✓ Generated design-system-contract-compact.json (token-efficient, artifact mode)`);
console.log(
  `✓ Generated design-system-contract-compact-surface.json (token-efficient, surface mode)`,
);
console.log(`  Catalog hash (artifact): ${artifactBundle.catalogHash}`);
console.log(`  Catalog hash (surface):  ${surfaceBundle.catalogHash}`);
