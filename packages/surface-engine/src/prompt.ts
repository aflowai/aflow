/**
 * Surface Generation Prompt — System prompt for LLM surface generation.
 *
 * Teaches the model:
 * 1. The JSONL mutation protocol
 * 2. The flat component graph model
 * 3. Available surface components and their props
 * 4. Data model binding patterns
 * 5. Action declarations
 * 6. Best practices for progressive rendering
 */
import type { SurfaceCatalogEntry } from '@aflow/schemas';
import { SURFACE_CATALOG } from '@aflow/schemas';

// =============================================================================
// System prompt template
// =============================================================================

/**
 * Build the surface generation system prompt.
 * @param catalogVersion - version string for deterministic replay
 * @param allowedComponents - optional whitelist of component types
 */
export function buildSurfaceSystemPrompt(
  catalogVersion: string,
  allowedComponents?: readonly string[],
  iconNames?: readonly string[],
  hasPreloadedData?: boolean,
): string {
  const catalog = allowedComponents
    ? SURFACE_CATALOG.filter((c) => allowedComponents.includes(c.component))
    : SURFACE_CATALOG;

  return `You are a UI surface generator for the Phoenix platform. You generate declarative UI mutation messages as JSONL (one JSON object per line). The client renders your output using a trusted design system — you never generate HTML, CSS, or executable code.

## Protocol

Output JSONL where each line is a mutation message. Messages must be emitted in this order:

1. \`createSurface\` — exactly once, first
2. \`updateComponents\` / \`updateDataModel\` — zero or more, interleaved as needed
3. \`completeSurface\` — exactly once, last

## Message Shapes

### createSurface
\`\`\`json
{"type":"createSurface","surfaceId":"<id>","messageId":"m1","catalogVersion":"${catalogVersion}","timestamp":"<iso>","components":[...],"rootIds":["page"],"dataModel":{...},"title":"..."}
\`\`\`

### updateComponents
\`\`\`json
{"type":"updateComponents","surfaceId":"<id>","messageId":"m2","catalogVersion":"${catalogVersion}","timestamp":"<iso>","components":[...]}
\`\`\`

### updateDataModel
\`\`\`json
{"type":"updateDataModel","surfaceId":"<id>","messageId":"m3","catalogVersion":"${catalogVersion}","timestamp":"<iso>","dataModel":{"/path":value}}
\`\`\`

### completeSurface
\`\`\`json
{"type":"completeSurface","surfaceId":"<id>","messageId":"mN","catalogVersion":"${catalogVersion}","timestamp":"<iso>"}
\`\`\`

## Component Model

Components are flat records with stable IDs. Parent-child relationships use ID references.

\`\`\`json
{"id":"metrics","component":"MetricGrid","props":{...},"children":[],"bindings":{"items":"/data/metrics"},"actions":[]}
\`\`\`

- \`id\`: unique string within the surface (use descriptive short names)
- \`component\`: one of the types below
- \`props\`: component-specific properties (most are optional with good defaults)
- \`children\`: array of child component IDs for layout
- \`bindings\`: map of prop-name → JSON Pointer into the data model
- \`actions\`: array of declarative action definitions

## Data Model

Separate data from structure. Use \`updateDataModel\` with JSON Pointer keys:
- \`"/metrics"\`: sets root-level \`metrics\` key
- \`"/form/email"\`: sets nested \`form.email\`
- \`"/"\`: replaces entire data model

Components bind to data via \`bindings\`: \`{"items": "/metrics"}\`
Fields bind for two-way editing via \`bindPath\` in props: \`"bindPath": "/form/email"\`

## Actions

Components with \`actionable: true\` can have actions:
\`\`\`json
{"eventName":"form.submit","eventType":"submit","target":"agent","includeDataModel":true}
\`\`\`

Targets: \`agent\` (send to AI agent), \`flow\` (flow event), \`client\` (local-only)
${iconNames && iconNames.length > 0 ? `\n## Available Icons\n\nUse ONLY these icon names (any other name will render as empty):\n${iconNames.join(', ')}\n` : ''}
## Available Components

${formatCatalog(catalog)}

## Streaming & Progressive Rendering

Your output is streamed to the client in real-time. Each mutation is rendered as soon as it arrives. **Use many small mutations** — NOT one or two large ones. This is critical for smooth progressive rendering.

${
  hasPreloadedData
    ? `### Data Model (PRE-LOADED)

The data model has been pre-loaded into the surface before your output starts. All data keys are available at \`/<key>\` paths. **Do NOT re-send the data via updateDataModel** — it is already there. Just use bindings to reference it (e.g., \`bindings: {"items": "/leads"}\`). You may send updateDataModel ONLY to add NEW derived data that is not already in the data model.

Ideal mutation sequence (5–10 messages total):

1. **createSurface** — Page root + top-level skeleton (Sections with children IDs). Keep this small. Do NOT include dataModel — it is already loaded.
2. **updateComponents** × N — one per visual group (1–3 components per message). Use bindings to reference the pre-loaded data.
3. **completeSurface** — always last.`
    : `### Data Model (model-generated)

You must create the data model yourself using updateDataModel messages.

Ideal mutation sequence (5–15+ messages total):

1. **createSurface** — ONLY the Page root + top-level skeleton (Sections with children IDs). Keep this small. Do NOT include dataModel here.
2. **updateComponents** × N — one per visual group (1–3 components per message). Work left-to-right, top-to-bottom.
3. **updateDataModel** × N — send data AFTER the components that bind to it. Split large datasets across multiple messages.
4. **completeSurface** — always last.`
}

**IMPORTANT**: Do NOT bundle all components into createSurface or a single updateComponents. Each mutation message renders immediately — more messages = smoother streaming.

## Rules

1. Always start with createSurface containing a Page as root
2. Use descriptive component IDs (e.g., "header", "metrics_grid", "sales_table")
3. Prefer data bindings over inline data for dynamic content
4. Keep props minimal — defaults are opinionated and good
5. For forms, use Field components with bindPath for two-way binding
6. **Every binding must have matching data** — if you use a binding, the data must exist in the data model (either pre-loaded or sent via updateDataModel)
7. When input data can serve multiple components (chart + table), reuse the same binding path
8. End with completeSurface
9. Output raw JSONL only — no markdown, no explanation, no wrapping
10. Each line must be a complete, valid JSON object
11. ColorIntent values: default, primary, secondary, success, warning, danger, info, accent, muted`;
}

/**
 * Build the user prompt for surface generation.
 */
export function buildSurfaceUserPrompt(
  prompt: string,
  surfaceId: string,
  dataSchema?: Record<string, unknown>,
  data?: Record<string, unknown>,
  hasPreloadedData?: boolean,
): string {
  const parts: string[] = [`Generate a surface for: ${prompt}`];

  parts.push(`\nSurface ID: ${surfaceId}`);
  parts.push(`Timestamp: ${new Date().toISOString()}`);

  if (dataSchema) {
    parts.push(`\nData Schema:\n\`\`\`json\n${JSON.stringify(dataSchema, null, 2)}\n\`\`\``);
  }

  if (data) {
    const dataStr = JSON.stringify(data, null, 2);
    // Truncate large data to keep prompt manageable
    const truncated =
      dataStr.length > 8000 ? dataStr.slice(0, 8000) + '\n... (truncated)' : dataStr;

    if (hasPreloadedData) {
      // Data is pre-seeded into the store — model should only reference it via bindings
      const dataKeys = Object.keys(data);
      parts.push(
        `\nPre-loaded Data Model (already available — use bindings to reference, do NOT re-send via updateDataModel):`,
      );
      parts.push(`Available paths: ${dataKeys.map((k) => `"/${k}"`).join(', ')}`);
      parts.push(`\`\`\`json\n${truncated}\n\`\`\``);
    } else {
      parts.push(
        `\nInput Data (send via updateDataModel messages AFTER creating the components that bind to it):\n\`\`\`json\n${truncated}\n\`\`\``,
      );
    }
  }

  return parts.join('\n');
}

// =============================================================================
// Catalog formatting — compact, token-friendly
// =============================================================================

function formatCatalog(catalog: readonly SurfaceCatalogEntry[]): string {
  return catalog.map(formatEntry).join('\n\n');
}

function formatEntry(entry: SurfaceCatalogEntry): string {
  const lines: string[] = [];
  const flags: string[] = [];
  if (entry.children) flags.push('children');
  if (entry.bindable) flags.push('bindable');
  if (entry.actionable) flags.push('actionable');

  lines.push(`### ${entry.component}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`);
  lines.push(entry.desc);

  if (entry.props.length > 0) {
    lines.push('Props:');
    for (const p of entry.props) {
      const parts = [`- \`${p.name}\`: ${p.type}`];
      if (p.required) parts.push('**(required)**');
      if (p.default) parts.push(`(default: ${p.default})`);
      parts.push(`— ${p.desc}`);
      lines.push(parts.join(' '));
    }
  }

  if (entry.bindingKeys) {
    lines.push(`Binding keys: ${entry.bindingKeys.join(', ')}`);
  }

  if (entry.note) {
    lines.push(`Note: ${entry.note}`);
  }

  return lines.join('\n');
}

// =============================================================================
// Example surface mutation sequence — for few-shot prompting
// =============================================================================

/**
 * Returns a compact example of a well-formed surface mutation sequence.
 * @param hasPreloadedData — when true, returns an example that uses bindings
 *   to reference pre-loaded data (no updateDataModel messages).
 */
export function getSurfaceExample(hasPreloadedData?: boolean): string {
  if (hasPreloadedData) {
    // Example with pre-loaded data: only createSurface + updateComponents + completeSurface
    return `{"type":"createSurface","surfaceId":"dash","messageId":"m1","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"page","component":"Page","props":{"title":"Sales Dashboard","maxWidth":"xl"},"children":["metrics","chart_section","table_section"]}],"rootIds":["page"]}
{"type":"updateComponents","surfaceId":"dash","messageId":"m2","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"metrics","component":"MetricGrid","props":{"columns":"3"},"bindings":{"items":"/metrics"}}]}
{"type":"updateComponents","surfaceId":"dash","messageId":"m3","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"chart_section","component":"Section","props":{"title":"Revenue Trend"},"children":["revenue_chart"]},{"id":"revenue_chart","component":"Chart","props":{"chartType":"line","height":"md","xKey":"month","yKey":"revenue"},"bindings":{"data":"/sales"}}]}
{"type":"updateComponents","surfaceId":"dash","messageId":"m4","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"table_section","component":"Section","props":{"title":"Recent Orders"},"children":["orders_table"]},{"id":"orders_table","component":"DataTable","props":{"columns":[{"key":"id","label":"Order ID"},{"key":"customer","label":"Customer"},{"key":"amount","label":"Amount","align":"end"},{"key":"status","label":"Status"}],"striped":true},"bindings":{"rows":"/orders"}}]}
{"type":"completeSurface","surfaceId":"dash","messageId":"m5","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z"}`;
  }

  // Example with model-generated data: skeleton → components → data → complete
  return `{"type":"createSurface","surfaceId":"dash","messageId":"m1","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"page","component":"Page","props":{"title":"Sales Dashboard","maxWidth":"xl"},"children":["metrics","chart_section","table_section"]}],"rootIds":["page"]}
{"type":"updateComponents","surfaceId":"dash","messageId":"m2","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"metrics","component":"MetricGrid","props":{"columns":"3"},"bindings":{"items":"/metrics"}}]}
{"type":"updateComponents","surfaceId":"dash","messageId":"m3","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"chart_section","component":"Section","props":{"title":"Revenue Trend"},"children":["revenue_chart"]},{"id":"revenue_chart","component":"Chart","props":{"chartType":"line","height":"md","xKey":"month","yKey":"revenue"},"bindings":{"data":"/sales"}}]}
{"type":"updateComponents","surfaceId":"dash","messageId":"m4","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","components":[{"id":"table_section","component":"Section","props":{"title":"Recent Orders"},"children":["orders_table"]},{"id":"orders_table","component":"DataTable","props":{"columns":[{"key":"id","label":"Order ID"},{"key":"customer","label":"Customer"},{"key":"amount","label":"Amount","align":"end"},{"key":"status","label":"Status"}],"striped":true},"bindings":{"rows":"/orders"}}]}
{"type":"updateDataModel","surfaceId":"dash","messageId":"m5","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","dataModel":{"/metrics":[{"label":"Revenue","value":"$125K","trend":"up"},{"label":"Orders","value":"1,847","trend":"up"},{"label":"Avg Order","value":"$67.60","trend":"flat"}]}}
{"type":"updateDataModel","surfaceId":"dash","messageId":"m6","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","dataModel":{"/sales":[{"month":"Jan","revenue":42000},{"month":"Feb","revenue":48000},{"month":"Mar","revenue":35000}]}}
{"type":"updateDataModel","surfaceId":"dash","messageId":"m7","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z","dataModel":{"/orders":[{"id":"ORD-001","customer":"Acme Corp","amount":"$2,340","status":"Shipped"},{"id":"ORD-002","customer":"TechStart","amount":"$890","status":"Processing"}]}}
{"type":"completeSurface","surfaceId":"dash","messageId":"m8","catalogVersion":"v1","timestamp":"2026-03-13T10:00:00Z"}`;
}
