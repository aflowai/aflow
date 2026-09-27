/**
 * Surface Component Registry — Opinionated mapping from semantic surface types
 * to Phoenix Design System components.
 *
 * Each renderer adds sensible defaults, spacing, and layout behavior that the
 * LLM doesn't need to specify. The model picks the semantic type and minimal
 * props; the registry handles the rich rendering.
 */
'use client';

import React from 'react';
import {
  Row,
  Column,
  Grid,
  Panel,
  Section,
  Text,
  Heading,
  Button,
  Badge,
  Icon,
  Divider,
  Spinner,
  CodeBlock,
  Table,
  Th,
  Td,
  Tr,
  Checkbox,
} from '@aflow/design-system';
import type { SurfaceComponentType, TypedSurfaceComponent } from '@aflow/schemas';
import type { IconName } from '@aflow/design-system';

import type { SurfaceState } from '@aflow/surface-engine';
import { getAtPointer } from '@aflow/surface-engine';
import { MarkdownRenderer as MarkdownContent } from '../markdown-renderer.js';

// =============================================================================
// Helpers
// =============================================================================

const toStr = (v: unknown) =>
  typeof v === 'object' && v !== null
    ? JSON.stringify(v)
    : String((v ?? '') as string | number | boolean);

// =============================================================================
// Renderer context
// =============================================================================

export interface RendererContext {
  state: Readonly<SurfaceState>;
  onAction?: (componentId: string, action: Record<string, unknown>) => void;
  onDataChange?: (pointer: string, value: unknown) => void;
}

export interface ComponentRendererProps {
  component: TypedSurfaceComponent;
  ctx: RendererContext;
}

type ComponentRenderer = React.FC<ComponentRendererProps>;

// =============================================================================
// Helper: resolve prop value from bindings or static props
// =============================================================================

function resolveValue(
  propName: string,
  component: TypedSurfaceComponent,
  ctx: RendererContext,
): unknown {
  // Check bindings first
  if (component.bindings?.[propName]) {
    return getAtPointer(ctx.state.dataModel, component.bindings[propName]);
  }
  // Fall back to static props
  return component.props?.[propName];
}

function resolveString(
  propName: string,
  component: TypedSurfaceComponent,
  ctx: RendererContext,
): string | undefined {
  const val = resolveValue(propName, component, ctx);
  if (val == null) return undefined;
  // Coerce numbers/booleans to string — bindings often resolve to non-string primitives
  return typeof val === 'string' ? val : toStr(val);
}

// =============================================================================
// Helper: render children
// =============================================================================

function renderChildren(component: TypedSurfaceComponent, ctx: RendererContext): React.ReactNode[] {
  if (!component.children) return [];
  return component.children
    .map((childId) => {
      const child = ctx.state.components.get(childId);
      if (!child) return null;
      return <SurfaceComponentRenderer key={childId} component={child} ctx={ctx} />;
    })
    .filter(Boolean) as React.ReactNode[];
}

// =============================================================================
// Spacing helper
// =============================================================================

const DEFAULT_SPACING = 'var(--space-4)';

const SPACING_MAP: Record<string, string> = {
  none: '0',
  xs: 'var(--space-1)',
  sm: 'var(--space-2)',
  md: DEFAULT_SPACING,
  lg: 'var(--space-6)',
  xl: 'var(--space-8)',
};

function spacing(value?: string): string {
  return SPACING_MAP[value ?? 'md'] ?? DEFAULT_SPACING;
}

// =============================================================================
// Component renderers
// =============================================================================

const PageRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const title = resolveString('title', component, ctx) ?? (props?.['title'] as string);
  const subtitle = resolveString('subtitle', component, ctx) ?? (props?.['subtitle'] as string);
  const pad = spacing(props?.['padding'] as string | undefined);

  return (
    <Column gap="lg" style={{ padding: pad, maxWidth: '100%' }}>
      {(title || subtitle) && (
        <Column gap="xs">
          {title && <Heading level={1}>{title}</Heading>}
          {subtitle && <Text color="secondary">{subtitle}</Text>}
        </Column>
      )}
      {renderChildren(component, ctx)}
    </Column>
  );
};

const SectionRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const title = resolveString('title', component, ctx) ?? (props?.['title'] as string);
  const gap = (props?.['gap'] as string) ?? 'md';

  return (
    <Section>
      {title && <Heading level={2}>{title}</Heading>}
      <Column gap={gap as 'xs' | 'sm' | 'md' | 'lg' | 'xl'}>
        {renderChildren(component, ctx)}
      </Column>
    </Section>
  );
};

const PanelRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const title = resolveString('title', component, ctx) ?? (props?.['title'] as string);

  return (
    <Panel>
      {title && (
        <Row align="center" gap="sm" style={{ marginBottom: 'var(--space-3)' }}>
          <Heading level={3}>{title}</Heading>
        </Row>
      )}
      <Column gap="md">{renderChildren(component, ctx)}</Column>
    </Panel>
  );
};

const HeadingRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const level = parseInt((props?.['level'] as string) ?? '2', 10) as 1 | 2 | 3 | 4;
  const text = resolveString('text', component, ctx) ?? (props?.['content'] as string);

  return <Heading level={level}>{text ?? ''}</Heading>;
};

const TextRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const content = resolveString('text', component, ctx) ?? (props?.['content'] as string) ?? '';
  const color = (props?.['color'] as string) ?? 'default';

  if ((props?.['format'] as string) === 'markdown')
    return <MarkdownContent content={content} jsonTree />;
  return <Text color={color === 'muted' ? 'secondary' : undefined}>{content}</Text>;
};

const MetricGridRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const items = (resolveValue('items', component, ctx) ?? props?.['items'] ?? []) as Array<{
    label: string;
    value: string | number;
    unit?: string;
    trend?: string;
    icon?: string;
  }>;

  const trendIcon = (trend?: string) => {
    if (trend === 'up') return '↑';
    if (trend === 'down') return '↓';
    return '→';
  };

  const trendColor = (trend?: string) => {
    if (trend === 'up') return 'var(--color-success-default)';
    if (trend === 'down') return 'var(--color-danger-default)';
    return 'var(--color-content-secondary)';
  };

  const cols = parseInt(toStr(props?.['columns'] ?? '3'), 10) || 3;

  return (
    <Grid columns={cols} gap="md">
      {items.map((item, idx) => (
        <Panel key={idx}>
          <Column gap="xs">
            <Text color="secondary" size="sm">
              {item.icon && <Icon name={item.icon as IconName} size="sm" />}
              {item.label}
            </Text>
            <Row align="baseline" gap="xs">
              <Text size="xl" weight="bold">
                {toStr(item.value)}
              </Text>
              {item.unit && (
                <Text size="sm" color="secondary">
                  {item.unit}
                </Text>
              )}
              {item.trend && (
                <Text size="sm" style={{ color: trendColor(item.trend), fontWeight: 600 }}>
                  {trendIcon(item.trend)}
                </Text>
              )}
            </Row>
          </Column>
        </Panel>
      ))}
    </Grid>
  );
};

const DataTableRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const columns = (resolveValue('columns', component, ctx) ?? props?.['columns'] ?? []) as Array<{
    key: string;
    label: string;
    align?: string;
  }>;
  const rows = (resolveValue('rows', component, ctx) ?? props?.['rows'] ?? []) as Array<
    Record<string, unknown>
  >;
  const striped = (props?.['striped'] as boolean) ?? true;
  const hasBinding = !!component.bindings?.['rows'];
  const isAwaitingData = hasBinding && rows.length === 0 && !ctx.state.completed;

  return (
    <div style={{ overflowX: 'auto' }}>
      <Table>
        <thead>
          <Tr>
            {columns.map((col) => (
              <Th
                key={col.key}
                style={{ textAlign: (col.align as 'start' | 'center' | 'end') ?? 'start' }}
              >
                {col.label}
              </Th>
            ))}
          </Tr>
        </thead>
        <tbody>
          {isAwaitingData ? (
            <Tr>
              <Td
                colSpan={columns.length}
                style={{ textAlign: 'center', padding: 'var(--space-6)' }}
              >
                <Row gap="sm" align="center" justify="center">
                  <Spinner size="sm" />
                </Row>
              </Td>
            </Tr>
          ) : (
            rows.map((row, idx) => (
              <Tr
                key={idx}
                style={
                  striped && idx % 2 === 1
                    ? { backgroundColor: 'var(--color-surface-secondary)' }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <Td
                    key={col.key}
                    style={{ textAlign: (col.align as 'start' | 'center' | 'end') ?? 'start' }}
                  >
                    {toStr(row[col.key] ?? '')}
                  </Td>
                ))}
              </Tr>
            ))
          )}
        </tbody>
      </Table>
    </div>
  );
};

const ListRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const items = (resolveValue('items', component, ctx) ?? props?.['items']) as
    Array<{ label: string; description?: string; icon?: string; badge?: string }> | undefined;

  const children = renderChildren(component, ctx);

  if (items && items.length > 0) {
    return (
      <Column gap={(props?.['gap'] as 'xs' | 'sm' | 'md') ?? 'sm'}>
        {items.map((item, idx) => (
          <Row key={idx} gap="sm" align="center">
            {item.icon && <Icon name={item.icon as IconName} size="sm" />}
            <Column gap="none">
              <Text weight="medium">{item.label}</Text>
              {item.description && (
                <Text size="sm" color="secondary">
                  {item.description}
                </Text>
              )}
            </Column>
            {item.badge && <Badge>{item.badge}</Badge>}
          </Row>
        ))}
      </Column>
    );
  }

  return <Column gap={(props?.['gap'] as 'xs' | 'sm' | 'md') ?? 'sm'}>{children}</Column>;
};

const FormRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const submitLabel = (props?.['submitLabel'] as string) ?? 'Submit';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (ctx.onAction) {
      // Find submit action or create default
      const submitAction = component.actions?.find((a) => a.eventType === 'submit') ?? {
        eventName: 'form.submit',
        eventType: 'submit' as const,
        target: 'agent' as const,
        includeDataModel: true,
      };
      ctx.onAction(component.id, {
        ...submitAction,
        dataModel: submitAction.includeDataModel ? ctx.state.dataModel : undefined,
      });
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Column gap={(props?.['gap'] as 'xs' | 'sm' | 'md' | 'lg') ?? 'md'}>
        {renderChildren(component, ctx)}
        <Button type="submit" variant="primary">
          {submitLabel}
        </Button>
      </Column>
    </form>
  );
};

const FieldRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const fieldType = (props?.['fieldType'] as string) ?? 'text';
  const label = (props?.['label'] as string) ?? '';
  const placeholder = (props?.['placeholder'] as string) ?? '';
  const required = (props?.['required'] as boolean) ?? false;
  const disabled = (props?.['disabled'] as boolean) ?? false;
  const bindPath = (props?.['bindPath'] as string) ?? component.bindings?.['value'];

  const value = bindPath ? ((getAtPointer(ctx.state.dataModel, bindPath) as string) ?? '') : '';

  const handleChange = (newValue: string) => {
    if (bindPath && ctx.onDataChange) {
      ctx.onDataChange(bindPath, newValue);
    }
  };

  const baseStyle: React.CSSProperties = {
    width: '100%',
    padding: 'var(--space-2) var(--space-3)',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-default)',
    backgroundColor: 'var(--color-surface-default)',
    color: 'var(--color-content-default)',
    fontSize: 'var(--font-size-base)',
  };

  return (
    <Column gap="xs">
      {label && fieldType !== 'checkbox' && (
        <Text size="sm" weight="medium">
          {label}
          {required && <span style={{ color: 'var(--color-danger)' }}> *</span>}
        </Text>
      )}
      {fieldType === 'textarea' ? (
        <textarea
          value={value}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          onChange={(e) => {
            handleChange(e.target.value);
          }}
          style={{ ...baseStyle, minHeight: '80px', resize: 'vertical' }}
        />
      ) : fieldType === 'select' ? (
        <select
          value={value}
          required={required}
          disabled={disabled}
          onChange={(e) => {
            handleChange(e.target.value);
          }}
          style={baseStyle}
        >
          <option value="">{placeholder || 'Select...'}</option>
          {((props?.['options'] as Array<{ label: string; value: string }>) ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : fieldType === 'checkbox' ? (
        <Checkbox
          checked={value === 'true'}
          required={required}
          disabled={disabled}
          onChange={(e) => {
            handleChange(String(e.target.checked));
          }}
        >
          {label}
          {required && <span style={{ color: 'var(--color-danger)' }}> *</span>}
        </Checkbox>
      ) : (
        <input
          type={fieldType}
          value={value}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          onChange={(e) => {
            handleChange(e.target.value);
          }}
          style={baseStyle}
        />
      )}
    </Column>
  );
};

const ButtonRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const label = (props?.['label'] as string) ?? 'Button';
  const variant =
    (props?.['variant'] as 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger') ?? 'primary';
  const disabled = (props?.['disabled'] as boolean) ?? false;
  const loading = (props?.['loading'] as boolean) ?? false;
  const icon = props?.['icon'] as string | undefined;

  const handleClick = () => {
    if (ctx.onAction && component.actions?.[0]) {
      const action = component.actions[0];
      ctx.onAction(component.id, {
        ...action,
        dataModel: action.includeDataModel ? ctx.state.dataModel : undefined,
      });
    }
  };

  return (
    <Button
      variant={variant === 'danger' ? 'primary' : variant === 'outline' ? 'secondary' : variant}
      disabled={disabled || loading}
      onClick={handleClick}
    >
      {loading && <Spinner size="sm" />}
      {icon && <Icon name={icon as IconName} size="sm" />}
      {label}
    </Button>
  );
};

/** Data visualization palette via DS tokens — theme-aware, 10 indexed colors. */
const DATA_COLORS = Array.from({ length: 10 }, (_, i) => `var(--color-data-${i})`);
const FIRST_DATA_COLOR = 'var(--color-data-0)';

/**
 * Resolve a data color token to a CSS value.
 * Accepts: "data-0"…"data-9", with optional opacity "data-3/50".
 * Falls back to raw CSS values (hex, rgb, var()).
 */
function resolveColorToken(token: string): string {
  // data-N or data-N/opacity
  const match = /^data-(\d)(?:\/(\d{1,3}))?$/.exec(token);
  if (match) {
    const idx = match[1];
    const opacity = match[2];
    if (opacity) {
      // Use color-mix for opacity: color-mix(in srgb, var(--color-data-N) NN%, transparent)
      return `color-mix(in srgb, var(--color-data-${idx}) ${opacity}%, transparent)`;
    }
    return `var(--color-data-${idx})`;
  }
  // Already a CSS value (hex, rgb, var())
  return token;
}

/** Shared chart helpers */
const CHART_HEIGHTS: Record<string, number> = { sm: 120, md: 200, lg: 300 };

function formatChartValue(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return String(val);
}

interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

function useChartProps(component: TypedSurfaceComponent, ctx: RendererContext) {
  const props = component.props;
  const data = (resolveValue('data', component, ctx) ?? props?.['data'] ?? []) as Array<
    Record<string, unknown>
  >;
  const xKey = (props?.['xKey'] as string) ?? '';
  const customColors = props?.['colors'] as string[] | undefined;
  const baseColors = customColors ? customColors.map(resolveColorToken) : DATA_COLORS;
  const height = CHART_HEIGHTS[(props?.['height'] as string) ?? 'md'] ?? 200;
  const title = resolveString('title', component, ctx) ?? (props?.['title'] as string);
  const showLegend = (props?.['showLegend'] as boolean) ?? true;

  // Resolve series: explicit series prop or single yKey
  const rawSeries = props?.['series'] as
    Array<{ key: string; label?: string; color?: string }> | undefined;
  const firstRow = data[0];
  const yKey =
    (props?.['yKey'] as string) ??
    (firstRow
      ? Object.keys(firstRow).find((k) => k !== xKey && typeof firstRow[k] === 'number')
      : '') ??
    '';

  const series: SeriesDef[] = rawSeries
    ? rawSeries.map((s, i) => ({
        key: s.key,
        label: s.label ?? s.key,
        color: s.color
          ? resolveColorToken(s.color)
          : (baseColors[i % baseColors.length] ?? FIRST_DATA_COLOR),
      }))
    : [{ key: yKey, label: yKey, color: baseColors[0] ?? FIRST_DATA_COLOR }];

  const isMultiSeries = series.length > 1;

  // Compute max across all series
  let maxVal = 0;
  for (const d of data) {
    for (const s of series) {
      const v = Number(d[s.key]) || 0;
      if (v > maxVal) maxVal = v;
    }
  }

  // Single-series convenience
  const values = data.map((d) => Number(d[yKey]) || 0);
  const colors = series.map((s) => s.color);

  return {
    props,
    data,
    xKey,
    yKey,
    colors,
    height,
    title,
    values,
    maxVal,
    series,
    isMultiSeries,
    showLegend,
  };
}

/** Bar chart — single or multi-series (grouped) */
function BarChart({
  data,
  xKey,
  series,
  height,
  maxVal,
  isMultiSeries,
}: ReturnType<typeof useChartProps>) {
  const sliced = data.slice(0, 30);
  return (
    <Column gap="xs">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: isMultiSeries ? '12px' : '6px',
          height: `${height}px`,
        }}
      >
        {sliced.map((d, idx) => (
          <div
            key={idx}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              height: '100%',
              gap: '2px',
            }}
          >
            {/* Grouped bars for this x-value */}
            <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', flex: 1 }}>
              {series.map((s) => {
                const val = Number(d[s.key]) || 0;
                const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
                return (
                  <div
                    key={s.key}
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      height: '100%',
                      gap: '2px',
                    }}
                  >
                    {!isMultiSeries && (
                      <Text size="xs" style={{ color: s.color, fontWeight: 600, fontSize: '11px' }}>
                        {formatChartValue(val)}
                      </Text>
                    )}
                    <div
                      style={{
                        width: '100%',
                        height: `${pct}%`,
                        backgroundColor: s.color,
                        borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
                        minHeight: '4px',
                        transition: 'height 0.4s ease-out',
                      }}
                      title={`${toStr(d[xKey] ?? idx)} — ${s.label}: ${formatChartValue(val)}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {/* X-axis labels */}
      {xKey && (
        <div style={{ display: 'flex', gap: isMultiSeries ? '12px' : '6px' }}>
          {sliced.map((d, idx) => (
            <div
              key={idx}
              style={{
                flex: 1,
                textAlign: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <Text size="xs" color="secondary">
                {toStr(d[xKey] ?? '')}
              </Text>
            </div>
          ))}
        </div>
      )}
    </Column>
  );
}

/** Line / Area chart (SVG) — supports multi-series */
function LineAreaChart(
  { data, xKey, series, height, maxVal }: ReturnType<typeof useChartProps>,
  area = false,
) {
  const pad = { top: 20, right: 10, bottom: 24, left: 10 };
  const w = 500;
  const h = height;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  if (data.length === 0) return null;

  const xLabels = data.map((d, i) => toStr(d[xKey] ?? i));

  return (
    <Column gap="none">
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: `${h}px` }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = pad.top + f * plotH;
          return (
            <line
              key={f}
              x1={pad.left}
              y1={y}
              x2={w - pad.right}
              y2={y}
              stroke="var(--color-border-subtle)"
              strokeWidth="1"
            />
          );
        })}
        {/* Render each series */}
        {series.map((s) => {
          const points = data.map((d, i) => {
            const x = pad.left + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
            const val = Number(d[s.key]) || 0;
            const y = pad.top + (maxVal > 0 ? (1 - val / maxVal) * plotH : plotH);
            return { x, y, val };
          });
          const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
          const firstPoint = points[0];
          const lastPoint = points[points.length - 1];
          const areaPath =
            area && firstPoint && lastPoint
              ? `${linePath} L${lastPoint.x},${pad.top + plotH} L${firstPoint.x},${pad.top + plotH} Z`
              : '';
          return (
            <g key={s.key}>
              {area && <path d={areaPath} fill={s.color} opacity={0.12} />}
              <path
                d={linePath}
                fill="none"
                stroke={s.color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {points.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r="3.5"
                  fill={s.color}
                  stroke="var(--color-surface-canvas)"
                  strokeWidth="2"
                >
                  <title>{`${xLabels[i] ?? i} — ${s.label}: ${formatChartValue(p.val)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {/* X-axis labels */}
        {xKey &&
          data.length <= 20 &&
          data.map((d, i) => {
            const x = pad.left + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
            return (
              <text
                key={i}
                x={x}
                y={h - 4}
                textAnchor="middle"
                fontSize="10"
                fill="var(--color-content-secondary)"
              >
                {toStr(d[xKey] ?? '')}
              </text>
            );
          })}
      </svg>
    </Column>
  );
}

/** Pie / Donut chart (SVG) */
function PieChart({ data, xKey, yKey, colors, height }: ReturnType<typeof useChartProps>) {
  const size = Math.min(height, 250);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const total = data.reduce((sum, d) => sum + (Number(d[yKey]) || 0), 0);
  if (total === 0) return <Text color="secondary">No data</Text>;

  let startAngle = -Math.PI / 2;
  const slices = data.slice(0, 20).map((d, idx) => {
    const val = Number(d[yKey]) || 0;
    const angle = (val / total) * Math.PI * 2;
    const endAngle = startAngle + angle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const path = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z`;
    const color = colors[idx % colors.length] ?? DATA_COLORS[0];
    const label = toStr(d[xKey] ?? idx);
    const pct = ((val / total) * 100).toFixed(1);
    startAngle = endAngle;
    return { path, color, label, val, pct };
  });

  return (
    <Row gap="md" align="center" style={{ flexWrap: 'wrap' }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        style={{ width: `${size}px`, height: `${size}px`, flexShrink: 0 }}
      >
        {slices.map((s, i) => (
          <path
            key={i}
            d={s.path}
            fill={s.color}
            stroke="var(--color-surface-canvas)"
            strokeWidth="2"
          >
            <title>{`${s.label}: ${formatChartValue(s.val)} (${s.pct}%)`}</title>
          </path>
        ))}
      </svg>
      <Column gap="xs">
        {slices.map((s, i) => (
          <Row key={i} gap="xs" align="center">
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                backgroundColor: s.color,
                flexShrink: 0,
              }}
            />
            <Text size="xs">{s.label}</Text>
            <Text size="xs" color="secondary">
              {s.pct}%
            </Text>
          </Row>
        ))}
      </Column>
    </Row>
  );
}

/** Sparkline (inline SVG, no axes) */
function SparklineChart({ data, yKey, colors, height }: ReturnType<typeof useChartProps>) {
  const h = Math.min(height, 40);
  const w = 120;
  const color = colors[0] ?? DATA_COLORS[0];
  const values = data.map((d) => Number(d[yKey]) || 0);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * w : w / 2;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  });

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: `${w}px`, height: `${h}px` }}>
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ChartRenderer: ComponentRenderer = ({ component, ctx }) => {
  const chartProps = useChartProps(component, ctx);
  const chartType = (chartProps.props?.['chartType'] as string) ?? 'bar';

  const hasDataBinding = !!component.bindings?.['data'];
  const isAwaitingChartData =
    hasDataBinding && chartProps.data.length === 0 && !ctx.state.completed;

  let chart: React.ReactNode;
  if (chartProps.data.length === 0) {
    chart = isAwaitingChartData ? (
      <Column align="center" justify="center" gap="sm" style={{ minHeight: '120px' }}>
        <Spinner size="sm" />
      </Column>
    ) : (
      <Text color="secondary">No data</Text>
    );
  } else if (chartType === 'bar') {
    chart = <BarChart {...chartProps} />;
  } else if (chartType === 'line') {
    chart = <LineAreaChart {...chartProps} />;
  } else if (chartType === 'area') {
    chart = LineAreaChart({ ...chartProps }, true);
  } else if (chartType === 'pie') {
    chart = <PieChart {...chartProps} />;
  } else if (chartType === 'sparkline') {
    chart = <SparklineChart {...chartProps} />;
  } else {
    chart = <BarChart {...chartProps} />;
  }

  return (
    <Panel>
      {chartProps.title && <Heading level={3}>{chartProps.title}</Heading>}
      <div style={{ padding: 'var(--space-4)' }}>
        {chart}
        {/* Legend for multi-series (pie has its own) */}
        {chartProps.isMultiSeries && chartProps.showLegend && chartType !== 'pie' && (
          <Row
            gap="md"
            style={{ paddingTop: 'var(--space-3)', flexWrap: 'wrap', justifyContent: 'center' }}
          >
            {chartProps.series.map((s, i) => (
              <Row key={i} gap="xs" align="center">
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor: s.color,
                    flexShrink: 0,
                  }}
                />
                <Text size="xs">{s.label}</Text>
              </Row>
            ))}
          </Row>
        )}
      </div>
    </Panel>
  );
};

const ChatComposerRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const placeholder = (props?.['placeholder'] as string) ?? 'Type a message...';
  const bindPath = (props?.['bindPath'] as string) ?? component.bindings?.['message'] ?? '/message';

  const value = (getAtPointer(ctx.state.dataModel, bindPath) as string) ?? '';

  const handleSend = () => {
    if (ctx.onAction && value.trim()) {
      const action = component.actions?.find((a) => a.eventType === 'message') ?? {
        eventName: 'message.send',
        eventType: 'message' as const,
        target: 'agent' as const,
        includeDataModel: true,
      };
      ctx.onAction(component.id, {
        ...action,
        payload: { message: value },
        dataModel: action.includeDataModel ? ctx.state.dataModel : undefined,
      });
    }
  };

  return (
    <Row gap="sm" align="end">
      <div style={{ flex: 1 }}>
        <textarea
          value={value}
          placeholder={placeholder}
          onChange={(e) => ctx.onDataChange?.(bindPath, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          style={{
            width: '100%',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border-default)',
            backgroundColor: 'var(--color-surface-default)',
            color: 'var(--color-content-default)',
            fontSize: 'var(--font-size-base)',
            minHeight: '40px',
            resize: 'vertical',
          }}
        />
      </div>
      <Button variant="primary" onClick={handleSend}>
        Send
      </Button>
    </Row>
  );
};

const ImageRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const src = resolveString('src', component, ctx) ?? (props?.['src'] as string);
  const alt = (props?.['alt'] as string) ?? '';
  const caption = (props?.['caption'] as string) ?? '';
  const fit = (props?.['fit'] as string) ?? 'cover';

  if (!src) {
    return (
      <Column align="center" gap="sm" style={{ padding: 'var(--space-4)' }}>
        <Icon name="image" size="lg" />
        <Text color="secondary">No image source</Text>
      </Column>
    );
  }

  return (
    <Column gap="xs">
      <img
        src={src}
        alt={alt}
        style={{
          width: '100%',
          borderRadius: 'var(--radius-md)',
          objectFit: fit as 'cover' | 'contain' | 'fill',
        }}
      />
      {caption && (
        <Text size="sm" color="secondary" align="center">
          {caption}
        </Text>
      )}
    </Column>
  );
};

const CodeBlockRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const code = resolveString('code', component, ctx) ?? (props?.['code'] as string) ?? '';
  const language = (props?.['language'] as string) ?? undefined;

  return <CodeBlock language={language}>{code}</CodeBlock>;
};

const DividerRenderer: ComponentRenderer = () => {
  return <Divider />;
};

const BadgeRenderer: ComponentRenderer = ({ component, ctx }) => {
  const props = component.props;
  const label = resolveString('label', component, ctx) ?? (props?.['label'] as string) ?? '';
  const color = props?.['color'] as string | undefined;
  // Map surface ColorIntent to DS BadgeVariant
  const variantMap: Record<string, string> = {
    default: 'neutral',
    primary: 'info',
    secondary: 'neutral',
    success: 'success',
    warning: 'warning',
    danger: 'danger',
    info: 'info',
    accent: 'accent',
    muted: 'neutral',
  };
  const variant = (color ? variantMap[color] : undefined) ?? 'neutral';
  return (
    <Badge variant={variant as 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'}>
      {label}
    </Badge>
  );
};

const IconRenderer: ComponentRenderer = ({ component }) => {
  const props = component.props;
  const name = props?.['name'] as string | undefined;
  if (!name) return null; // Don't render a fallback icon when no name is specified
  const size = (props?.['size'] as 'xs' | 'sm' | 'md' | 'lg' | 'xl') ?? 'md';
  return <Icon name={name as IconName} size={size} />;
};

// =============================================================================
// Registry
// =============================================================================

const COMPONENT_REGISTRY: Record<SurfaceComponentType, ComponentRenderer> = {
  Page: PageRenderer,
  Section: SectionRenderer,
  Panel: PanelRenderer,
  Heading: HeadingRenderer,
  Text: TextRenderer,
  MetricGrid: MetricGridRenderer,
  DataTable: DataTableRenderer,
  List: ListRenderer,
  Form: FormRenderer,
  Field: FieldRenderer,
  Button: ButtonRenderer,
  Chart: ChartRenderer,
  ChatComposer: ChatComposerRenderer,
  Image: ImageRenderer,
  CodeBlock: CodeBlockRenderer,
  Divider: DividerRenderer,
  Badge: BadgeRenderer,
  Icon: IconRenderer,
};

// =============================================================================
// Main renderer component
// =============================================================================

export function SurfaceComponentRenderer({ component, ctx }: ComponentRendererProps) {
  const Renderer = COMPONENT_REGISTRY[component.component];

  if (!Renderer) {
    return (
      <Panel>
        <Text color="secondary">
          Unknown component: {component.component} (id: {component.id})
        </Text>
      </Panel>
    );
  }

  return (
    <div data-surface-component={component.id}>
      <Renderer component={component} ctx={ctx} />
    </div>
  );
}
