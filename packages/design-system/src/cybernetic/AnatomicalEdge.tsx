/**
 * AnatomicalEdge — Animatable SVG path between Map nodes (DL-9, DL-15).
 *
 * Renders a Bezier curve between two node positions. Edges are always drawn
 * (soft when idle) and animate with a flow-dot overlay when data flows.
 * The flow-dot animation is handled by MapCanvasLayer; this component
 * only renders the structural SVG path.
 *
 * @example
 * ```tsx
 * <AnatomicalEdge
 *   from={{ cx: 400, cy: 200 }}
 *   to={{ cx: 400, cy: 350 }}
 *   color="var(--color-cybernetic-helmsman)"
 *   active
 * />
 * ```
 */
import type { NodePosition } from './hooks/useMapLayout.js';

export interface AnatomicalEdgeProps {
  /** Source node position. */
  from: Pick<NodePosition, 'cx' | 'cy'>;
  /** Destination node position. */
  to: Pick<NodePosition, 'cx' | 'cy'>;
  /** Edge color. */
  color?: string;
  /** Whether data is flowing (brighter, thicker). */
  active?: boolean;
  /** Edge label (optional). */
  label?: string;
  className?: string;
}

export function AnatomicalEdge({
  from,
  to,
  color = 'var(--color-cybernetic-ink-muted)',
  active,
  label,
  className,
}: AnatomicalEdgeProps) {
  // Compute Bezier control points for a smooth curve
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const cp1x = from.cx + dx * 0.3;
  const cp1y = from.cy + dy * 0.05;
  const cp2x = from.cx + dx * 0.7;
  const cp2y = to.cy - dy * 0.05;

  const d = `M ${from.cx} ${from.cy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.cx} ${to.cy}`;

  const midX = (from.cx + to.cx) / 2;
  const midY = (from.cy + to.cy) / 2;

  return (
    <g className={className}>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={active ? 1.5 : 0.8}
        strokeOpacity={active ? 0.6 : 0.15}
        strokeDasharray={active ? 'none' : '4 4'}
      />
      {label && (
        <text
          x={midX}
          y={midY - 6}
          textAnchor="middle"
          fill="var(--color-cybernetic-ink-muted)"
          fontSize={8}
          fontFamily="var(--font-family-system)"
          opacity={0.5}
        >
          {label}
        </text>
      )}
    </g>
  );
}
