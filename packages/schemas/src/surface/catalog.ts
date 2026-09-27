/**
 * Surface Sub-Catalog — Token-friendly component catalog for LLM surface generation.
 *
 * This is the machine-readable contract the LLM sees when generating streamable
 * surfaces. It's designed to be:
 * - Compact (minimal tokens)
 * - Self-documenting (defaults inline)
 * - Predictable (string unions, not freeform)
 *
 * The catalog is static and can be embedded in prompts or retrieved via
 * ui.catalog.get(mode="surface").
 */

// =============================================================================
// Catalog entry shape — what the LLM sees per component
// =============================================================================

export interface SurfaceCatalogProp {
  /** Prop name */
  readonly name: string;
  /** Compact type descriptor (e.g., 'string', 'number', '"sm"|"md"|"lg"') */
  readonly type: string;
  /** Whether required. Omit if false (default). */
  readonly required?: true;
  /** Default value as string. Omit if none. */
  readonly default?: string;
  /** One-line description. */
  readonly desc: string;
}

export interface SurfaceCatalogEntry {
  /** Component type name (e.g., 'Page', 'DataTable'). */
  readonly component: string;
  /** One-line description for the LLM. */
  readonly desc: string;
  /** Whether this component accepts children IDs. */
  readonly children?: boolean;
  /** Whether this component supports data-model bindings. */
  readonly bindable?: boolean;
  /** Which binding keys are meaningful for this component. */
  readonly bindingKeys?: readonly string[];
  /** Whether this component can have actions attached. */
  readonly actionable?: boolean;
  /** Compact prop definitions. */
  readonly props: readonly SurfaceCatalogProp[];
  /** Short usage note or constraint. */
  readonly note?: string;
}

// =============================================================================
// The catalog
// =============================================================================

export const SURFACE_CATALOG: readonly SurfaceCatalogEntry[] = [
  {
    component: 'Page',
    desc: 'Top-level container. One per surface. Wraps all content.',
    children: true,
    props: [
      { name: 'title', type: 'string', desc: 'Page title shown in header' },
      { name: 'subtitle', type: 'string', desc: 'Subtitle below title' },
      {
        name: 'padding',
        type: '"none"|"xs"|"sm"|"md"|"lg"|"xl"',
        default: 'lg',
        desc: 'Inner padding',
      },
      {
        name: 'maxWidth',
        type: '"sm"|"md"|"lg"|"xl"|"full"',
        default: 'lg',
        desc: 'Max content width',
      },
    ],
    note: 'Always create Page as the root component with rootIds: ["page"].',
  },
  {
    component: 'Section',
    desc: 'Groups related content with optional title and divider.',
    children: true,
    props: [
      { name: 'title', type: 'string', desc: 'Section heading' },
      { name: 'collapsible', type: 'boolean', default: 'false', desc: 'Allow collapse/expand' },
      {
        name: 'gap',
        type: '"none"|"xs"|"sm"|"md"|"lg"|"xl"',
        default: 'md',
        desc: 'Spacing between children',
      },
    ],
  },
  {
    component: 'Panel',
    desc: 'Elevated card container with border and padding.',
    children: true,
    props: [
      { name: 'title', type: 'string', desc: 'Panel header text' },
      {
        name: 'variant',
        type: '"default"|"outlined"|"elevated"|"filled"',
        default: 'default',
        desc: 'Visual style',
      },
      {
        name: 'padding',
        type: '"none"|"xs"|"sm"|"md"|"lg"|"xl"',
        default: 'md',
        desc: 'Inner padding',
      },
    ],
  },
  {
    component: 'Heading',
    desc: 'Semantic heading. Text comes from content prop or text binding.',
    bindable: true,
    bindingKeys: ['text'],
    props: [
      { name: 'level', type: '"1"|"2"|"3"|"4"', default: '2', desc: 'Heading level' },
      { name: 'align', type: '"start"|"center"|"end"', desc: 'Text alignment' },
    ],
    note: 'Set text via bindings.text or as inline static content in the component.',
  },
  {
    component: 'Text',
    desc: 'Body text. Set format:"markdown" for GFM (headings, lists, tables, code, links).',
    bindable: true,
    bindingKeys: ['text'],
    props: [
      { name: 'content', type: 'string', desc: 'Static text content' },
      { name: 'format', type: '"plain"|"markdown"', default: 'plain', desc: 'Rendering format' },
      { name: 'size', type: '"xs"|"sm"|"md"|"lg"|"xl"', default: 'md', desc: 'Font size' },
      { name: 'color', type: 'ColorIntent', default: 'default', desc: 'Semantic color' },
      { name: 'weight', type: '"normal"|"medium"|"semibold"|"bold"', desc: 'Font weight' },
      { name: 'align', type: '"start"|"center"|"end"', desc: 'Text alignment' },
    ],
  },
  {
    component: 'MetricGrid',
    desc: 'Responsive grid of metric cards. Bind items or set inline.',
    bindable: true,
    bindingKeys: ['items'],
    props: [
      { name: 'columns', type: '"2"|"3"|"4"|"auto"', default: 'auto', desc: 'Grid columns' },
      { name: 'size', type: '"xs"|"sm"|"md"|"lg"|"xl"', default: 'md', desc: 'Card size' },
      {
        name: 'items',
        type: 'Array<{label,value,unit?,trend?,icon?}>',
        desc: 'Inline metric items',
      },
    ],
    note: 'Each item: { label: string, value: string|number, unit?: string, trend?: "up"|"down"|"flat", icon?: string }.',
  },
  {
    component: 'DataTable',
    desc: 'Tabular data with sort, pagination, and responsive overflow.',
    bindable: true,
    bindingKeys: ['rows', 'columns'],
    props: [
      {
        name: 'columns',
        type: 'Array<{key,label,align?,sortable?,width?}>',
        desc: 'Column definitions',
      },
      { name: 'rows', type: 'Array<Record>', desc: 'Inline row data' },
      { name: 'striped', type: 'boolean', default: 'true', desc: 'Alternating row colors' },
      { name: 'compact', type: 'boolean', default: 'false', desc: 'Reduced row height' },
      { name: 'pageSize', type: 'number', default: '10', desc: 'Rows per page' },
    ],
    note: 'Bind rows via bindings.rows for dynamic data. columns can be inline or bound.',
  },
  {
    component: 'List',
    desc: 'Vertical list of items with optional icons and badges.',
    children: true,
    bindable: true,
    bindingKeys: ['items'],
    props: [
      {
        name: 'variant',
        type: '"unordered"|"ordered"|"plain"',
        default: 'plain',
        desc: 'List style',
      },
      {
        name: 'items',
        type: 'Array<{label,description?,icon?,badge?}>',
        desc: 'Inline list items',
      },
      { name: 'gap', type: '"none"|"xs"|"sm"|"md"|"lg"|"xl"', default: 'sm', desc: 'Item spacing' },
    ],
  },
  {
    component: 'Form',
    desc: 'Container for Field components. Submit action auto-sends data model.',
    children: true,
    actionable: true,
    props: [
      {
        name: 'layout',
        type: '"vertical"|"horizontal"|"inline"',
        default: 'vertical',
        desc: 'Field arrangement',
      },
      {
        name: 'gap',
        type: '"none"|"xs"|"sm"|"md"|"lg"|"xl"',
        default: 'md',
        desc: 'Field spacing',
      },
      { name: 'submitLabel', type: 'string', default: 'Submit', desc: 'Submit button text' },
    ],
    note: 'Form auto-generates a submit button. Add Fields as children with bindPath for two-way binding.',
  },
  {
    component: 'Field',
    desc: 'Form input field with label and two-way data binding.',
    bindable: true,
    bindingKeys: ['value'],
    props: [
      {
        name: 'fieldType',
        type: '"text"|"number"|"email"|"textarea"|"select"|"checkbox"|"date"|"password"',
        default: 'text',
        desc: 'Input type',
      },
      { name: 'label', type: 'string', desc: 'Field label' },
      { name: 'placeholder', type: 'string', desc: 'Placeholder text' },
      { name: 'required', type: 'boolean', default: 'false', desc: 'Required field' },
      { name: 'disabled', type: 'boolean', desc: 'Disabled state' },
      { name: 'options', type: 'Array<{label,value}>', desc: 'Options for select fields' },
      { name: 'bindPath', type: 'string', desc: 'JSON Pointer to data model for two-way binding' },
    ],
    note: 'bindPath (e.g., "/form/email") creates two-way binding — edits update local data model.',
  },
  {
    component: 'Button',
    desc: 'Clickable button with declarative action.',
    actionable: true,
    props: [
      { name: 'label', type: 'string', required: true, desc: 'Button text' },
      {
        name: 'variant',
        type: '"primary"|"secondary"|"outline"|"ghost"|"danger"',
        default: 'primary',
        desc: 'Visual style',
      },
      { name: 'size', type: '"xs"|"sm"|"md"|"lg"|"xl"', default: 'md', desc: 'Button size' },
      { name: 'icon', type: 'string', desc: 'Icon name from phoenix-icons' },
      { name: 'disabled', type: 'boolean', desc: 'Disabled state' },
      { name: 'loading', type: 'boolean', desc: 'Loading state' },
      { name: 'fullWidth', type: 'boolean', desc: 'Full-width button' },
    ],
    note: 'Attach an action: { eventName, eventType, target }. eventType must be one of: click, submit, invoke, select, navigate, change, message, custom. target: agent (send to AI), flow (flow event), client (local).',
  },
  {
    component: 'Chart',
    desc: 'Data visualization chart. Bind data or set inline.',
    bindable: true,
    bindingKeys: ['data'],
    props: [
      {
        name: 'chartType',
        type: '"line"|"bar"|"area"|"pie"|"sparkline"',
        default: 'bar',
        desc: 'Chart type',
      },
      { name: 'title', type: 'string', desc: 'Chart title' },
      { name: 'height', type: '"sm"|"md"|"lg"', default: 'md', desc: 'Chart height' },
      { name: 'xKey', type: 'string', desc: 'Data key for x-axis' },
      { name: 'yKey', type: 'string', desc: 'Data key for y-axis (single series)' },
      { name: 'series', type: 'Array<{key,label?,color?}>', desc: 'Multi-series definitions' },
      { name: 'data', type: 'Array<Record>', desc: 'Inline chart data' },
      { name: 'showLegend', type: 'boolean', default: 'true', desc: 'Show legend' },
      { name: 'showGrid', type: 'boolean', default: 'true', desc: 'Show grid lines' },
      {
        name: 'colors',
        type: 'string[]',
        desc: 'Data color tokens for bars/slices/series. Use "data-0"…"data-9": 0=coral, 1=amber, 2=slate, 3=blue, 4=emerald, 5=violet, 6=orange, 7=pink, 8=teal, 9=indigo. Append "/NN" for opacity (e.g., "data-3/50" = blue at 50%). Default: auto-cycles data-0…data-9.',
      },
    ],
  },
  {
    component: 'ChatComposer',
    desc: 'Message input with send button for conversational surfaces.',
    actionable: true,
    bindable: true,
    bindingKeys: ['message'],
    props: [
      {
        name: 'placeholder',
        type: 'string',
        default: 'Type a message...',
        desc: 'Input placeholder',
      },
      { name: 'bindPath', type: 'string', desc: 'Data model path for message text' },
      { name: 'multiline', type: 'boolean', default: 'true', desc: 'Allow multiline input' },
    ],
    note: 'Attach a "message" action for send behavior. Uses includeDataModel: true by default.',
  },
  {
    component: 'Image',
    desc: 'Responsive image with aspect ratio and optional caption.',
    bindable: true,
    bindingKeys: ['src'],
    props: [
      { name: 'src', type: 'string', desc: 'Image URL' },
      { name: 'alt', type: 'string', desc: 'Alt text for accessibility' },
      {
        name: 'aspectRatio',
        type: '"auto"|"1:1"|"4:3"|"16:9"|"21:9"',
        default: 'auto',
        desc: 'Aspect ratio',
      },
      { name: 'fit', type: '"cover"|"contain"|"fill"', default: 'cover', desc: 'Object-fit mode' },
      { name: 'caption', type: 'string', desc: 'Caption below image' },
    ],
  },
  {
    component: 'CodeBlock',
    desc: 'Syntax-highlighted code with copy button.',
    bindable: true,
    bindingKeys: ['code'],
    props: [
      { name: 'language', type: 'string', desc: 'Language for syntax highlighting' },
      { name: 'code', type: 'string', desc: 'Inline code content' },
      { name: 'showLineNumbers', type: 'boolean', default: 'false', desc: 'Show line numbers' },
      {
        name: 'maxHeight',
        type: '"sm"|"md"|"lg"|"none"',
        default: 'md',
        desc: 'Max height with scroll',
      },
    ],
  },
  {
    component: 'Divider',
    desc: 'Horizontal separator line.',
    props: [
      {
        name: 'spacing',
        type: '"none"|"xs"|"sm"|"md"|"lg"|"xl"',
        default: 'md',
        desc: 'Vertical spacing',
      },
    ],
  },
  {
    component: 'Badge',
    desc: 'Small label/tag for status or category.',
    bindable: true,
    bindingKeys: ['label'],
    props: [
      { name: 'label', type: 'string', required: true, desc: 'Badge text' },
      { name: 'color', type: 'ColorIntent', default: 'default', desc: 'Semantic color' },
      { name: 'size', type: '"sm"|"md"', default: 'md', desc: 'Badge size' },
    ],
  },
  {
    component: 'Icon',
    desc: 'Standalone icon from phoenix-icons.',
    props: [
      { name: 'name', type: 'string', required: true, desc: 'Icon name' },
      { name: 'size', type: '"xs"|"sm"|"md"|"lg"|"xl"', default: 'md', desc: 'Icon size' },
      { name: 'color', type: 'ColorIntent', desc: 'Semantic color' },
    ],
  },
] as const;

/**
 * ColorIntent values used throughout the surface catalog.
 * Documented separately for the LLM prompt.
 */
export const SURFACE_COLOR_INTENTS = [
  'default',
  'primary',
  'secondary',
  'success',
  'warning',
  'danger',
  'info',
  'accent',
  'muted',
] as const;

/**
 * Action definition shape for the LLM prompt.
 * Components with actionable: true can have actions.
 */
export const SURFACE_ACTION_SHAPE = {
  eventName: 'string (domain name, e.g., "item.select", "form.submit")',
  eventType: '"message"|"submit"|"navigate"|"invoke"|"select"|"change"|"custom"',
  target: '"agent"|"flow"|"step"|"client" (default: "agent")',
  payloadTemplate: 'Record<string, literal | { bind: "/json/pointer" }> (optional)',
  includeDataModel: 'boolean (send full surface data model with event, default: false)',
} as const;
