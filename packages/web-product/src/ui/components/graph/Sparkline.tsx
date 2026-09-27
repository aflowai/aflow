'use client';

import { type CSSProperties, useEffect, useRef, useState } from 'react';

interface SparklineProps {
  values: number[];
  /** SVG width in px. */
  width?: number | undefined;
  /** SVG height in px. */
  height?: number | undefined;
  /** Stroke + last-point fill. Defaults to currentColor. */
  color?: string | undefined;
  /** Optional baseline drawn as a dashed horizontal line (same units as values). */
  baseline?: number | null | undefined;
  /** Override y-axis range. Defaults to [0, 1] which suits eval scores. */
  domain?: [number, number] | undefined;
  style?: CSSProperties | undefined;
  /** Accessible label (sr-only). */
  ariaLabel?: string | undefined;
  /** When false, omit the last-value anchor dot (tighter inline layout). Default true. */
  showLastPoint?: boolean | undefined;
  /** When true, draw a dot at every data point (each with a hover tooltip). */
  showPoints?: boolean | undefined;
  /** Per-point hover labels (native SVG `<title>`); falls back to the value. */
  pointLabels?: string[] | undefined;
}

export function Sparkline({
  values,
  width = 96,
  height = 24,
  color = 'currentColor',
  baseline = null,
  domain = [0, 1],
  style,
  ariaLabel,
  showLastPoint = true,
  showPoints = false,
  pointLabels,
}: SparklineProps) {
  if (values.length === 0) {
    return (
      <div
        role="img"
        aria-label={ariaLabel ?? 'No data'}
        style={{
          width,
          height,
          display: 'inline-block',
          color: 'var(--color-text-muted)',
          fontSize: 10,
          lineHeight: `${String(height)}px`,
          textAlign: 'center',
          ...style,
        }}
      >
        no data
      </div>
    );
  }

  const [min, max] = domain;
  const span = Math.max(max - min, 1e-9);
  const stepX = values.length === 1 ? 0 : width / (values.length - 1);
  // SVG y grows downward; invert so high scores = top of the canvas.
  const toY = (v: number) => height - ((v - min) / span) * height;

  const points = values.map((v, i) => `${String(i * stepX)},${toY(v).toFixed(2)}`).join(' ');

  // Build a filled area underneath the line for visual mass on tiny canvases.
  const areaPoints = `0,${String(height)} ${points} ${String((values.length - 1) * stepX)},${String(height)}`;

  const last = values[values.length - 1];
  const lastY = last !== undefined ? toY(last) : 0;
  const lastX = (values.length - 1) * stepX;

  const baselineY = baseline !== null && baseline !== undefined ? toY(baseline) : null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="img"
      aria-label={
        ariaLabel ?? `Trend of ${String(values.length)} values, latest ${last?.toFixed(2) ?? 'n/a'}`
      }
      style={{ display: 'inline-block', overflow: 'visible', ...style }}
    >
      <polygon points={areaPoints} fill={color} fillOpacity={0.12} />
      {baselineY !== null && (
        <line
          x1={0}
          x2={width}
          y1={baselineY}
          y2={baselineY}
          stroke="var(--color-text-muted)"
          strokeOpacity={0.6}
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showPoints
        ? values.map((v, i) => (
            <circle
              key={i}
              cx={i * stepX}
              cy={toY(v)}
              r={2.5}
              fill={color}
              stroke="var(--color-surface-0)"
              strokeWidth={1}
              style={{ cursor: 'default' }}
            >
              <title>{pointLabels?.[i] ?? v.toFixed(2)}</title>
            </circle>
          ))
        : showLastPoint &&
          last !== undefined && <circle cx={lastX} cy={lastY} r={2} fill={color} />}
    </svg>
  );
}

/**
 * Width-filling Sparkline. Measures its container and renders the SVG at the
 * real pixel width so the line stretches to fill the row while data-point
 * dots stay round (no aspect distortion). Use when the chart owns a row;
 * keep the fixed-width `Sparkline` for inline/table contexts.
 */
export function ResponsiveSparkline({
  minWidth = 160,
  maxWidth,
  ...props
}: Omit<SparklineProps, 'width'> & { minWidth?: number; maxWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setMeasured(w);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  const width = Math.max(measured ?? maxWidth ?? 480, minWidth);

  return (
    <div ref={ref} style={{ width: '100%', maxWidth }}>
      <Sparkline {...props} width={width} style={{ ...props.style, display: 'block' }} />
    </div>
  );
}
