/**
 * Compiling a submitted artifact into a page, as the product.
 *
 * The design-system shim, the theme bridge, the esbuild plugin that resolves the
 * shim, the document the result is wrapped in, and the handler itself — none of
 * it is one application's, and a second application compiling artifacts
 * differently would be a second product. A route file names only the identity
 * that decides who may ask.
 *
 * Framework-free: a `Request` is all it takes.
 */
import * as esbuild from 'esbuild';

import type { WebIdentity } from './webIdentity.js';

export const MAX_SOURCE_BYTES = 1024 * 1024;

// ============================================================================
// DS Shim — same as executor's validation.ts (lightweight copy for dev recompile)
// ============================================================================

const DS_SHIM_SOURCE = `
import React from 'react';

const space = { none: '0px', xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px', '2xl': '48px' };
const radius = { sm: '4px', md: '8px', lg: '12px', xl: '16px', full: '9999px' };
const fontSize = { xs: '11px', sm: '13px', md: '14px', lg: '16px', xl: '20px', '2xl': '24px', '3xl': '30px' };
const fontWeight = { normal: '400', medium: '500', semibold: '600', bold: '700' };

function gap(g) { return space[g] || g || '0'; }
function rad(r) { return radius[r] || r || '0'; }
function jc(j) { return j === 'between' ? 'space-between' : j === 'around' ? 'space-around' : j === 'evenly' ? 'space-evenly' : j === 'start' ? 'flex-start' : j === 'end' ? 'flex-end' : j || 'flex-start'; }
function ai(a) { return a === 'start' ? 'flex-start' : a === 'end' ? 'flex-end' : a || 'stretch'; }
const v = (token) => 'var(' + token + ')';

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
export function Text({ children, size, weight, color, style, ...rest }) {
  const c = color === 'muted' ? v('--ds-text-muted') : color === 'inverse' ? '#fff' : color === 'secondary' ? v('--ds-text-secondary') : v('--ds-text-primary');
  return React.createElement('span', { style: { fontSize: fontSize[size] || fontSize.md, fontWeight: fontWeight[weight] || fontWeight.normal, color: c, lineHeight: 1.5, ...style }, ...rest }, children);
}
export function Heading({ children, level, style, ...rest }) {
  const tag = 'h' + (level || 2);
  const sizes = { 1: fontSize['3xl'], 2: fontSize['2xl'], 3: fontSize.xl, 4: fontSize.lg, 5: fontSize.md, 6: fontSize.sm };
  return React.createElement(tag, { style: { margin: 0, fontSize: sizes[level || 2] || fontSize['2xl'], fontWeight: fontWeight.semibold, lineHeight: 1.3, color: v('--ds-text-primary'), ...style }, ...rest }, children);
}
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
      React.createElement('tr', { key: i, style: { borderBottom: '1px solid var(--ds-border-subtle)' } },
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

// ============================================================================
// Theme CSS + HTML generation (mirrors executor's validation.ts)
// ============================================================================

const DS_THEME_CSS = `
  :root {
    --ds-text-primary: #1a1a2e;
    --ds-text-muted: #6b7280;
    --ds-text-secondary: #4b5563;
    --ds-bg-surface: #fafafa;
    --ds-bg-panel: #fff;
    --ds-bg-sunken: #f3f4f6;
    --ds-border-default: #e2e2e8;
    --ds-border-subtle: #f3f4f6;
    --ds-accent-primary: #2563eb;
    --ds-danger: #ef4444;
    --ds-code-bg: #1e1e2e;
    --ds-code-fg: #cdd6f4;
  }
  html[data-theme='dark'] {
    --ds-text-primary: #e2e0d6;
    --ds-text-muted: #9ca3af;
    --ds-text-secondary: #d1d5db;
    --ds-bg-surface: #1e1e2e;
    --ds-bg-panel: #252536;
    --ds-bg-sunken: #16161e;
    --ds-border-default: #3a3a4e;
    --ds-border-subtle: #2a2a3e;
    --ds-accent-primary: #3b82f6;
    --ds-danger: #f87171;
    --ds-code-bg: #0d0d14;
    --ds-code-fg: #cdd6f4;
  }
`;

const THEME_LISTENER_JS = `
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'phoenix:theme') {
    document.documentElement.setAttribute('data-theme', event.data.theme || 'light');
  }
});
`;

function rewriteDefaultExport(code: string): string {
  const namedExportRe = /export\s*\{([^}]*?\b(\w+)\s+as\s+default\b[^}]*)\};?/;
  const m1 = namedExportRe.exec(code);
  if (m1) {
    const varName = m1[2];
    return code.replace(namedExportRe, `var __phoenix_default_export = ${varName};`);
  }
  const defaultExportRe = /export\s+default\s+/;
  if (defaultExportRe.test(code)) {
    return code.replace(defaultExportRe, 'var __phoenix_default_export = ');
  }
  return code;
}

const OPTIONAL_EXTERNALS: Record<string, string> = {
  recharts: 'https://esm.sh/recharts@2?external=react',
  katex: 'https://esm.sh/katex@0.16?bundle',
};

export function generateHtml(compiledCode: string, kind: 'react_tsx' | 'html_js'): string {
  const imports: Record<string, string> = {
    react: 'https://esm.sh/react@19?bundle',
    'react-dom': 'https://esm.sh/react-dom@19?external=react',
    'react-dom/client': 'https://esm.sh/react-dom@19/client?external=react',
  };

  // Detect which optional externals the compiled code actually uses
  const importRe = /from\s+["']([^"']+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(compiledCode)) !== null) {
    const spec = im[1];
    if (spec === undefined) continue;
    const external = OPTIONAL_EXTERNALS[spec];
    if (external !== undefined) imports[spec] = external;
  }

  const importMap = JSON.stringify({ imports }, null, 2);

  if (kind === 'html_js') {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${DS_THEME_CSS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; padding: 16px; color: var(--ds-text-primary); background: var(--ds-bg-surface); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body><div id="root"></div>
<script type="importmap">${importMap}</script>
<script type="module">${compiledCode}</script>
<script>${THEME_LISTENER_JS}
new ResizeObserver(() => { parent.postMessage({ type: 'phoenix:resize', height: document.body.scrollHeight }, '*'); }).observe(document.body);
window.addEventListener('error', (e) => { parent.postMessage({ type: 'phoenix:error', message: e.message, filename: e.filename, line: e.lineno }, '*'); });
</script></body></html>`;
  }

  const patchedCode = rewriteDefaultExport(compiledCode);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${DS_THEME_CSS}
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; padding: 16px; color: var(--ds-text-primary); background: var(--ds-bg-surface); }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body><div id="root"></div>
<script type="importmap">${importMap}</script>
<script type="module">
${patchedCode}

const { default: __React } = await import('react');
const { createRoot: __createRoot } = await import('react-dom/client');
let _phoenixData = {};
let _root = null;
const ArtifactComponent = typeof __phoenix_default_export !== 'undefined'
  ? __phoenix_default_export
  : () => __React.createElement('div', { style: { padding: '16px', color: 'var(--ds-text-muted)' } }, 'No default export found');
function renderApp() {
  if (!_root) _root = __createRoot(document.getElementById('root'));
  _root.render(__React.createElement(ArtifactComponent, { data: _phoenixData }));
}
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'phoenix:data') { _phoenixData = event.data.payload || {}; renderApp(); }
});
${THEME_LISTENER_JS}
renderApp();
parent.postMessage({ type: 'phoenix:ready' }, '*');
new ResizeObserver(() => { parent.postMessage({ type: 'phoenix:resize', height: document.body.scrollHeight }, '*'); }).observe(document.body);
window.addEventListener('error', (e) => { parent.postMessage({ type: 'phoenix:error', message: e.message, filename: e.filename, line: e.lineno }, '*'); });
</script></body></html>`;
}

// ============================================================================
// esbuild compile
// ============================================================================

function createDsShimPlugin(): esbuild.Plugin {
  return {
    name: 'phoenix-ds-shim',
    setup(build) {
      build.onResolve({ filter: /^@aflow\/design-system\/charts$/ }, () => ({
        path: 'phoenix-ds-charts-shim',
        namespace: 'phoenix-ds-charts',
      }));
      build.onResolve({ filter: /^@aflow\/design-system$/ }, () => ({
        path: 'phoenix-ds-shim',
        namespace: 'phoenix-ds',
      }));
      build.onLoad({ filter: /.*/, namespace: 'phoenix-ds' }, () => ({
        contents: DS_SHIM_SOURCE,
        loader: 'jsx',
      }));
      build.onLoad({ filter: /.*/, namespace: 'phoenix-ds-charts' }, () => ({
        contents: DS_CHART_SHIM_SOURCE,
        loader: 'jsx',
      }));
    },
  };
}

export async function compile(source: string, kind: 'react_tsx' | 'html_js') {
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
    external: ['react', 'react-dom', 'react-dom/client', 'recharts', 'katex'],
    plugins: [createDsShimPlugin()],
    minify: false,
    sourcemap: false,
    logLevel: 'silent',
  });

  const output = result.outputFiles[0];
  if (!output) throw new Error('esbuild produced no output');

  return {
    code: output.text,
    warnings: result.warnings.map((w) => ({ message: w.text, line: w.location?.line })),
  };
}

// ============================================================================
// Route handler
// ============================================================================

/**
 * Reads the request body with a running byte count so a chunked request (no
 * Content-Length) cannot buffer unbounded. Returns null once the accumulated
 * bytes exceed MAX_SOURCE_BYTES.
 */
export async function readBodyWithinLimit(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One thing wrong with a submitted artifact, in the caller's terms. */
export interface CompileDiagnostic {
  message: string;
  line?: number | undefined;
  column?: number | undefined;
}

/**
 * The diagnostics behind a failed compile, or `null` if this was not one.
 *
 * Offered so a caller can answer "your source does not build" without importing
 * the bundler to find out — which would make every application depend on this
 * one's choice of it.
 */
export function compileDiagnostics(error: unknown): CompileDiagnostic[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;
  return errors.map((entry) => {
    const message = entry as { text?: unknown; location?: { line?: unknown; column?: unknown } };
    return {
      message: typeof message.text === 'string' ? message.text : 'Compilation failed',
      line: typeof message.location?.line === 'number' ? message.location.line : undefined,
      column: typeof message.location?.column === 'number' ? message.location.column : undefined,
    };
  });
}

/**
 * Compile one submitted artifact, for whichever application is serving.
 *
 * Nothing upstream compiles, so this sits outside the BFF catch-all and
 * authorizes at its own boundary — through the composed identity, since the local
 * edition has no session to look for.
 */
export async function handleCompileRequest(
  request: Request,
  identity: Pick<WebIdentity, 'authenticateRequest'>,
): Promise<Response> {
  const caller = await identity.authenticateRequest(request);
  if (caller.kind !== 'authorized') {
    const status = caller.kind === 'unavailable' ? 503 : caller.kind === 'refused' ? 403 : 401;
    return Response.json(
      {
        error:
          status === 503 ? 'ServiceUnavailable' : status === 403 ? 'Forbidden' : 'Unauthorized',
        message: 'reason' in caller ? caller.reason : 'Authentication required',
      },
      { status },
    );
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
    return Response.json(
      { error: `Request body exceeds ${MAX_SOURCE_BYTES} bytes` },
      { status: 413 },
    );
  }

  try {
    const bodyText = await readBodyWithinLimit(request);
    if (bodyText === null) {
      return Response.json(
        { error: `Request body exceeds ${MAX_SOURCE_BYTES} bytes` },
        { status: 413 },
      );
    }
    const body = JSON.parse(bodyText) as { source?: string; kind?: string };

    if (!body.source || typeof body.source !== 'string') {
      return Response.json({ error: 'source is required' }, { status: 400 });
    }

    if (Buffer.byteLength(body.source, 'utf8') > MAX_SOURCE_BYTES) {
      return Response.json({ error: `source exceeds ${MAX_SOURCE_BYTES} bytes` }, { status: 413 });
    }

    const kind = body.kind === 'html_js' ? 'html_js' : 'react_tsx';
    const { code, warnings } = await compile(body.source, kind);
    return Response.json({ html: generateHtml(code, kind), warnings });
  } catch (err) {
    // Which bundler produced the failure is not this caller's business.
    const diagnostics = compileDiagnostics(err);
    if (diagnostics !== null) {
      return Response.json({ error: 'Compilation failed', diagnostics }, { status: 422 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
