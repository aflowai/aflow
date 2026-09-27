/**
 * UI artifact validation and compilation pipeline.
 *
 * Multi-step validation:
 * 1. Parse source for syntax errors
 * 2. Validate imports against allowlist
 * 3. Validate DS component usage against catalog
 * 4. Check for dangerous patterns (eval, Function, etc.)
 * 5. Compile with esbuild
 * 6. Generate standalone HTML for sandbox rendering
 */
import * as esbuild from 'esbuild';
import { AFLOW_HOST_PROTOCOL_JS, THEME_LISTENER_JS } from './hostProtocol.js';
import type { ValidationDiagnostic } from '@aflow/schemas';

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
  compiledCode?: string;
  standaloneHtml?: string;
}

interface AllowedImportEntry {
  /** Import specifier prefix (e.g., '@aflow/design-system') */
  specifier: string;
  /** Global variable name in the iframe runtime */
  globalName: string;
}

// ============================================================================
// Allowed imports — only these are permitted in generated artifacts
// ============================================================================

const ALLOWED_IMPORTS: AllowedImportEntry[] = [
  { specifier: '@aflow/design-system', globalName: 'PhoenixDS' },
  { specifier: '@aflow/design-system/charts', globalName: 'PhoenixCharts' },
  { specifier: 'react', globalName: 'React' },
  { specifier: 'react-dom', globalName: 'ReactDOM' },
  { specifier: 'react-dom/client', globalName: 'ReactDOMClient' },
  { specifier: 'recharts', globalName: 'Recharts' },
  { specifier: 'katex', globalName: 'katex' },
];

const ALLOWED_IMPORT_SPECIFIERS = new Set(ALLOWED_IMPORTS.map((a) => a.specifier));

/**
 * Whether the compiler itself resolves this specifier — the design-system shim
 * it bundles and the runtime it pins. Anything else in an applet is a declared
 * library the iframe's own import map answers for.
 */
export function isCompilerResolvedImport(specifier: string): boolean {
  for (const allowed of ALLOWED_IMPORT_SPECIFIERS) {
    if (specifier === allowed || specifier.startsWith(`${allowed}/`)) return true;
  }
  return false;
}

// ============================================================================
// Design System shim — lightweight React component implementations for iframe
// ============================================================================

/**
 * Self-contained DS shim bundled at compile time via esbuild plugin.
 * Components render as basic HTML elements with inline flex/grid styles,
 * matching the DS component APIs closely enough for artifact previews.
 *
 * This avoids any external dependency on the private @aflow/design-system
 * npm package — the compiled artifact is fully self-contained.
 */
const DS_SHIM_SOURCE = `
import React from 'react';

// ── Tokens ──
const space = { none: '0px', xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px', '2xl': '48px' };
const radius = { sm: '4px', md: '8px', lg: '12px', xl: '16px', full: '9999px' };
const fontSize = { xs: '11px', sm: '13px', md: '14px', lg: '16px', xl: '20px', '2xl': '24px', '3xl': '30px' };
const fontWeight = { normal: '400', medium: '500', semibold: '600', bold: '700' };

function gap(g) { return space[g] || g || '0'; }
function rad(r) { return radius[r] || r || '0'; }
function jc(j) { return j === 'between' ? 'space-between' : j === 'around' ? 'space-around' : j === 'evenly' ? 'space-evenly' : j === 'start' ? 'flex-start' : j === 'end' ? 'flex-end' : j || 'flex-start'; }
function ai(a) { return a === 'start' ? 'flex-start' : a === 'end' ? 'flex-end' : a || 'stretch'; }

// ── Theme-aware color helpers (read CSS custom properties) ──
const v = (token) => 'var(' + token + ')';

// ── Layout ──
function flexProps(fill, shrink) {
  const s = {};
  if (fill) { s.flex = fill === true ? '1 1 0%' : fill + ' 1 0%'; s.minWidth = 0; }
  if (shrink === false) s.flexShrink = 0;
  return s;
}
function padProps(padding, paddingX, paddingY) {
  const s = {};
  if (padding) { s.padding = space[padding] || padding; }
  if (paddingX) { const px = space[paddingX] || paddingX; s.paddingLeft = px; s.paddingRight = px; }
  if (paddingY) { const py = space[paddingY] || paddingY; s.paddingTop = py; s.paddingBottom = py; }
  return s;
}
export function Row({ children, gap: g, align, justify, wrap, fill, grow, shrink, padding, paddingX, paddingY, style, ...rest }) {
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'row', gap: gap(g), alignItems: ai(align), justifyContent: jc(justify), flexWrap: wrap ? 'wrap' : undefined, ...flexProps(fill || grow, shrink), ...padProps(padding, paddingX, paddingY), ...style }, ...rest }, children);
}
export function Column({ children, gap: g, align, justify, fill, grow, shrink, padding, paddingX, paddingY, style, ...rest }) {
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: gap(g), alignItems: ai(align), justifyContent: jc(justify), ...flexProps(fill || grow, shrink), ...padProps(padding, paddingX, paddingY), ...style }, ...rest }, children);
}
// Layout aliases — the real DS exports these (layout/index.ts: Column as
// Stack, Row as Inline); artifacts import them, so the shim must match
// or lazy compile fails with "No matching export ... Stack".
export const Stack = Column;
export const Inline = Row;
export function Grid({ children, columns, gap: g, style, ...rest }) {
  return React.createElement('div', { style: { display: 'grid', gridTemplateColumns: typeof columns === 'number' ? 'repeat(' + columns + ', 1fr)' : columns || '1fr', gap: gap(g), ...style }, ...rest }, children);
}
export function Panel({ children, variant, padding, rounded, fill, grow, style, ...rest }) {
  const bg = variant === 'ghost' ? 'transparent' : variant === 'elevated' ? v('--ds-bg-panel') : v('--ds-bg-surface');
  const border = variant === 'ghost' ? 'none' : '1px solid ' + v('--ds-border-default');
  const p = space[padding] || space.md;
  const r = rounded === false ? '0' : radius.md;
  return React.createElement('div', { style: { background: bg, border, borderRadius: r, padding: p, ...flexProps(fill || grow), ...style }, ...rest }, children);
}
export function Section({ children, title, style, ...rest }) {
  return React.createElement('div', { style: { ...style }, ...rest },
    title ? React.createElement('h3', { style: { margin: '0 0 12px', fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: v('--ds-text-primary') } }, title) : null,
    children
  );
}
export function Box({ children, fill, grow, shrink, padding, style, ...rest }) {
  const p = padding ? space[padding] || padding : undefined;
  return React.createElement('div', { style: { ...flexProps(fill || grow, shrink), ...(p ? { padding: p } : {}), ...style }, ...rest }, children);
}
export function ScrollArea({ children, maxHeight, style, ...rest }) {
  return React.createElement('div', { style: { overflow: 'auto', maxHeight: maxHeight || '400px', ...style }, ...rest }, children);
}
export function Spacer({ size, style, ...rest }) {
  const s = space[size] || size || space.md;
  return React.createElement('div', { style: { minHeight: s, minWidth: s, ...style }, ...rest });
}
export function Divider({ subtle, orientation, my, style, ...rest }) {
  if (orientation === 'vertical') {
    return React.createElement('div', { role: 'separator', style: { width: '1px', alignSelf: 'stretch', background: subtle ? v('--ds-border-subtle') : v('--ds-border-default'), ...style }, ...rest });
  }
  const margin = my ? (space[my] || my) + ' 0' : '0';
  return React.createElement('hr', { style: { border: 'none', borderTop: '1px solid ' + (subtle ? v('--ds-border-subtle') : v('--ds-border-default')), margin, ...style }, ...rest });
}

// ── Content ──
export function Text({ children, size, weight, color, style, ...rest }) {
  const c = color === 'muted' ? v('--ds-text-muted') : color === 'inverse' ? '#fff' : color === 'secondary' ? v('--ds-text-secondary') : v('--ds-text-primary');
  return React.createElement('span', { style: { fontSize: fontSize[size] || fontSize.md, fontWeight: fontWeight[weight] || fontWeight.normal, color: c, lineHeight: 1.5, ...style }, ...rest }, children);
}
export function Heading({ children, level, style, ...rest }) {
  const tag = 'h' + (level || 2);
  const sizes = { 1: fontSize['3xl'], 2: fontSize['2xl'], 3: fontSize.xl, 4: fontSize.lg, 5: fontSize.md, 6: fontSize.sm };
  return React.createElement(tag, { style: { margin: 0, fontSize: sizes[level || 2] || fontSize['2xl'], fontWeight: fontWeight.semibold, lineHeight: 1.3, color: v('--ds-text-primary'), ...style }, ...rest }, children);
}

// ── Actions ──
export function Button({ children, variant, size, onClick, disabled, style, ...rest }) {
  const bg = variant === 'ghost' ? 'transparent' : variant === 'secondary' ? v('--ds-bg-sunken') : variant === 'danger' ? v('--ds-danger') : v('--ds-accent-primary');
  const fg = variant === 'ghost' || variant === 'secondary' ? v('--ds-text-primary') : '#fff';
  const p = size === 'sm' ? '4px 12px' : size === 'lg' ? '10px 24px' : '6px 16px';
  const fs = size === 'sm' ? fontSize.sm : fontSize.md;
  return React.createElement('button', { onClick, disabled, style: { background: bg, color: fg, border: 'none', borderRadius: radius.md, padding: p, fontSize: fs, fontWeight: fontWeight.medium, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, ...style }, ...rest }, children);
}
export function IconButton({ icon, label, onClick, disabled, size, style, ...rest }) {
  const s = size === 'sm' ? '28px' : size === 'lg' ? '40px' : '32px';
  return React.createElement('button', { onClick, disabled, title: label, 'aria-label': label, style: { background: 'transparent', border: 'none', borderRadius: radius.md, width: s, height: s, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: disabled ? 'not-allowed' : 'pointer', color: v('--ds-text-primary'), ...style }, ...rest }, icon);
}

// ── Forms ──
export function Field({ children, label, error, style, ...rest }) {
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', ...style }, ...rest },
    label ? React.createElement('label', { style: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: v('--ds-text-secondary') } }, label) : null,
    children,
    error ? React.createElement('span', { style: { fontSize: fontSize.xs, color: v('--ds-danger') } }, error) : null
  );
}
export function Input({ value, onChange, placeholder, type, disabled, style, ...rest }) {
  return React.createElement('input', { value, onChange, placeholder, type: type || 'text', disabled, style: { padding: '6px 12px', border: '1px solid ' + v('--ds-border-default'), borderRadius: radius.md, fontSize: fontSize.md, outline: 'none', background: v('--ds-bg-panel'), color: v('--ds-text-primary'), ...style }, ...rest });
}
export function SearchField({ value, onChange, placeholder, style, ...rest }) {
  return React.createElement('input', { value, onChange, placeholder: placeholder || 'Search...', type: 'search', style: { padding: '6px 12px', border: '1px solid ' + v('--ds-border-default'), borderRadius: radius.md, fontSize: fontSize.md, outline: 'none', width: '100%', background: v('--ds-bg-panel'), color: v('--ds-text-primary'), ...style }, ...rest });
}
export function FilterChips({ children, options, value, onChange, style, ...rest }) {
  if (options && Array.isArray(options)) {
    return React.createElement('div', { style: { display: 'flex', gap: space.xs, flexWrap: 'wrap', ...style }, ...rest },
      options.map(opt => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label || opt.value;
        const active = val === value;
        return React.createElement('button', {
          key: val,
          onClick: () => onChange && onChange(val),
          style: {
            padding: '4px 12px', borderRadius: radius.full, fontSize: fontSize.sm,
            fontWeight: fontWeight.medium, cursor: 'pointer', border: 'none',
            background: active ? v('--ds-accent-primary') : v('--ds-bg-sunken'),
            color: active ? '#fff' : v('--ds-text-primary'),
            transition: 'background 150ms, color 150ms',
          }
        }, label);
      })
    );
  }
  return React.createElement('div', { style: { display: 'flex', gap: space.xs, flexWrap: 'wrap', ...style }, ...rest }, children);
}

// ── Feedback ──
export function Badge({ children, variant, style, ...rest }) {
  const colors = { info: ['#dbeafe','#1e40af'], success: ['#dcfce7','#166534'], warning: ['#fef3c7','#92400e'], danger: ['#fee2e2','#991b1b'], running: ['#dcfce7','#166534'], neutral: [v('--ds-bg-sunken'), v('--ds-text-secondary')] };
  const [bg, fg] = colors[variant] || colors.neutral;
  return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: radius.full, fontSize: fontSize.xs, fontWeight: fontWeight.medium, background: bg, color: fg, ...style }, ...rest }, children);
}
export function Spinner({ size, style, ...rest }) {
  const s = size === 'sm' ? '16px' : size === 'lg' ? '32px' : '24px';
  return React.createElement('div', { style: { width: s, height: s, border: '2px solid ' + v('--ds-border-default'), borderTopColor: v('--ds-accent-primary'), borderRadius: '50%', animation: 'spin 0.6s linear infinite', ...style }, ...rest });
}
export function EmptyState({ children, icon, title, description, style, ...rest }) {
  return React.createElement('div', { style: { textAlign: 'center', padding: space.xl, color: v('--ds-text-muted'), ...style }, ...rest },
    title ? React.createElement('p', { style: { fontSize: fontSize.lg, fontWeight: fontWeight.medium, margin: '8px 0 4px', color: v('--ds-text-secondary') } }, title) : null,
    description ? React.createElement('p', { style: { fontSize: fontSize.sm, margin: '4px 0' } }, description) : null,
    children
  );
}

// ── Overlays ──
export function Dialog({ children, open, onClose, title, style, ...rest }) {
  if (!open) return null;
  return React.createElement('div', { style: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', zIndex: 1000 }, onClick: onClose },
    React.createElement('div', { onClick: e => e.stopPropagation(), style: { background: v('--ds-bg-panel'), borderRadius: radius.lg, padding: space.lg, maxWidth: '480px', width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,.15)', color: v('--ds-text-primary'), ...style }, ...rest },
      title ? React.createElement('h3', { style: { margin: '0 0 12px', fontSize: fontSize.lg, fontWeight: fontWeight.semibold } }, title) : null,
      children
    )
  );
}
export function Tooltip({ children }) { return children; }

// ── Data Display ──
export function Card({ children, elevated, padding, style, ...rest }) {
  const p = padding ? space[padding] || padding : space.md;
  const shadow = elevated ? '0 4px 12px rgba(0,0,0,0.08)' : 'none';
  return React.createElement('div', { style: { background: v('--ds-bg-panel'), border: '1px solid ' + v('--ds-border-default'), borderRadius: radius.md, padding: p, boxShadow: shadow, ...style }, ...rest }, children);
}
export function Accordion({ children, style, ...rest }) {
  return React.createElement('div', { style: { border: '1px solid ' + v('--ds-border-default'), borderRadius: radius.md, ...style }, ...rest }, children);
}
export function PropertyTable({ data, style, ...rest }) {
  if (!data || typeof data !== 'object') return null;
  const entries = Array.isArray(data) ? data : Object.entries(data).map(([k,v]) => ({ label: k, value: v }));
  return React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: fontSize.sm, ...style }, ...rest },
    React.createElement('tbody', null, entries.map((row, i) =>
      React.createElement('tr', { key: i, style: { borderBottom: '1px solid ' + 'var(--ds-border-subtle)' } },
        React.createElement('td', { style: { padding: '6px 8px', fontWeight: fontWeight.medium, color: 'var(--ds-text-muted)', width: '40%' } }, row.label),
        React.createElement('td', { style: { padding: '6px 8px', color: 'var(--ds-text-primary)' } }, String(row.value ?? ''))
      )
    ))
  );
}
export function KeyValueTable({ data, style, ...rest }) { return PropertyTable({ data, style, ...rest }); }
export function CodeBlock({ children, style, ...rest }) {
  return React.createElement('pre', { style: { background: v('--ds-code-bg'), color: v('--ds-code-fg'), padding: space.md, borderRadius: radius.md, overflow: 'auto', fontSize: fontSize.sm, lineHeight: 1.6, ...style }, ...rest },
    React.createElement('code', null, children)
  );
}
export function JsonViewer({ data, style, ...rest }) {
  return React.createElement('pre', { style: { background: v('--ds-bg-sunken'), color: v('--ds-text-primary'), padding: space.md, borderRadius: radius.md, overflow: 'auto', fontSize: fontSize.sm, lineHeight: 1.5, ...style }, ...rest },
    React.createElement('code', null, JSON.stringify(data, null, 2))
  );
}
export function Tabs({ children, style, ...rest }) {
  return React.createElement('div', { style: { ...style }, ...rest }, children);
}
export function Toolbar({ children, style, ...rest }) {
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: space.sm, padding: space.xs + ' 0', borderBottom: '1px solid ' + v('--ds-border-default'), ...style }, ...rest }, children);
}
export function Timeline({ children, style, ...rest }) {
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: space.sm, ...style }, ...rest }, children);
}

// ── Misc ──
export function Icon({ name, size, color, style, ...rest }) {
  const s = size === 'sm' ? '16px' : size === 'lg' ? '24px' : '20px';
  return React.createElement('span', { style: { display: 'inline-flex', width: s, height: s, alignItems: 'center', justifyContent: 'center', color: color || v('--ds-text-primary'), ...style }, 'aria-label': name, ...rest });
}
export function Avatar({ name, src, size, style, ...rest }) {
  const s = size === 'sm' ? '24px' : size === 'lg' ? '40px' : '32px';
  if (src) return React.createElement('img', { src, alt: name, style: { width: s, height: s, borderRadius: '50%', objectFit: 'cover', ...style }, ...rest });
  const initial = (name || '?')[0].toUpperCase();
  return React.createElement('div', { style: { width: s, height: s, borderRadius: '50%', background: '#6366f1', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: parseInt(s) * 0.45 + 'px', fontWeight: fontWeight.semibold, ...style }, ...rest }, initial);
}
export function Logo({ style, ...rest }) {
  return React.createElement('span', { style: { fontWeight: fontWeight.bold, fontSize: fontSize.lg, color: v('--ds-text-primary'), ...style }, ...rest }, 'Phoenix');
}

// ── Collection ──
export function List({ children, gap: g, dividers, style, ...rest }) {
  const items = React.Children.toArray(children);
  if (!dividers) {
    return React.createElement('div', { role: 'list', style: { display: 'flex', flexDirection: 'column', gap: gap(g || 'none'), ...style }, ...rest }, children);
  }
  const withDividers = [];
  items.forEach((child, i) => {
    withDividers.push(child);
    if (i < items.length - 1) withDividers.push(React.createElement('hr', { key: 'div-' + i, style: { border: 'none', borderTop: '1px solid ' + v('--ds-border-subtle'), margin: 0 } }));
  });
  return React.createElement('div', { role: 'list', style: { display: 'flex', flexDirection: 'column', ...style }, ...rest }, ...withDividers);
}
export function ListItem({ children, icon, avatar, title, subtitle, value, clickable, selected, onClick, style, ...rest }) {
  const py = space.sm;
  const px = space.md;
  const hasSlots = title || subtitle || icon || avatar || value;
  if (!hasSlots && !children) return null;
  if (!hasSlots) {
    return React.createElement('div', { role: 'listitem', onClick, style: { padding: py + ' ' + px, cursor: clickable || onClick ? 'pointer' : 'default', background: selected ? v('--ds-bg-sunken') : 'transparent', ...style }, ...rest }, children);
  }
  const leading = icon ? React.createElement(Icon, { name: icon, size: 'sm' }) : avatar ? React.createElement(Avatar, { src: avatar, size: 'sm' }) : null;
  const main = React.createElement('div', { style: { flex: '1 1 0%', minWidth: 0 } },
    title ? React.createElement('div', { style: { fontSize: fontSize.md, fontWeight: fontWeight.medium, color: v('--ds-text-primary') } }, title) : null,
    subtitle ? React.createElement('div', { style: { fontSize: fontSize.sm, color: v('--ds-text-muted'), marginTop: '2px' } }, subtitle) : null
  );
  const trailing = value ? React.createElement('span', { style: { fontSize: fontSize.sm, color: v('--ds-text-secondary'), flexShrink: 0 } }, value) : children || null;
  return React.createElement('div', { role: 'listitem', onClick, style: { display: 'flex', alignItems: 'center', gap: space.md, padding: py + ' ' + px, cursor: clickable || onClick ? 'pointer' : 'default', background: selected ? v('--ds-bg-sunken') : 'transparent', ...style }, ...rest }, leading, main, trailing);
}

// ── Formatting ──
export function Value({ amount, format, currency, decimals, style, ...rest }) {
  let text = String(amount != null ? amount : '');
  if (typeof amount === 'number') {
    try {
      if (format === 'currency') text = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', minimumFractionDigits: decimals != null ? decimals : 2, maximumFractionDigits: decimals != null ? decimals : 2 }).format(amount);
      else if (format === 'percent') text = new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: decimals != null ? decimals : 0, maximumFractionDigits: decimals != null ? decimals : 1 }).format(amount);
      else if (format === 'compact') text = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: decimals != null ? decimals : 1 }).format(amount);
      else text = new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals != null ? decimals : 2 }).format(amount);
    } catch(e) { text = String(amount); }
  }
  return React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums', ...style }, ...rest }, text);
}

// ── Status / domain ──
export function RunStatusBadge({ status, style, ...rest }) {
  const map = { SUCCEEDED: 'success', FAILED: 'danger', RUNNING: 'info', PAUSED: 'warning', QUEUED: 'neutral', CANCELLED: 'neutral' };
  return Badge({ children: status, variant: map[status] || 'neutral', style, ...rest });
}
export function ChatLayout({ children, style, ...rest }) {
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', ...style }, ...rest }, children);
}
export function ChatMessage({ children, role, style, ...rest }) {
  const isUser = role === 'user';
  return React.createElement('div', { style: { display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', padding: space.xs + ' 0', ...style }, ...rest },
    React.createElement('div', { style: { maxWidth: '80%', padding: space.sm + ' ' + space.md, borderRadius: radius.lg, background: isUser ? v('--ds-accent-primary') : v('--ds-bg-sunken'), color: isUser ? '#fff' : v('--ds-text-primary') } }, children)
  );
}
export function PageHeader({ children, title, style, ...rest }) {
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: space.md + ' 0', borderBottom: '1px solid ' + v('--ds-border-default'), marginBottom: space.md, ...style }, ...rest },
    title ? React.createElement('h1', { style: { margin: 0, fontSize: fontSize['2xl'], fontWeight: fontWeight.semibold, color: v('--ds-text-primary') } }, title) : null,
    children
  );
}
`;

/**
 * Chart shim — separate virtual module to avoid pulling recharts into non-chart artifacts.
 * Imported as `@aflow/design-system/charts` by generated chart-using code.
 * Recharts is external — resolved via the iframe import map at runtime.
 */
const DS_CHART_SHIM_SOURCE = `
import React from 'react';
import { ResponsiveContainer, LineChart as RLine, BarChart as RBar, AreaChart as RArea, PieChart as RPie, Line, Bar, Area, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

const COLORS = ['#2563eb','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16'];
const v = (t) => 'var(' + t + ')';

function ph(name, h, style) {
  return React.createElement('div', { style: { height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', color: v('--ds-text-muted'), border: '1px dashed ' + v('--ds-border-default'), borderRadius: '8px', fontSize: '13px', ...style } }, name + ': provide data and axis keys');
}

export function LineChart({ data, xKey, yKeys, height, colors, showGrid, showLegend, showTooltip, curved, style, ...rest }) {
  const h = height || 300; const c = colors || COLORS;
  if (!data || !xKey || !yKeys) return ph('LineChart', h, style);
  return React.createElement(ResponsiveContainer, { width: '100%', height: h },
    React.createElement(RLine, { data, ...rest },
      showGrid !== false ? React.createElement(CartesianGrid, { strokeDasharray: '3 3', stroke: v('--ds-border-subtle') }) : null,
      React.createElement(XAxis, { dataKey: xKey, tick: { fontSize: 12 }, stroke: v('--ds-text-muted') }),
      React.createElement(YAxis, { tick: { fontSize: 12 }, stroke: v('--ds-text-muted') }),
      showTooltip !== false ? React.createElement(Tooltip, null) : null,
      showLegend !== false && yKeys.length > 1 ? React.createElement(Legend, null) : null,
      ...yKeys.map((key, i) => React.createElement(Line, { key, type: curved !== false ? 'monotone' : 'linear', dataKey: key, stroke: c[i % c.length], strokeWidth: 2, dot: false }))
    )
  );
}

export function BarChart({ data, xKey, yKeys, height, colors, stacked, showGrid, showLegend, showTooltip, style, ...rest }) {
  const h = height || 300; const c = colors || COLORS;
  if (!data || !xKey || !yKeys) return ph('BarChart', h, style);
  return React.createElement(ResponsiveContainer, { width: '100%', height: h },
    React.createElement(RBar, { data, ...rest },
      showGrid !== false ? React.createElement(CartesianGrid, { strokeDasharray: '3 3', stroke: v('--ds-border-subtle') }) : null,
      React.createElement(XAxis, { dataKey: xKey, tick: { fontSize: 12 }, stroke: v('--ds-text-muted') }),
      React.createElement(YAxis, { tick: { fontSize: 12 }, stroke: v('--ds-text-muted') }),
      showTooltip !== false ? React.createElement(Tooltip, null) : null,
      showLegend !== false && yKeys.length > 1 ? React.createElement(Legend, null) : null,
      ...yKeys.map((key, i) => React.createElement(Bar, { key, dataKey: key, fill: c[i % c.length], stackId: stacked ? 'stack' : undefined }))
    )
  );
}

export function AreaChart({ data, xKey, yKeys, height, colors, stacked, showGrid, showLegend, showTooltip, curved, style, ...rest }) {
  const h = height || 300; const c = colors || COLORS;
  if (!data || !xKey || !yKeys) return ph('AreaChart', h, style);
  return React.createElement(ResponsiveContainer, { width: '100%', height: h },
    React.createElement(RArea, { data, ...rest },
      showGrid !== false ? React.createElement(CartesianGrid, { strokeDasharray: '3 3', stroke: v('--ds-border-subtle') }) : null,
      React.createElement(XAxis, { dataKey: xKey, tick: { fontSize: 12 }, stroke: v('--ds-text-muted') }),
      React.createElement(YAxis, { tick: { fontSize: 12 }, stroke: v('--ds-text-muted') }),
      showTooltip !== false ? React.createElement(Tooltip, null) : null,
      showLegend !== false && yKeys.length > 1 ? React.createElement(Legend, null) : null,
      ...yKeys.map((key, i) => React.createElement(Area, { key, type: curved !== false ? 'monotone' : 'linear', dataKey: key, stroke: c[i % c.length], fill: c[i % c.length], fillOpacity: 0.15, stackId: stacked ? 'stack' : undefined }))
    )
  );
}

export function PieChart({ data, nameKey, valueKey, height, colors, donut, showLegend, showTooltip, showLabels, style, ...rest }) {
  const h = height || 300; const c = colors || COLORS;
  if (!data || !nameKey || !valueKey) return ph('PieChart', h, style);
  return React.createElement(ResponsiveContainer, { width: '100%', height: h },
    React.createElement(RPie, rest,
      React.createElement(Pie, { data, dataKey: valueKey, nameKey, cx: '50%', cy: '50%', innerRadius: donut ? '50%' : 0, outerRadius: '80%', label: showLabels || false },
        data.map((entry, i) => React.createElement(Cell, { key: i, fill: c[i % c.length] }))
      ),
      showTooltip !== false ? React.createElement(Tooltip, null) : null,
      showLegend !== false ? React.createElement(Legend, null) : null
    )
  );
}

export function Sparkline({ data, valueKey, width, height, color, style, ...rest }) {
  const w = width || 120; const h = height || 32; const c = color || '#2563eb';
  if (!data || !valueKey) return React.createElement('span', { style: { display: 'inline-block', width: w, height: h, ...style } }, '~');
  return React.createElement(ResponsiveContainer, { width: w, height: h },
    React.createElement(RLine, { data, ...rest },
      React.createElement(Line, { type: 'monotone', dataKey: valueKey, stroke: c, strokeWidth: 1.5, dot: false })
    )
  );
}
`;

/**
 * esbuild plugin that resolves @aflow/design-system imports to the inline shim.
 * This makes compiled artifacts fully self-contained — no external DS dependency.
 *
 * Two virtual modules:
 * - `@aflow/design-system` → base DS shim (no recharts dependency)
 * - `@aflow/design-system/charts` → chart wrapper shim (imports recharts)
 *
 * Chart components are in a separate module so non-chart artifacts don't pull in
 * recharts, which would fail when recharts isn't in the import map.
 */
function createDsShimPlugin(): esbuild.Plugin {
  return {
    name: 'phoenix-ds-shim',
    setup(build) {
      // Resolve chart sub-path first (more specific)
      build.onResolve({ filter: /^@aflow\/design-system\/charts$/ }, () => ({
        path: 'phoenix-ds-charts-shim',
        namespace: 'phoenix-ds-charts',
      }));

      // Resolve base @aflow/design-system import
      build.onResolve({ filter: /^@aflow\/design-system$/ }, () => ({
        path: 'phoenix-ds-shim',
        namespace: 'phoenix-ds',
      }));

      // Load base DS shim
      build.onLoad({ filter: /.*/, namespace: 'phoenix-ds' }, () => ({
        contents: DS_SHIM_SOURCE,
        loader: 'jsx',
      }));

      // Load chart shim
      build.onLoad({ filter: /.*/, namespace: 'phoenix-ds-charts' }, () => ({
        contents: DS_CHART_SHIM_SOURCE,
        loader: 'jsx',
      }));
    },
  };
}

// ============================================================================
// Dangerous patterns
// ============================================================================

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; message: string; code: string }> = [
  {
    pattern: /\beval\s*\(/g,
    message: 'eval() is not allowed in generated artifacts',
    code: 'DANGEROUS_EVAL',
  },
  {
    pattern: /\bnew\s+Function\s*\(/g,
    message: 'new Function() is not allowed in generated artifacts',
    code: 'DANGEROUS_FUNCTION_CONSTRUCTOR',
  },
  {
    pattern: /\bdocument\s*\.\s*write\s*\(/g,
    message: 'document.write() is not allowed',
    code: 'DANGEROUS_DOCUMENT_WRITE',
  },
  {
    pattern: /\bfetch\s*\(/g,
    message: 'fetch() is not allowed — use approved data bindings instead',
    code: 'DANGEROUS_FETCH',
  },
  {
    pattern: /\bXMLHttpRequest\b/g,
    message: 'XMLHttpRequest is not allowed',
    code: 'DANGEROUS_XHR',
  },
  {
    pattern: /\bimportScripts\s*\(/g,
    message: 'importScripts() is not allowed',
    code: 'DANGEROUS_IMPORT_SCRIPTS',
  },
  {
    pattern: /\bwindow\s*\.\s*open\s*\(/g,
    message: 'window.open() is not allowed in sandboxed artifacts',
    code: 'DANGEROUS_WINDOW_OPEN',
  },
];

// ============================================================================
// Step 1: Import validation
// ============================================================================

function validateImports(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Match static imports: import ... from '...' and import '...'
  const importRegex = /import\s+(?:(?:[\w*{}\s,]+)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(source)) !== null) {
    const specifier = match[1]!;

    if (!isCompilerResolvedImport(specifier)) {
      const lineNumber = source.substring(0, match.index).split('\n').length;
      diagnostics.push({
        severity: 'error',
        code: 'DISALLOWED_IMPORT',
        message: `Import "${specifier}" is not in the allowed library list. Allowed: ${[...ALLOWED_IMPORT_SPECIFIERS].join(', ')}`,
        line: lineNumber,
      });
    }
  }

  // Also check dynamic imports
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(source)) !== null) {
    const specifier = match[1]!;
    if (!isCompilerResolvedImport(specifier)) {
      const lineNumber = source.substring(0, match.index).split('\n').length;
      diagnostics.push({
        severity: 'error',
        code: 'DISALLOWED_DYNAMIC_IMPORT',
        message: `Dynamic import("${specifier}") is not allowed. Use static imports from the allowed library list.`,
        line: lineNumber,
      });
    }
  }

  return diagnostics;
}

// ============================================================================
// Step 2: Dangerous pattern detection
// ============================================================================

function validateDangerousPatterns(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  for (const { pattern, message, code } of DANGEROUS_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const lineNumber = source.substring(0, match.index).split('\n').length;
      diagnostics.push({
        severity: 'error',
        code,
        message,
        line: lineNumber,
      });
    }
  }

  return diagnostics;
}

// ============================================================================
// Step 3: Component usage validation against catalog
// ============================================================================

function validateComponentUsage(
  source: string,
  catalogComponents: string[],
): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const catalogSet = new Set(catalogComponents);

  // Find JSX component usage: <ComponentName or <ComponentName.
  const jsxRegex = /<([A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)?)\s/g;
  const usedComponents = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = jsxRegex.exec(source)) !== null) {
    const componentName = match[1]!.split('.')[0]!;
    usedComponents.add(componentName);
  }

  // Check standard React components we always allow
  const alwaysAllowed = new Set(['React', 'Fragment']);

  for (const name of usedComponents) {
    if (!catalogSet.has(name) && !alwaysAllowed.has(name)) {
      diagnostics.push({
        severity: 'warning',
        code: 'UNKNOWN_COMPONENT',
        message: `Component <${name}> is not in the design system catalog. It may not render correctly.`,
      });
    }
  }

  return diagnostics;
}

// ============================================================================
// Step 4: esbuild compilation
// ============================================================================

async function compileWithEsbuild(
  source: string,
  kind: 'react_tsx' | 'html_js',
): Promise<{ code: string; diagnostics: ValidationDiagnostic[] }> {
  const diagnostics: ValidationDiagnostic[] = [];

  // External list: everything except @aflow/design-system (resolved by shim plugin)
  const external = ALLOWED_IMPORTS.filter(
    (a) => !a.specifier.startsWith('@aflow/design-system'),
  ).map((a) => a.specifier);

  try {
    const result = await esbuild.build({
      stdin: {
        contents: source,
        loader: kind === 'react_tsx' ? 'tsx' : 'js',
        sourcefile: kind === 'react_tsx' ? 'artifact.tsx' : 'artifact.js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2022',
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      external,
      plugins: [createDsShimPlugin()],
      // The compiled module is inlined into the page that renders it, so its
      // bytes are the artifact — every byte is stored per version and shipped
      // per read. Nothing reads the output by name: the conformance gate reads
      // source, and the default export is rewritten by a pattern that survives
      // mangling. Sourcemaps stay off deliberately — one would hand the bytes
      // back and double the artifact.
      minify: true,
      sourcemap: false,
      logLevel: 'silent',
    });

    // Collect warnings
    for (const warning of result.warnings) {
      diagnostics.push({
        severity: 'warning',
        code: 'ESBUILD_WARNING',
        message: warning.text,
        line: warning.location?.line,
        column: warning.location?.column,
      });
    }

    const outputFile = result.outputFiles[0];
    if (!outputFile) {
      diagnostics.push({
        severity: 'error',
        code: 'ESBUILD_NO_OUTPUT',
        message: 'esbuild produced no output',
      });
      return { code: '', diagnostics };
    }

    return { code: outputFile.text, diagnostics };
  } catch (err) {
    const error = err as Partial<esbuild.BuildFailure>;
    if (error.errors) {
      for (const e of error.errors) {
        diagnostics.push({
          severity: 'error',
          code: 'ESBUILD_ERROR',
          message: e.text,
          line: e.location?.line,
          column: e.location?.column,
        });
      }
    } else {
      diagnostics.push({
        severity: 'error',
        code: 'ESBUILD_UNKNOWN_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { code: '', diagnostics };
  }
}

// ============================================================================
// Step 5: Post-process esbuild ESM output
// ============================================================================

/**
 * Rewrite esbuild's default export to a known variable name.
 *
 * esbuild ESM output ends with patterns like:
 *   export { ComponentName as default };
 *   export { component_name_default as default };
 *   export default ComponentName;
 *
 * Since we inline the compiled code into a `<script type="module">`, the
 * `export` keyword is valid syntax but useless (nothing imports it). We
 * rewrite it to assign the component to `__phoenix_default_export` so the
 * wrapper code can reference it.
 */
export function rewriteDefaultExport(code: string): string {
  // Pattern 1: export { X as default };  or  export { X as default, ... };
  const namedExportRe = /export\s*\{([^}]*?\b(\w+)\s+as\s+default\b[^}]*)\};?/;
  const m1 = namedExportRe.exec(code);
  if (m1) {
    const varName = m1[2]!;
    // Remove the export statement entirely, assign to known name
    return code.replace(namedExportRe, `var __phoenix_default_export = ${varName};`);
  }

  // Pattern 2: export default X;  or  export default function X(...)
  const defaultExportRe = /export\s+default\s+/;
  if (defaultExportRe.test(code)) {
    return code.replace(defaultExportRe, 'var __phoenix_default_export = ');
  }

  return code;
}

// ============================================================================
// Step 6: Standalone HTML generation
// ============================================================================

/**
 * CSS custom properties for DS theme tokens.
 * Defines light and dark mode values. Theme is toggled via data-theme="dark" on <html>.
 */
export const DS_THEME_CSS = `
  :root {
    --ds-text-primary: #141414;
    --ds-text-muted: #8a8a8a;
    --ds-text-secondary: #3d3d3d;
    --ds-bg-surface: #f6f4ef;
    --ds-bg-panel: #fdfcf9;
    --ds-bg-sunken: #edeae2;
    --ds-border-default: #e0dcd1;
    --ds-border-subtle: #ebe8df;
    --ds-accent-primary: #6a48b8;
    --ds-highlight: #d4a030;
    --ds-danger: #d43d3d;
    --ds-code-bg: #1e1e2e;
    --ds-code-fg: #cdd6f4;
  }
  html[data-theme='dark'] {
    --ds-text-primary: #d7d4c3;
    --ds-text-muted: #6b6b6b;
    --ds-text-secondary: #a3a3a3;
    --ds-bg-surface: #121212;
    --ds-bg-panel: #1c1d20;
    --ds-bg-sunken: #0e0e10;
    --ds-border-default: #2b2b2b;
    --ds-border-subtle: #232323;
    --ds-accent-primary: #b89edf;
    --ds-highlight: #d4a94e;
    --ds-danger: #cf465d;
    --ds-code-bg: #0d0d14;
    --ds-code-fg: #cdd6f4;
  }
`;

/** The one host every compiled React shell resolves its runtime from. */
export const REACT_RUNTIME_ORIGIN = 'https://esm.sh';

/**
 * React runtime modules for the iframe import map. react-dom/client is pinned
 * without `?bundle` so it shares the React instance the top-level `react`
 * entry resolves to — with `?bundle` each URL carries its own copy and every
 * hook throws on a null dispatcher.
 */
export const REACT_RUNTIME_IMPORT_MAP: Record<string, string> = {
  react: `${REACT_RUNTIME_ORIGIN}/react@19?bundle`,
  'react-dom': `${REACT_RUNTIME_ORIGIN}/react-dom@19?external=react`,
  'react-dom/client': `${REACT_RUNTIME_ORIGIN}/react-dom@19/client?external=react`,
};

/**
 * Optional external libraries and their esm.sh URLs.
 * Included in the import map only when the compiled code actually imports them.
 */
const OPTIONAL_EXTERNALS: Record<string, string> = {
  recharts: 'https://esm.sh/recharts@2?external=react',
  katex: 'https://esm.sh/katex@0.16?bundle',
};

/**
 * Scan compiled code for `from "specifier"` / `from 'specifier'` to detect
 * which external libraries are actually used. This is deterministic —
 * based on the compiled output, not prompt heuristics.
 */
function detectUsedExternals(compiledCode: string): Set<string> {
  const used = new Set<string>();
  const importRe = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(compiledCode)) !== null) {
    const specifier = m[1]!;
    if (specifier in OPTIONAL_EXTERNALS) {
      used.add(specifier);
    }
  }
  return used;
}

function generateStandaloneHtml(
  compiledCode: string,
  kind: 'react_tsx' | 'html_js',
  _allowedLibraries: string[],
  sampleData?: Record<string, unknown>,
): string {
  // @aflow/design-system is NOT listed here — it's bundled inline by the
  // esbuild DS shim plugin at compile time, so no external import is needed.
  const importMapEntries: Record<string, string> = { ...REACT_RUNTIME_IMPORT_MAP };

  // Detect which optional externals are actually used in the compiled output
  const usedExternals = detectUsedExternals(compiledCode);
  for (const ext of usedExternals) {
    importMapEntries[ext] = OPTIONAL_EXTERNALS[ext]!;
  }

  const importMap = JSON.stringify({ imports: importMapEntries }, null, 2);

  if (kind === 'html_js') {
    // For HTML/JS artifacts, the compiled code IS the content
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline'; connect-src https://esm.sh; img-src data: blob:; font-src https://esm.sh;">
<style>
  ${DS_THEME_CSS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; padding: 16px; color: var(--ds-text-primary); background: var(--ds-bg-surface); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="root"></div>
<script type="importmap">${importMap}</script>
<script type="module">
${compiledCode}
</script>
<script>
${THEME_LISTENER_JS}
${AFLOW_HOST_PROTOCOL_JS}
// Notify parent of resize
const ro = new ResizeObserver(() => {
  parent.postMessage({ type: 'phoenix:resize', height: document.body.scrollHeight }, '*');
});
ro.observe(document.body);

// Forward errors to parent
window.addEventListener('error', (e) => {
  parent.postMessage({ type: 'phoenix:error', message: e.message, filename: e.filename, line: e.lineno }, '*');
});
</script>
</body>
</html>`;
  }

  // React/TSX artifact — wrap in a React render shell.
  // esbuild ESM output has "export { X as default }" — we rewrite it to capture
  // the default export into a known variable name that the wrapper can reference.
  const patchedCode = rewriteDefaultExport(compiledCode);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://esm.sh; style-src 'unsafe-inline'; connect-src https://esm.sh; img-src data: blob:; font-src https://esm.sh;">
<style>
  ${DS_THEME_CSS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; padding: 16px; color: var(--ds-text-primary); background: var(--ds-bg-surface); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="root"></div>
<script type="importmap">${importMap}</script>
<script type="module">
// ── Generated artifact (compiled + DS shim inlined by esbuild) ──
// React/ReactDOM are external (import-mapped); DS components are bundled in.
${patchedCode}

// ── Render shell ──
// Import React/ReactDOM here using dynamic import to avoid duplicate
// declarations — the compiled code above already imports React statically.
const { default: __React } = await import('react');
const { createRoot: __createRoot } = await import('react-dom/client');

let _phoenixData = ${sampleData ? JSON.stringify(sampleData) : '{}'};
let _phoenixApplet = null;
let _root = null;

const ArtifactComponent = typeof __phoenix_default_export !== 'undefined'
  ? __phoenix_default_export
  : () => __React.createElement('div', { style: { padding: '16px', color: 'var(--ds-text-muted)' } }, 'No default export found');

function renderApp() {
  if (!_root) {
    _root = __createRoot(document.getElementById('root'));
  }
  _root.render(__React.createElement(ArtifactComponent, { data: _phoenixData, ...(_phoenixApplet ?? {}) }));
}

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'phoenix:data') {
    _phoenixData = event.data.payload || {};
    renderApp();
  }
});

// Live instance state re-renders with { state, version, viewer } props alongside data.
window.addEventListener('aflowstate', (event) => {
  _phoenixApplet = event.detail;
  renderApp();
});

${THEME_LISTENER_JS}
${AFLOW_HOST_PROTOCOL_JS}

// Initial render + notify parent
renderApp();
parent.postMessage({ type: 'phoenix:ready' }, '*');

new ResizeObserver(() => {
  parent.postMessage({ type: 'phoenix:resize', height: document.body.scrollHeight }, '*');
}).observe(document.body);

window.addEventListener('error', (e) => {
  parent.postMessage({ type: 'phoenix:error', message: e.message, filename: e.filename, line: e.lineno }, '*');
});
</script>
</body>
</html>`;
}

// ============================================================================
// Full validation pipeline
// ============================================================================

export async function validateAndCompile(
  source: string,
  kind: 'react_tsx' | 'html_js',
  allowedLibraries: string[],
  catalogComponentNames: string[],
  sampleData?: Record<string, unknown>,
): Promise<ValidationResult> {
  const allDiagnostics: ValidationDiagnostic[] = [];

  // Step 1: Import validation
  const importDiags = validateImports(source);
  allDiagnostics.push(...importDiags);

  // Step 2: Dangerous pattern detection
  const dangerDiags = validateDangerousPatterns(source);
  allDiagnostics.push(...dangerDiags);

  // Step 3: Component usage validation
  const componentDiags = validateComponentUsage(source, catalogComponentNames);
  allDiagnostics.push(...componentDiags);

  // If there are errors so far, don't attempt compilation
  const hasErrors = allDiagnostics.some((d) => d.severity === 'error');
  if (hasErrors) {
    return {
      valid: false,
      diagnostics: allDiagnostics,
    };
  }

  // Step 4: esbuild compilation
  const { code, diagnostics: buildDiags } = await compileWithEsbuild(source, kind);
  allDiagnostics.push(...buildDiags);

  const hasCompileErrors = buildDiags.some((d) => d.severity === 'error');
  if (hasCompileErrors || !code) {
    return {
      valid: false,
      diagnostics: allDiagnostics,
    };
  }

  // Step 5: Generate standalone HTML
  const standaloneHtml = generateStandaloneHtml(code, kind, allowedLibraries, sampleData);

  return {
    valid: true,
    diagnostics: allDiagnostics,
    compiledCode: code,
    standaloneHtml,
  };
}
