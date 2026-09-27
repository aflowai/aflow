/**
 * AnatomicalNode — Typed node primitive for the Entity Map (DL-7, DL-8, DL-10).
 *
 * Renders a single anatomical node in the SVG layer with:
 * - Fixed slot kind (helmsman, runner, coach, memory, etc.)
 * - Three states: idle (dim), active (bright pulse), stuck (amber alert)
 * - Kind-specific glyph icon
 * - Optional count badge
 * - Keyboard-navigable, click/right-click handlers
 *
 * @example
 * ```tsx
 * <AnatomicalNode
 *   kind="helmsman"
 *   state="active"
 *   label="Helmsman"
 *   summary="Attending to pricing-approval"
 *   onClick={() => openPeek('helmsman')}
 * />
 * ```
 */
import type { CSSProperties, MouseEvent, KeyboardEvent } from 'react';
import type { MapNodeKind, MapNodeState } from '@aflow/schemas';

export interface AnatomicalNodeProps {
  /** Which anatomical part this node represents. */
  kind: MapNodeKind;
  /** Current visual state. */
  state: MapNodeState;
  /** Display label. */
  label: string;
  /** Optional count badge (inbox items, staged changes, skills). */
  count?: number;
  /** Summary for tooltip. */
  summary?: string;
  /** Click handler (opens peek panel). */
  onClick?: () => void;
  /** Right-click handler (context menu / filter log). */
  onContextMenu?: (e: MouseEvent) => void;
  /** Whether this node is currently highlighted (e.g., from narration click). */
  highlighted?: boolean;
  /** Position in SVG coordinate space. */
  x: number;
  y: number;
  /** Node dimensions. */
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Accent color per node kind (§8.1).
 * Raw hex values used because CSS custom properties don't work in SVG
 * fill/stroke attributes across all browsers.
 */
const KIND_COLORS: Record<MapNodeKind, string> = {
  helmsman: '#5AE3FF',
  runner: '#48C9B0',
  coach: '#B080FF',
  memory: '#E9B872',
  skills: '#7FE3A8',
  evals: '#FF6B6B',
  stagedChanges: '#FFC857',
  triggers: '#8E93A8',
};

/** Kind-specific glyph labels (placeholder — replace with icons in Figma pass). */
const KIND_GLYPHS: Record<MapNodeKind, string> = {
  helmsman: '\u2B22', // hexagon
  runner: '\u25A0', // square
  coach: '\u25C6', // diamond
  memory: '\u25CF', // circle
  skills: '\u2605', // star
  evals: '\u25B2', // triangle
  stagedChanges: '\u25CB', // open circle
  triggers: '\u25BA', // right pointer
};

/** Opacity by state (DL-10). Idle is dimmed but readable (DL-8: empty = teaching state). */
const STATE_OPACITY: Record<MapNodeState, number> = {
  idle: 0.75,
  active: 1,
  stuck: 0.95,
};

export function AnatomicalNode({
  kind,
  state,
  label,
  count,
  summary,
  onClick,
  onContextMenu,
  highlighted,
  x,
  y,
  width: w = 120,
  height: h = 64,
  className,
}: AnatomicalNodeProps) {
  const color = KIND_COLORS[kind];
  const glyph = KIND_GLYPHS[kind];
  const opacity = STATE_OPACITY[state];
  const isStuck = state === 'stuck';

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  const borderColor = isStuck ? 'var(--color-cybernetic-attention)' : color;
  const borderWidth = highlighted ? 2 : 1;

  const containerStyle: CSSProperties = {
    cursor: onClick ? 'pointer' : 'default',
    outline: 'none',
  };

  return (
    <g
      transform={`translate(${x - w / 2}, ${y - h / 2})`}
      opacity={highlighted ? 1 : opacity}
      className={className}
      style={containerStyle}
      tabIndex={0}
      role="button"
      aria-label={`${label}${summary ? ` ��� ${summary}` : ''}${count != null ? ` (${count})` : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={handleKeyDown}
    >
      {/* Background rect */}
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        rx={8}
        ry={8}
        fill="#121A30"
        stroke={borderColor}
        strokeWidth={borderWidth}
        strokeOpacity={0.6}
      />

      {/* Stuck alert glow */}
      {isStuck && (
        <rect
          x={-2}
          y={-2}
          width={w + 4}
          height={h + 4}
          rx={10}
          ry={10}
          fill="none"
          stroke="var(--color-cybernetic-attention)"
          strokeWidth={2}
          opacity={0.4}
        />
      )}

      {/* Kind glyph */}
      <text
        x={16}
        y={h / 2 + 1}
        dominantBaseline="central"
        textAnchor="middle"
        fill={color}
        fontSize={16}
        fontFamily="var(--font-family-sans)"
      >
        {glyph}
      </text>

      {/* Label */}
      <text
        x={32}
        y={h / 2 - 6}
        dominantBaseline="central"
        fill="#EAE7DC"
        fontSize={12}
        fontFamily="var(--font-family-sans)"
        fontWeight={500}
      >
        {label}
      </text>

      {/* State indicator text */}
      <text
        x={32}
        y={h / 2 + 10}
        dominantBaseline="central"
        fill="#8E93A8"
        fontSize={9}
        fontFamily="var(--font-family-system)"
      >
        {state}
      </text>

      {/* Count badge */}
      {count != null && count > 0 && (
        <g transform={`translate(${w - 20}, 8)`}>
          <rect x={0} y={0} width={18} height={16} rx={8} fill={color} opacity={0.2} />
          <text
            x={9}
            y={8}
            dominantBaseline="central"
            textAnchor="middle"
            fill={color}
            fontSize={10}
            fontWeight={600}
            fontFamily="var(--font-family-system)"
          >
            {count > 99 ? '99+' : count}
          </text>
        </g>
      )}

      {/* Highlight ring (from narration line click) */}
      {highlighted && (
        <rect
          x={-3}
          y={-3}
          width={w + 6}
          height={h + 6}
          rx={11}
          ry={11}
          fill="none"
          stroke={color}
          strokeWidth={2}
          opacity={0.6}
        >
          <animate attributeName="opacity" values="0.6;0.2;0.6" dur="1.5s" repeatCount="3" />
        </rect>
      )}

      {/* Tooltip via SVG title */}
      {summary && <title>{`${label}: ${summary}`}</title>}
    </g>
  );
}
