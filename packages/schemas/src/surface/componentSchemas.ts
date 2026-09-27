/**
 * Surface Component Schemas — Token-friendly vocabulary for LLM surface generation.
 *
 * Each semantic surface component type has a compact prop schema with sensible
 * defaults. The LLM emits flat component records using these types; the client
 * renderer maps them to full DS components with opinionated styling.
 *
 * Design principles:
 * - Minimal required props (most things have good defaults)
 * - String-union props where possible (cheaper than nested objects)
 * - Bindings reference data model via JSON Pointer paths
 * - Children are referenced by ID (flat adjacency-list graph)
 */
import { z } from 'zod';

// =============================================================================
// Shared prop primitives
// =============================================================================

/** Token-friendly size scale shared across components. */
export const SurfaceSizeSchema = z.enum(['xs', 'sm', 'md', 'lg', 'xl']);

/** Token-friendly spacing scale. */
export const SurfaceSpacingSchema = z.enum(['none', 'xs', 'sm', 'md', 'lg', 'xl']);

/** Semantic color intent — renderer maps to DS tokens. */
export const SurfaceColorIntentSchema = z.enum([
  'default',
  'primary',
  'secondary',
  'success',
  'warning',
  'danger',
  'info',
  'accent',
  'muted',
]);

/** Text alignment. */
export const SurfaceAlignSchema = z.enum(['start', 'center', 'end']);

/** Layout direction. */
export const SurfaceDirectionSchema = z.enum(['row', 'column']);

// =============================================================================
// Per-component prop schemas
// =============================================================================

/**
 * Page — top-level container. Only one per surface.
 * Renderer: full-width padded container with optional title bar.
 */
export const PagePropsSchema = z
  .object({
    title: z.string().max(200).optional(),
    subtitle: z.string().max(500).optional(),
    padding: SurfaceSpacingSchema.optional(), // default: 'lg'
    maxWidth: z.enum(['sm', 'md', 'lg', 'xl', 'full']).optional(), // default: 'lg'
  })
  .optional();

/**
 * Section — groups related content with optional heading.
 * Renderer: DS Section with vertical spacing + optional divider.
 */
export const SectionPropsSchema = z
  .object({
    title: z.string().max(200).optional(),
    collapsible: z.boolean().optional(), // default: false
    gap: SurfaceSpacingSchema.optional(), // default: 'md'
  })
  .optional();

/**
 * Panel — elevated card/container.
 * Renderer: DS Panel with border, radius, padding.
 */
export const PanelPropsSchema = z
  .object({
    title: z.string().max(200).optional(),
    variant: z.enum(['default', 'outlined', 'elevated', 'filled']).optional(), // default: 'default'
    padding: SurfaceSpacingSchema.optional(), // default: 'md'
  })
  .optional();

/**
 * Heading — semantic heading level.
 * Renderer: DS Heading with appropriate font size/weight.
 */
export const HeadingPropsSchema = z
  .object({
    level: z.enum(['1', '2', '3', '4']).optional(), // default: '2'
    align: SurfaceAlignSchema.optional(),
  })
  .optional();

/**
 * Text — body text. When `format: "markdown"` the renderer parses GFM markdown
 * (headings, lists, tables, fenced code, links); otherwise renders as plain text.
 */
export const TextPropsSchema = z
  .object({
    format: z.enum(['plain', 'markdown']).optional(), // default: 'plain'
    size: SurfaceSizeSchema.optional(), // default: 'md'
    color: SurfaceColorIntentSchema.optional(), // default: 'default'
    weight: z.enum(['normal', 'medium', 'semibold', 'bold']).optional(),
    align: SurfaceAlignSchema.optional(),
    /** Static text content. Ignored if component has a text binding. */
    content: z.string().max(200_000).optional(),
  })
  .optional();

/**
 * MetricGrid — grid of key-value metric cards.
 * Renderer: responsive grid of metric cards with label/value/trend.
 * Bind to data model array of { label, value, unit?, trend?, icon? }.
 */
export const MetricGridPropsSchema = z
  .object({
    columns: z.enum(['2', '3', '4', 'auto']).optional(), // default: 'auto'
    size: SurfaceSizeSchema.optional(), // default: 'md'
    /** Inline metrics when not using data binding. */
    items: z
      .array(
        z.object({
          label: z.string(),
          value: z.union([z.string(), z.number()]),
          unit: z.string().optional(),
          trend: z.enum(['up', 'down', 'flat']).optional(),
          icon: z.string().optional(),
        }),
      )
      .optional(),
  })
  .optional();

/**
 * DataTable — tabular data display with sort/filter.
 * Renderer: full-featured DS table with responsive overflow, striping.
 * Bind `rows` and `columns` via data model.
 */
export const DataTablePropsSchema = z
  .object({
    /** Column definitions. Can also be bound via data model. */
    columns: z
      .array(
        z.object({
          key: z.string(),
          label: z.string(),
          align: SurfaceAlignSchema.optional(),
          sortable: z.boolean().optional(),
          width: z.string().optional(),
        }),
      )
      .optional(),
    /** Inline rows when not using data binding. */
    rows: z.array(z.record(z.unknown())).optional(),
    striped: z.boolean().optional(), // default: true
    compact: z.boolean().optional(), // default: false
    pageSize: z.number().int().positive().max(100).optional(), // default: 10
  })
  .optional();

/**
 * List — ordered or unordered list of items.
 * Renderer: DS List with proper spacing and optional icons.
 */
export const ListPropsSchema = z
  .object({
    variant: z.enum(['unordered', 'ordered', 'plain']).optional(), // default: 'plain'
    /** Inline items when not using data binding or children. */
    items: z
      .array(
        z.object({
          label: z.string(),
          description: z.string().optional(),
          icon: z.string().optional(),
          badge: z.string().optional(),
        }),
      )
      .optional(),
    gap: SurfaceSpacingSchema.optional(), // default: 'sm'
  })
  .optional();

/**
 * Form — container for input fields with declarative submit action.
 * Renderer: DS form layout with automatic label/field arrangement.
 */
export const FormPropsSchema = z
  .object({
    layout: z.enum(['vertical', 'horizontal', 'inline']).optional(), // default: 'vertical'
    gap: SurfaceSpacingSchema.optional(), // default: 'md'
    submitLabel: z.string().max(100).optional(), // default: 'Submit'
  })
  .optional();

/**
 * Field — form input field. Must be inside a Form.
 * Renderer: DS Field (Input, Select, Textarea, Checkbox, etc.) based on `fieldType`.
 */
export const FieldPropsSchema = z
  .object({
    fieldType: z
      .enum(['text', 'number', 'email', 'textarea', 'select', 'checkbox', 'date', 'password'])
      .optional(), // default: 'text'
    label: z.string().max(200).optional(),
    placeholder: z.string().max(200).optional(),
    required: z.boolean().optional(), // default: false
    disabled: z.boolean().optional(),
    /** Options for select fields. */
    options: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
        }),
      )
      .optional(),
    /** Data model path for two-way binding. */
    bindPath: z.string().optional(),
  })
  .optional();

/**
 * Button — interactive button with declarative action.
 * Renderer: DS Button with variant styling.
 */
export const ButtonPropsSchema = z
  .object({
    label: z.string().max(100),
    variant: z.enum(['primary', 'secondary', 'outline', 'ghost', 'danger']).optional(), // default: 'primary'
    size: SurfaceSizeSchema.optional(), // default: 'md'
    icon: z.string().optional(),
    disabled: z.boolean().optional(),
    loading: z.boolean().optional(),
    fullWidth: z.boolean().optional(),
  })
  .optional();

/**
 * Chart — data visualization. Type is selected via `chartType`.
 * Renderer: maps to constrained phoenix-charts preset.
 * Bind data series via data model.
 */
export const ChartPropsSchema = z
  .object({
    chartType: z.enum(['line', 'bar', 'area', 'pie', 'sparkline']).optional(), // default: 'bar'
    title: z.string().max(200).optional(),
    height: z.enum(['sm', 'md', 'lg']).optional(), // default: 'md'
    xKey: z.string().optional(),
    yKey: z.string().optional(),
    /** For multi-series: array of { key, label, color? } */
    series: z
      .array(
        z.object({
          key: z.string(),
          label: z.string().optional(),
          color: SurfaceColorIntentSchema.optional(),
        }),
      )
      .optional(),
    /** Inline data when not using data binding. */
    data: z.array(z.record(z.unknown())).optional(),
    showLegend: z.boolean().optional(), // default: true
    showGrid: z.boolean().optional(), // default: true
    /** Custom color palette (hex codes). Cycles for each bar/slice/series. */
    colors: z.array(z.string()).optional(),
  })
  .optional();

/**
 * ChatComposer — message input with send button.
 * Renderer: DS chat input + send action.
 */
export const ChatComposerPropsSchema = z
  .object({
    placeholder: z.string().max(200).optional(), // default: 'Type a message...'
    bindPath: z.string().optional(), // data model path for message text
    multiline: z.boolean().optional(), // default: true
  })
  .optional();

/**
 * Image — responsive image with optional caption.
 * Renderer: DS Image with aspect ratio and fallback.
 */
export const ImagePropsSchema = z
  .object({
    src: z.string().optional(), // can also be bound
    alt: z.string().max(500).optional(),
    aspectRatio: z.enum(['auto', '1:1', '4:3', '16:9', '21:9']).optional(), // default: 'auto'
    fit: z.enum(['cover', 'contain', 'fill']).optional(), // default: 'cover'
    caption: z.string().max(500).optional(),
  })
  .optional();

/**
 * CodeBlock — syntax-highlighted code display.
 * Renderer: DS CodeBlock with language detection and copy button.
 */
export const CodeBlockPropsSchema = z
  .object({
    language: z.string().max(30).optional(), // default: auto-detect
    /** Inline code content. Ignored if component has a text binding. */
    code: z.string().max(100_000).optional(),
    showLineNumbers: z.boolean().optional(), // default: false
    maxHeight: z.enum(['sm', 'md', 'lg', 'none']).optional(), // default: 'md'
  })
  .optional();

/** Divider — horizontal rule / separator. No props needed. */
export const DividerPropsSchema = z
  .object({
    spacing: SurfaceSpacingSchema.optional(), // default: 'md'
  })
  .optional();

/**
 * Badge — small label/tag.
 * Renderer: DS Badge with color intent.
 */
export const BadgePropsSchema = z
  .object({
    label: z.string().max(100),
    color: SurfaceColorIntentSchema.optional(), // default: 'default'
    size: z.enum(['sm', 'md']).optional(), // default: 'md'
  })
  .optional();

/**
 * Icon — standalone icon.
 * Renderer: DS Icon from phoenix-icons.
 */
export const IconPropsSchema = z
  .object({
    name: z.string().max(100),
    size: SurfaceSizeSchema.optional(), // default: 'md'
    color: SurfaceColorIntentSchema.optional(),
  })
  .optional();

// =============================================================================
// Component prop schema map — maps component type to its prop schema
// =============================================================================

/**
 * Maps each surface component type to its Zod prop schema.
 * Used for validation and catalog generation.
 */
export const surfaceComponentPropSchemas = {
  Page: PagePropsSchema,
  Section: SectionPropsSchema,
  Panel: PanelPropsSchema,
  Heading: HeadingPropsSchema,
  Text: TextPropsSchema,
  MetricGrid: MetricGridPropsSchema,
  DataTable: DataTablePropsSchema,
  List: ListPropsSchema,
  Form: FormPropsSchema,
  Field: FieldPropsSchema,
  Button: ButtonPropsSchema,
  Chart: ChartPropsSchema,
  ChatComposer: ChatComposerPropsSchema,
  Image: ImagePropsSchema,
  CodeBlock: CodeBlockPropsSchema,
  Divider: DividerPropsSchema,
  Badge: BadgePropsSchema,
  Icon: IconPropsSchema,
} as const;

export type SurfaceComponentPropsMap = typeof surfaceComponentPropSchemas;
