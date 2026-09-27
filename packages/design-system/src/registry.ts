// =============================================================================
// Types
// =============================================================================

export type ComponentCategory =
  'layout' | 'typography' | 'display' | 'collection' | 'interactive' | 'chart' | 'aflow';

export type CategoryTier = 1 | 2;

export const categoryTiers: Record<ComponentCategory, CategoryTier> = {
  layout: 1,
  typography: 1,
  display: 1,
  collection: 1,
  interactive: 1,
  chart: 2,
  aflow: 1, // internal — filtered by availableInModes, not tier
};

export type IntentTag =
  | 'primaryAction'
  | 'secondaryAction'
  | 'dangerAction'
  | 'readOnly'
  | 'editable'
  | 'statusIndicator'
  | 'systemMessage'
  | 'userMessage'
  | 'toolCall'
  | 'timelineEvent'
  | 'dataDisplay'
  | 'codeDisplay'
  | 'interactive'
  | 'decorative'
  | 'composition'
  | 'navigation';

export interface PropDefinition {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description: string;
}

export interface ComponentDefinition {
  name: string;
  importPath: string;
  category: ComponentCategory;
  intents: IntentTag[];
  description: string;
  props: PropDefinition[];
  doNot?: string[];
  combinesWith?: string[];
  a11y?: string;
  /** Natural language synonyms for agent discovery */
  synonyms?: string[];
  /** When to prefer this over alternatives */
  preferOver?: string;
  /**
   * Which rendering modes this component is available in.
   * - 'artifact': model-generated standalone UI artifacts
   * - 'surface': embedded streamable surfaces
   * - 'dev': internal / developer-only (hidden from model-facing catalogs)
   * Defaults to ['artifact', 'surface'] if omitted.
   */
  availableInModes?: Array<'artifact' | 'surface' | 'dev'>;
  /**
   * Whether this component accepts children.
   * Defaults to true if omitted.
   */
  childrenAllowed?: boolean;
}

// =============================================================================
// Registry
// =============================================================================

export const componentRegistry: ComponentDefinition[] = [
  // ===== Layout =====
  {
    name: 'Row',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['composition'],
    description:
      'Horizontal flex container — the primary layout primitive for side-by-side content',
    synonyms: ['horizontal group', 'inline', 'flex row', 'hstack'],
    preferOver: 'Use Row instead of raw div with display:flex and flexDirection:row',
    props: [
      {
        name: 'gap',
        type: 'SpaceToken',
        required: false,
        default: 'md',
        description: 'Gap between children',
      },
      {
        name: 'align',
        type: "'start' | 'center' | 'end' | 'baseline' | 'stretch'",
        required: false,
        default: 'center',
        description: 'Cross-axis alignment',
      },
      {
        name: 'justify',
        type: "'start' | 'center' | 'end' | 'between' | 'around' | 'evenly'",
        required: false,
        default: 'start',
        description: 'Main-axis distribution',
      },
      {
        name: 'wrap',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Allow wrapping',
      },
      {
        name: 'fill',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Fill remaining space in flex parent (flex: 1)',
      },
      { name: 'padding', type: 'SpaceToken', required: false, description: 'Padding' },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Column',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['composition'],
    description: 'Vertical flex container — the primary layout primitive for stacked content',
    synonyms: ['vertical group', 'stack', 'flex column', 'vstack'],
    preferOver: 'Use Column instead of raw div with display:flex and flexDirection:column',
    props: [
      {
        name: 'gap',
        type: 'SpaceToken',
        required: false,
        default: 'md',
        description: 'Gap between children',
      },
      {
        name: 'align',
        type: "'start' | 'center' | 'end' | 'stretch'",
        required: false,
        default: 'stretch',
        description: 'Cross-axis alignment',
      },
      {
        name: 'justify',
        type: "'start' | 'center' | 'end' | 'between' | 'around'",
        required: false,
        default: 'start',
        description: 'Main-axis distribution',
      },
      {
        name: 'fill',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Fill remaining space in flex parent (flex: 1)',
      },
      { name: 'padding', type: 'SpaceToken', required: false, description: 'Padding' },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Grid',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['composition'],
    description: 'CSS grid container — for multi-column layouts with responsive auto-fill',
    synonyms: ['grid layout', 'responsive grid', 'card grid'],
    props: [
      { name: 'columns', type: 'number', required: false, description: 'Fixed column count' },
      {
        name: 'minChildWidth',
        type: 'string',
        required: false,
        default: '280px',
        description: 'Min child width for auto-fill',
      },
      {
        name: 'gap',
        type: 'SpaceToken',
        required: false,
        default: 'lg',
        description: 'Gap between items',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Panel',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['composition'],
    description: 'Surface container with border and optional elevation',
    synonyms: ['panel', 'surface', 'container', 'box'],
    props: [
      {
        name: 'variant',
        type: "'default' | 'subtle' | 'elevated' | 'outline'",
        required: false,
        default: 'default',
        description: 'Visual treatment',
      },
      {
        name: 'padding',
        type: 'SpaceToken',
        required: false,
        default: 'lg',
        description: 'Padding',
      },
      {
        name: 'rounded',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Border radius',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Section',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['composition'],
    description: 'Semantic section with optional title and description',
    synonyms: ['content section', 'titled section'],
    props: [
      { name: 'title', type: 'ReactNode', required: false, description: 'Section title' },
      {
        name: 'description',
        type: 'ReactNode',
        required: false,
        description: 'Section description',
      },
      {
        name: 'gap',
        type: 'SpaceToken',
        required: false,
        default: 'lg',
        description: 'Gap between header and body',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Box',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['decorative'],
    description:
      'Generic layout escape hatch with spacing props — prefer Row/Column/Panel for most cases',
    doNot: ['Do not use Box when Row, Column, Panel, or Section would work'],
    availableInModes: ['dev'],
    props: [
      { name: 'p', type: 'SpaceToken', required: false, description: 'Padding (all sides)' },
      { name: 'px', type: 'SpaceToken', required: false, description: 'Horizontal padding' },
      { name: 'py', type: 'SpaceToken', required: false, description: 'Vertical padding' },
      { name: 'as', type: 'string', required: false, default: 'div', description: 'HTML element' },
    ],
    childrenAllowed: true,
  },
  {
    name: 'ScrollArea',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['composition'],
    description: 'Scrollable container with subtle scrollbar styling',
    props: [
      {
        name: 'direction',
        type: "'vertical' | 'horizontal' | 'both'",
        required: false,
        default: 'vertical',
        description: 'Scroll direction',
      },
      {
        name: 'grow',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Fill available space',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Spacer',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['decorative'],
    description: 'Flexible spacer — fills remaining space or creates fixed gaps',
    props: [
      {
        name: 'size',
        type: 'SpaceToken',
        required: false,
        description: 'Fixed size (omit for flex fill)',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Divider',
    importPath: '@aflow/design-system',
    category: 'layout',
    intents: ['decorative'],
    description:
      'Horizontal or vertical divider line — use for section breaks, not Panel as a fake divider',
    preferOver: 'Use Divider instead of thin Panels or empty layout wrappers as visual lines',
    props: [
      {
        name: 'subtle',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Use lighter color',
      },
      {
        name: 'orientation',
        type: "'horizontal' | 'vertical'",
        required: false,
        default: 'horizontal',
        description: 'Direction',
      },
      { name: 'my', type: 'SpaceToken', required: false, description: 'Vertical margin' },
    ],
    childrenAllowed: false,
  },

  // ===== Typography =====
  {
    name: 'Text',
    importPath: '@aflow/design-system',
    category: 'typography',
    intents: ['readOnly'],
    description: 'Typography primitive for body text, labels, and inline content',
    props: [
      {
        name: 'variant',
        type: "'body' | 'muted' | 'heading' | 'mono' | 'label'",
        required: false,
        default: 'body',
        description: 'Typography variant',
      },
      { name: 'size', type: 'FontSizeToken', required: false, description: 'Font size' },
      {
        name: 'color',
        type: "'primary' | 'secondary' | 'muted' | 'inverse'",
        required: false,
        description: 'Text color',
      },
      {
        name: 'tone',
        type: "'danger' | 'warning' | 'success' | 'info' | 'accent'",
        required: false,
        description: 'Semantic tone — overrides color with a semantic foreground color',
      },
      {
        name: 'truncate',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Truncate with ellipsis',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Heading',
    importPath: '@aflow/design-system',
    category: 'typography',
    intents: ['readOnly'],
    description: 'Section heading (h1-h6) with automatic size mapping',
    props: [
      {
        name: 'level',
        type: '1 | 2 | 3 | 4 | 5 | 6',
        required: false,
        default: '2',
        description: 'Heading level',
      },
    ],
    a11y: 'Use semantic heading levels in order (h1 > h2 > h3)',
    childrenAllowed: true,
  },
  {
    name: 'Markdown',
    importPath: '@aflow/design-system',
    category: 'typography',
    intents: ['readOnly'],
    description: 'Renders markdown content with design system typography',
    props: [{ name: 'children', type: 'string', required: true, description: 'Markdown content' }],
    childrenAllowed: false,
  },

  // ===== Display =====
  {
    name: 'Button',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['primaryAction', 'secondaryAction', 'dangerAction', 'interactive'],
    description: 'Clickable button for user actions',
    props: [
      {
        name: 'variant',
        type: "'primary' | 'secondary' | 'ghost' | 'danger'",
        required: false,
        default: 'primary',
        description: 'Visual style',
      },
      {
        name: 'size',
        type: "'sm' | 'md' | 'lg'",
        required: false,
        default: 'md',
        description: 'Size',
      },
      {
        name: 'loading',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Show loading spinner',
      },
      {
        name: 'disabled',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Disable interaction',
      },
    ],
    doNot: ["Don't use danger variant for non-destructive actions"],
    a11y: 'Always provide text content or aria-label',
    childrenAllowed: true,
  },
  {
    name: 'IconButton',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['secondaryAction', 'interactive'],
    description: 'Icon-only button — requires aria-label',
    props: [
      { name: 'icon', type: 'ReactNode', required: true, description: 'Icon element' },
      { name: 'aria-label', type: 'string', required: true, description: 'Accessible label' },
      {
        name: 'variant',
        type: "'primary' | 'secondary' | 'ghost' | 'danger'",
        required: false,
        default: 'ghost',
        description: 'Visual style',
      },
    ],
    a11y: 'aria-label is required',
    childrenAllowed: false,
  },
  {
    name: 'Badge',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['statusIndicator', 'readOnly'],
    description: 'Small status indicator with optional icon',
    props: [
      {
        name: 'variant',
        type: "'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'accent'",
        required: false,
        default: 'neutral',
        description: 'Color variant',
      },
      { name: 'icon', type: 'ReactNode', required: false, description: 'Left icon' },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Avatar',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['decorative'],
    description: 'User avatar with image fallback',
    props: [
      { name: 'src', type: 'string', required: true, description: 'Image URL' },
      { name: 'alt', type: 'string', required: true, description: 'Alt text' },
      {
        name: 'size',
        type: "'sm' | 'md' | 'lg'",
        required: false,
        default: 'md',
        description: 'Size',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Icon',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['decorative'],
    description: 'Icon component with curated Phoenix icon names',
    props: [
      { name: 'name', type: 'IconName', required: true, description: 'Phoenix icon name' },
      {
        name: 'size',
        type: "'xs' | 'sm' | 'md' | 'lg' | 'xl' | number",
        required: false,
        default: 'md',
        description: 'Size',
      },
      {
        name: 'color',
        type: 'string',
        required: false,
        default: 'currentColor',
        description: 'Color',
      },
      {
        name: 'weight',
        type: "'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone'",
        required: false,
        default: 'regular',
        description: 'Weight',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Image',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['readOnly'],
    description: 'Responsive image with optional alt text and loading states',
    props: [
      { name: 'src', type: 'string', required: true, description: 'Image URL' },
      { name: 'alt', type: 'string', required: true, description: 'Alt text' },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Progress',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['statusIndicator', 'readOnly'],
    description: 'Progress bar with percentage or indeterminate state',
    props: [
      { name: 'value', type: 'number', required: false, description: 'Progress value (0-100)' },
    ],
    childrenAllowed: false,
  },
  {
    name: 'EmptyState',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['readOnly'],
    description: 'Placeholder for empty content areas',
    props: [
      { name: 'title', type: 'string', required: true, description: 'Title' },
      { name: 'description', type: 'string', required: false, description: 'Description' },
      { name: 'icon', type: 'ReactNode', required: false, description: 'Icon' },
      { name: 'action', type: 'ReactNode', required: false, description: 'Action button' },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Spinner',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['statusIndicator'],
    description: 'Loading spinner',
    props: [
      {
        name: 'size',
        type: "'sm' | 'md' | 'lg'",
        required: false,
        default: 'md',
        description: 'Size',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Alert',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['readOnly', 'statusIndicator'],
    description: 'Alert banner for info, success, warning, or error messages',
    props: [
      {
        name: 'variant',
        type: "'info' | 'success' | 'warning' | 'danger'",
        required: false,
        default: 'info',
        description: 'Alert variant',
      },
      { name: 'title', type: 'string', required: false, description: 'Alert title' },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Card',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['decorative'],
    description: 'Container with border and optional shadow',
    combinesWith: ['CardHeader', 'CardBody', 'CardFooter'],
    props: [
      {
        name: 'elevated',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Add shadow',
      },
      {
        name: 'interactive',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Hover effect',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Accordion',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['interactive', 'dataDisplay'],
    description: 'Expandable/collapsible content sections',
    synonyms: ['disclosure', 'expandable list', 'collapsible'],
    availableInModes: ['artifact', 'surface'],
    props: [
      {
        name: 'items',
        type: 'AccordionItemData[]',
        required: true,
        description: 'Items to render',
      },
      {
        name: 'multiple',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Allow multiple open',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'PropertyTable',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['dataDisplay', 'readOnly'],
    description: 'Schema/property table with expandable nested fields',
    synonyms: ['schema table', 'field table', 'property list'],
    props: [
      { name: 'fields', type: 'PropertyField[]', required: true, description: 'Fields to display' },
    ],
    childrenAllowed: false,
  },
  {
    name: 'KeyValueTable',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['dataDisplay', 'readOnly'],
    description: 'Key-value pair display',
    props: [
      {
        name: 'items',
        type: 'Array<{ key: string; value: ReactNode }>',
        required: true,
        description: 'Key-value pairs',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'CodeBlock',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['codeDisplay', 'readOnly'],
    description: 'Code display with optional copy button',
    props: [
      { name: 'children', type: 'string', required: true, description: 'Code content' },
      { name: 'language', type: 'string', required: false, description: 'Language label' },
    ],
    childrenAllowed: false,
  },
  {
    name: 'JsonViewer',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['dataDisplay', 'codeDisplay'],
    description: 'Interactive JSON viewer with collapse/expand',
    props: [
      { name: 'data', type: 'unknown', required: true, description: 'JSON data' },
      {
        name: 'collapsed',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Start collapsed',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Timeline',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['timelineEvent', 'dataDisplay'],
    description: 'Vertical timeline container',
    combinesWith: ['TimelineItem'],
    availableInModes: ['dev'],
    props: [],
    childrenAllowed: true,
  },
  {
    name: 'Tooltip',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['readOnly'],
    description: 'Hover tooltip for additional context',
    availableInModes: ['dev'],
    props: [
      { name: 'content', type: 'string', required: true, description: 'Tooltip text' },
      {
        name: 'side',
        type: "'top' | 'right' | 'bottom' | 'left'",
        required: false,
        default: 'right',
        description: 'Position',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Logo',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['decorative'],
    description: 'Phoenix brand logo',
    availableInModes: ['dev'],
    props: [
      { name: 'variant', type: "'color' | 'mono'", required: false, description: 'Color mode' },
      { name: 'size', type: 'number', required: false, description: 'Size in pixels' },
    ],
    childrenAllowed: false,
  },

  // ===== Collection =====
  {
    name: 'List',
    importPath: '@aflow/design-system',
    category: 'collection',
    intents: ['composition', 'dataDisplay'],
    description:
      'Container for repeated homogeneous items — prefer over manual Column + Panel stacks',
    preferOver: 'Use List + ListItem instead of Column with repeated Panels for collections',
    props: [
      {
        name: 'gap',
        type: "'none' | 'xs' | 'sm' | 'md'",
        required: false,
        default: 'sm',
        description: 'Gap between items (ignored when dividers is true)',
      },
      {
        name: 'dividers',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Show divider lines between items',
      },
    ],
  },
  {
    name: 'ListItem',
    importPath: '@aflow/design-system',
    category: 'collection',
    intents: ['composition', 'dataDisplay'],
    description:
      'Structured list item with leading/main/trailing slots — handles alignment and spacing automatically',
    props: [
      {
        name: 'icon',
        type: 'ReactNode',
        required: false,
        description: 'Leading icon element (mutual exclusive with avatar)',
      },
      {
        name: 'avatar',
        type: 'ReactNode',
        required: false,
        description: 'Leading avatar element (mutual exclusive with icon)',
      },
      { name: 'title', type: 'string', required: false, description: 'Primary text' },
      {
        name: 'subtitle',
        type: 'string',
        required: false,
        description: 'Secondary text below title',
      },
      {
        name: 'value',
        type: 'ReactNode',
        required: false,
        description: 'Trailing value text (e.g. price, count, date)',
      },
      {
        name: 'trailing',
        type: 'ReactNode',
        required: false,
        description: 'Trailing element (overrides value)',
      },
      {
        name: 'clickable',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Show hover/press affordance',
      },
      {
        name: 'selected',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Selected state',
      },
      { name: 'onClick', type: '() => void', required: false, description: 'Click handler' },
    ],
    childrenAllowed: true,
  },

  // ===== Formatting =====
  {
    name: 'Value',
    importPath: '@aflow/design-system',
    category: 'display',
    intents: ['readOnly', 'dataDisplay'],
    description:
      'Formatted numeric value — currency, percentage, compact notation, or plain number',
    synonyms: ['formatted number', 'currency', 'percentage', 'metric'],
    props: [
      { name: 'amount', type: 'number', required: true, description: 'Numeric value to format' },
      {
        name: 'format',
        type: "'currency' | 'percent' | 'compact' | 'number'",
        required: false,
        default: 'number',
        description: 'Format type',
      },
      {
        name: 'currency',
        type: 'string',
        required: false,
        default: 'USD',
        description: 'Currency code (when format is currency)',
      },
      {
        name: 'decimals',
        type: 'number',
        required: false,
        description: 'Number of decimal places',
      },
    ],
    childrenAllowed: false,
  },

  // ===== Interactive =====
  {
    name: 'SearchField',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['editable', 'interactive'],
    description: 'Search input with built-in magnifying glass icon',
    synonyms: ['search input', 'search bar', 'filter input'],
    props: [
      {
        name: 'placeholder',
        type: 'string',
        required: false,
        default: 'Search...',
        description: 'Placeholder text',
      },
      {
        name: 'onValueChange',
        type: '(value: string) => void',
        required: false,
        description: 'Value change callback',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'FilterChips',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['interactive'],
    description: 'Pill-style filter selection group',
    synonyms: ['filter pills', 'chip group', 'segmented control'],
    props: [
      {
        name: 'options',
        type: 'FilterChipOption[]',
        required: true,
        description: 'Available options',
      },
      {
        name: 'value',
        type: 'string | string[]',
        required: false,
        description: 'Selected value(s)',
      },
      {
        name: 'onChange',
        type: '(value: string) => void',
        required: false,
        description: 'Change handler',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'Field',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['editable'],
    description: 'Form field wrapper with label, helper text, and error',
    props: [
      { name: 'label', type: 'string', required: false, description: 'Field label' },
      {
        name: 'required',
        type: 'boolean',
        required: false,
        description: 'Show required indicator',
      },
      { name: 'helperText', type: 'string', required: false, description: 'Helper text' },
      { name: 'error', type: 'string', required: false, description: 'Error message' },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Input',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['editable', 'interactive'],
    description: 'Text input field',
    combinesWith: ['Field'],
    props: [
      { name: 'placeholder', type: 'string', required: false, description: 'Placeholder' },
      { name: 'error', type: 'boolean', required: false, description: 'Error state' },
    ],
    childrenAllowed: false,
  },
  {
    name: 'SelectTrigger',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['editable', 'interactive', 'navigation'],
    description:
      'Button styled like a select control — opens a custom menu, listbox, or dialog. Pair with a popover, sheet, or menu; use native Select when <option> children are enough.',
    synonyms: ['dropdown trigger', 'combobox trigger', 'picker button', 'flow selector'],
    combinesWith: ['Dialog', 'Select', 'Field'],
    preferOver:
      'Use SelectTrigger for custom pickers; use native Select for simple HTML option lists.',
    props: [
      {
        name: 'leadingIcon',
        type: 'ReactNode',
        required: false,
        description: 'Optional icon before the label',
      },
      {
        name: 'showCaret',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show caret-down on the right',
      },
      {
        name: 'trailingSlot',
        type: 'ReactNode',
        required: false,
        description: 'Replaces the default caret',
      },
      {
        name: 'isPlaceholder',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Muted label when no value is selected',
      },
      {
        name: 'error',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Error border state',
      },
      {
        name: 'expanded',
        type: 'boolean',
        required: false,
        description: 'Maps to aria-expanded when the popup is open',
      },
      {
        name: 'popup',
        type: "'listbox' | 'menu' | 'dialog' | 'true' | 'false'",
        required: false,
        default: 'listbox',
        description: 'aria-haspopup for the attached surface',
      },
    ],
    a11y: 'Set aria-label when the label is not descriptive alone; match expanded and popup to the control you open',
    childrenAllowed: true,
  },
  {
    name: 'SegmentedSwitch',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['interactive'],
    description:
      'Icon-only switch between mutually exclusive views; the selection is a thumb that travels',
    props: [
      {
        name: 'items',
        type: 'Array<{ value: string; icon: ReactNode; label: string; badge?: number }>',
        required: true,
        description: 'Two or more views, in travel order',
      },
      { name: 'value', type: 'string', required: true, description: "Selected item's value" },
      { name: 'onChange', type: '(value: string) => void', required: true, description: 'Handler' },
      {
        name: 'label',
        type: 'string',
        required: true,
        description: 'Accessible name for the group',
      },
      { name: 'size', type: "'sm' | 'md'", required: false, default: 'md', description: 'Density' },
    ],
    a11y: 'Each segment carries its label as aria-label; the group needs a name via label',
    childrenAllowed: false,
  },
  {
    name: 'Tabs',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['navigation', 'interactive'],
    description: 'Tab container for switching between views',
    combinesWith: ['TabList', 'Tab', 'TabPanel'],
    props: [
      { name: 'defaultTab', type: 'string', required: false, description: 'Default active tab' },
      { name: 'value', type: 'string', required: false, description: 'Controlled active tab' },
      {
        name: 'onChange',
        type: '(tabId: string) => void',
        required: false,
        description: 'Tab change handler',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Toolbar',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['composition'],
    description: 'Toolbar container for search, filter, and action controls',
    synonyms: ['action bar', 'control bar'],
    combinesWith: ['ToolbarRow', 'SearchField', 'FilterChips'],
    props: [
      {
        name: 'gap',
        type: 'SpaceToken',
        required: false,
        default: 'md',
        description: 'Gap between sections',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'Dialog',
    importPath: '@aflow/design-system',
    category: 'interactive',
    intents: ['interactive'],
    description: 'Modal dialog with focus trap and escape handling',
    availableInModes: ['dev'],
    props: [
      { name: 'open', type: 'boolean', required: true, description: 'Open state' },
      { name: 'onClose', type: '() => void', required: true, description: 'Close handler' },
      { name: 'title', type: 'string', required: false, description: 'Dialog title' },
      {
        name: 'width',
        type: "'sm' | 'md' | 'lg' | 'xl'",
        required: false,
        default: 'md',
        description: 'Width',
      },
    ],
    a11y: 'Implements focus trap, escape to close, aria-modal',
    childrenAllowed: true,
  },

  // ===== Chart (Tier 2) =====
  {
    name: 'LineChart',
    importPath: '@aflow/design-system/charts',
    category: 'chart',
    intents: ['dataDisplay'],
    description:
      'Line chart for time-series or continuous data — requires explicit xKey and yKeys axis configuration',
    synonyms: ['line graph', 'trend line', 'time series'],
    props: [
      {
        name: 'data',
        type: 'Array<Record<string, unknown>>',
        required: true,
        description: 'Array of data objects',
      },
      {
        name: 'xKey',
        type: 'string',
        required: true,
        description: 'Key in data for X axis values',
      },
      {
        name: 'yKeys',
        type: 'string[]',
        required: true,
        description: 'Keys in data for Y axis series',
      },
      {
        name: 'height',
        type: 'number',
        required: false,
        default: '300',
        description: 'Chart height in pixels',
      },
      { name: 'colors', type: 'string[]', required: false, description: 'Custom series colors' },
      {
        name: 'showGrid',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show grid lines',
      },
      {
        name: 'showLegend',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show legend (auto-hidden for single series)',
      },
      {
        name: 'showTooltip',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show hover tooltip',
      },
      {
        name: 'curved',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Use curved lines (monotone interpolation)',
      },
    ],
    doNot: ['Do not auto-detect axis keys — always provide explicit xKey and yKeys'],
    childrenAllowed: false,
  },
  {
    name: 'BarChart',
    importPath: '@aflow/design-system/charts',
    category: 'chart',
    intents: ['dataDisplay'],
    description: 'Bar chart for categorical comparisons — requires explicit xKey and yKeys',
    synonyms: ['bar graph', 'column chart', 'histogram'],
    props: [
      {
        name: 'data',
        type: 'Array<Record<string, unknown>>',
        required: true,
        description: 'Array of data objects',
      },
      {
        name: 'xKey',
        type: 'string',
        required: true,
        description: 'Key in data for X axis categories',
      },
      {
        name: 'yKeys',
        type: 'string[]',
        required: true,
        description: 'Keys in data for Y axis values',
      },
      {
        name: 'height',
        type: 'number',
        required: false,
        default: '300',
        description: 'Chart height in pixels',
      },
      { name: 'colors', type: 'string[]', required: false, description: 'Custom bar colors' },
      {
        name: 'stacked',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Stack bars instead of grouping',
      },
      {
        name: 'showGrid',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show grid lines',
      },
      {
        name: 'showLegend',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show legend',
      },
      {
        name: 'showTooltip',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show hover tooltip',
      },
    ],
    doNot: ['Do not auto-detect axis keys — always provide explicit xKey and yKeys'],
    childrenAllowed: false,
  },
  {
    name: 'AreaChart',
    importPath: '@aflow/design-system/charts',
    category: 'chart',
    intents: ['dataDisplay'],
    description: 'Area chart for volume or cumulative trends — requires explicit xKey and yKeys',
    synonyms: ['filled line chart', 'area graph', 'stacked area'],
    props: [
      {
        name: 'data',
        type: 'Array<Record<string, unknown>>',
        required: true,
        description: 'Array of data objects',
      },
      {
        name: 'xKey',
        type: 'string',
        required: true,
        description: 'Key in data for X axis values',
      },
      {
        name: 'yKeys',
        type: 'string[]',
        required: true,
        description: 'Keys in data for Y axis series',
      },
      {
        name: 'height',
        type: 'number',
        required: false,
        default: '300',
        description: 'Chart height in pixels',
      },
      { name: 'colors', type: 'string[]', required: false, description: 'Custom area colors' },
      {
        name: 'stacked',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Stack areas',
      },
      {
        name: 'showGrid',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show grid lines',
      },
      {
        name: 'showLegend',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show legend',
      },
      {
        name: 'showTooltip',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show hover tooltip',
      },
      {
        name: 'curved',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Use curved areas',
      },
    ],
    doNot: ['Do not auto-detect axis keys — always provide explicit xKey and yKeys'],
    childrenAllowed: false,
  },
  {
    name: 'PieChart',
    importPath: '@aflow/design-system/charts',
    category: 'chart',
    intents: ['dataDisplay'],
    description:
      'Pie/donut chart for part-of-whole distribution — requires explicit nameKey and valueKey',
    synonyms: ['donut chart', 'pie graph', 'distribution chart'],
    props: [
      {
        name: 'data',
        type: 'Array<Record<string, unknown>>',
        required: true,
        description: 'Array of data objects',
      },
      {
        name: 'nameKey',
        type: 'string',
        required: true,
        description: 'Key in data for slice labels',
      },
      {
        name: 'valueKey',
        type: 'string',
        required: true,
        description: 'Key in data for slice values',
      },
      {
        name: 'height',
        type: 'number',
        required: false,
        default: '300',
        description: 'Chart height in pixels',
      },
      { name: 'colors', type: 'string[]', required: false, description: 'Custom slice colors' },
      {
        name: 'donut',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Render as donut (hollow center)',
      },
      {
        name: 'showLegend',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show legend',
      },
      {
        name: 'showTooltip',
        type: 'boolean',
        required: false,
        default: 'true',
        description: 'Show hover tooltip',
      },
      {
        name: 'showLabels',
        type: 'boolean',
        required: false,
        default: 'false',
        description: 'Show labels on slices',
      },
    ],
    doNot: ['Do not auto-detect name/value keys — always provide explicit nameKey and valueKey'],
    childrenAllowed: false,
  },
  {
    name: 'Sparkline',
    importPath: '@aflow/design-system/charts',
    category: 'chart',
    intents: ['dataDisplay'],
    description: 'Compact inline sparkline for showing trends in tight spaces — no axes, no legend',
    synonyms: ['mini chart', 'inline trend', 'spark'],
    props: [
      {
        name: 'data',
        type: 'Array<Record<string, unknown>>',
        required: true,
        description: 'Array of data objects',
      },
      { name: 'valueKey', type: 'string', required: true, description: 'Key in data for Y values' },
      {
        name: 'width',
        type: 'number',
        required: false,
        default: '120',
        description: 'Width in pixels',
      },
      {
        name: 'height',
        type: 'number',
        required: false,
        default: '32',
        description: 'Height in pixels',
      },
      { name: 'color', type: 'string', required: false, description: 'Line color' },
    ],
    doNot: ['Do not use for detailed charts — use LineChart instead'],
    childrenAllowed: false,
  },

  // ===== Aflow Domain (dev-only) =====
  {
    name: 'RunStatusBadge',
    importPath: '@aflow/design-system',
    category: 'aflow',
    intents: ['statusIndicator'],
    description: 'Flow run status with color and icon',
    availableInModes: ['dev'],
    props: [
      { name: 'status', type: 'RunStatus', required: true, description: 'Run status' },
      {
        name: 'pauseType',
        type: 'PauseType',
        required: false,
        description: 'Pause type for context-aware label when PAUSED',
      },
    ],
    childrenAllowed: false,
  },
  {
    name: 'ChatLayout',
    importPath: '@aflow/design-system',
    category: 'aflow',
    intents: ['composition'],
    description: 'Chat page layout with header, messages area, and composer',
    availableInModes: ['dev'],
    props: [
      { name: 'header', type: 'ReactNode', required: false, description: 'Header content' },
      { name: 'composer', type: 'ReactNode', required: false, description: 'Composer area' },
    ],
    childrenAllowed: true,
  },
  {
    name: 'ChatMessage',
    importPath: '@aflow/design-system',
    category: 'aflow',
    intents: ['userMessage', 'systemMessage', 'toolCall'],
    description: 'Single chat message with role-based styling',
    availableInModes: ['dev'],
    props: [
      {
        name: 'role',
        type: "'user' | 'assistant' | 'system' | 'tool'",
        required: true,
        description: 'Message role',
      },
    ],
    childrenAllowed: true,
  },
  {
    name: 'PageHeader',
    importPath: '@aflow/design-system',
    category: 'aflow',
    intents: ['composition'],
    description:
      'Full-width page header bar with title, subtitle, and actions (no max-width; no top margin)',
    availableInModes: ['dev'],
    props: [
      { name: 'title', type: 'ReactNode', required: false, description: 'Page title' },
      { name: 'subtitle', type: 'ReactNode', required: false, description: 'Subtitle' },
      { name: 'actions', type: 'ReactNode', required: false, description: 'Right-side actions' },
    ],
    childrenAllowed: true,
  },
];

// =============================================================================
// Registry Helpers
// =============================================================================

export function getComponentsByCategory(category: ComponentCategory): ComponentDefinition[] {
  return componentRegistry.filter((c) => c.category === category);
}

export function getComponentsByIntent(intent: IntentTag): ComponentDefinition[] {
  return componentRegistry.filter((c) => c.intents.includes(intent));
}

export function getComponent(name: string): ComponentDefinition | undefined {
  return componentRegistry.find((c) => c.name === name);
}

export function exportRegistryJson(): string {
  return JSON.stringify(componentRegistry, null, 2);
}

/** Find components by natural language synonym */
export function findComponentBySynonym(query: string): ComponentDefinition[] {
  const q = query.toLowerCase();
  return componentRegistry.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.synonyms?.some((s) => s.toLowerCase().includes(q)),
  );
}

/** Get components available in a specific rendering mode */
export function getComponentsByMode(mode: 'artifact' | 'surface' | 'dev'): ComponentDefinition[] {
  return componentRegistry.filter((c) => {
    const modes = c.availableInModes ?? ['artifact', 'surface'];
    return modes.includes(mode);
  });
}

/** Get all tier-1 categories */
export function getTier1Categories(): ComponentCategory[] {
  return (Object.entries(categoryTiers) as Array<[ComponentCategory, CategoryTier]>)
    .filter(([, tier]) => tier === 1)
    .map(([cat]) => cat);
}
