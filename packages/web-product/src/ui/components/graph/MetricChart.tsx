'use client';

/**
 * MetricChart — the shared trajectory chart for the Skill Designer's
 * Performance tab: a run-by-run line of a domain metric (leaderboard score,
 * overall eval score, …) against an optional target/reference line.
 *
 * It replaces the tiny inline Sparkline for the primary charts and fixes the
 * things a sparkline can't: readable y-axis values, a labeled target with a
 * shaded "good" region, a cursor-snapping tooltip (value + time + deltas), and
 * an outlier-robust y-domain so a single 0 or wild run can't crush the
 * run-to-run detail. When a target sits far outside the fitted range the chart
 * shows a "Fit runs / Target" toggle (default Fit) so the operator can trade
 * run-to-run legibility for absolute distance-to-goal on demand.
 */
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { FilterChips, Text } from '@aflow/design-system';

import { fmtMetric } from './metricFormat.js';

export interface MetricChartPoint {
  value: number;
  /** Whether this run met the target (drives point color). */
  met?: boolean | undefined;
  /** Short identity for the tooltip (e.g. a run-id prefix). */
  label?: string | undefined;
  /** Secondary tooltip line (e.g. a formatted timestamp). */
  sublabel?: string | undefined;
  /** A change that took effect at this run (e.g. a campaign config edit) —
   *  draws a vertical boundary before the point and adds a tooltip line. */
  marker?: { label: string; detail?: string };
}

type ScaleMode = 'fit' | 'target';

export interface MetricChartProps {
  points: MetricChartPoint[];
  /** Target / reference value — dashed line + shaded good-region. */
  target?: number | null | undefined;
  /** Upper bound of a `between` target (draws a second reference line). */
  targetHigh?: number | null | undefined;
  /** Which way is "better" — shades the good region + orients delta coloring. */
  direction?: 'maximize' | 'minimize' | null | undefined;
  /** Operator glyph shown on the target chip (e.g. `≥`). */
  targetOperator?: string | undefined;
  /** Metric name in the y-axis caption + tooltip. */
  metricLabel?: string | undefined;
  /** Names the dashed line when it is a baseline rather than a goal. Default `target`. */
  referenceLabel?: string | undefined;
  height?: number | undefined;
  /** Compact = no toggle, tighter margins, fewer ticks (inline trend). */
  compact?: boolean | undefined;
  formatValue?: ((v: number) => string) | undefined;
  /** X-axis label for a run index (0-based). Default `#${i + 1}`. */
  formatX?: ((index: number) => string) | undefined;
  ariaLabel?: string | undefined;
  style?: CSSProperties | undefined;
}

const COLORS = {
  line: 'var(--color-data-5)',
  met: 'var(--color-success-default)',
  goodRegion: 'var(--color-success-default)',
  reference: 'var(--color-text-muted)',
  grid: 'var(--color-border-subtle)',
  axisText: 'var(--color-text-muted)',
  marker: 'var(--color-data-2)',
} as const;

export function MetricChart(props: MetricChartProps) {
  const { points, height = 200 } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  if (points.length === 0) {
    return (
      <div
        ref={wrapRef}
        role="img"
        aria-label={props.ariaLabel ?? 'No data'}
        style={{
          width: '100%',
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface-0)',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--font-size-xs)',
          ...props.style,
        }}
      >
        no runs yet
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ width: '100%', ...props.style }}>
      <MetricChartInner {...props} width={width} height={height} />
    </div>
  );
}

function MetricChartInner(props: MetricChartProps & { width: number; height: number }) {
  const {
    points,
    width,
    height,
    target = null,
    targetHigh = null,
    direction = null,
    targetOperator,
    metricLabel,
    referenceLabel = 'target',
    compact = false,
    formatValue = fmtMetric,
    formatX = (i: number) => `#${String(i + 1)}`,
  } = props;

  const [scaleMode, setScaleMode] = useState<ScaleMode>('fit');
  const [hover, setHover] = useState<number | null>(null);

  const values = useMemo(() => points.map((p) => p.value), [points]);
  const hasTarget = typeof target === 'number';

  const { fit, tgt, domainsDiffer } = useMemo(() => {
    const latest = values[values.length - 1] ?? null;
    const targets = [target, targetHigh].filter((t): t is number => typeof t === 'number');
    const fitDomain = computeDomain(values, latest, 'fit', targets);
    const targetDomain = hasTarget ? computeDomain(values, latest, 'target', targets) : fitDomain;
    return {
      fit: fitDomain,
      tgt: targetDomain,
      domainsDiffer:
        Math.abs(fitDomain[0] - targetDomain[0]) > 1e-9 ||
        Math.abs(fitDomain[1] - targetDomain[1]) > 1e-9,
    };
  }, [values, target, targetHigh, hasTarget]);

  const showToggle = !compact && hasTarget && domainsDiffer;
  const [lo, hi] = scaleMode === 'target' && hasTarget ? tgt : fit;
  const span = Math.max(hi - lo, 1e-9);

  const mL = compact ? 40 : 54;
  const mR = compact ? 12 : 58;
  const mT = compact ? 10 : 16;
  const mB = compact ? 18 : 26;
  const plotW = Math.max(width - mL - mR, 10);
  const plotH = Math.max(height - mT - mB, 10);

  const n = points.length;
  const stepX = n <= 1 ? 0 : plotW / (n - 1);
  const xAt = (i: number) => mL + (n <= 1 ? plotW / 2 : i * stepX);
  const yAt = (v: number) => mT + (1 - (clamp(v, lo, hi) - lo) / span) * plotH;

  const yTicks = useMemo(() => axisTicks(lo, hi, compact ? 3 : 5), [lo, hi, compact]);

  const linePts = points.map((p, i) => `${String(xAt(i))},${yAt(p.value).toFixed(2)}`).join(' ');
  const areaPts = `${String(mL)},${String(mT + plotH)} ${linePts} ${String(mL + (n - 1) * stepX)},${String(mT + plotH)}`;

  const bestIdx = useMemo(() => bestIndex(values, direction), [values, direction]);
  const latestIdx = n - 1;

  const goodRegion =
    typeof target === 'number' && direction
      ? goodRegionRect(
          target,
          typeof targetHigh === 'number' ? targetHigh : null,
          direction,
          lo,
          hi,
        )
      : null;

  return (
    <div style={{ width, userSelect: 'none' }}>
      {showToggle && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <FilterChips
            options={[
              { value: 'fit', label: 'Fit runs' },
              { value: 'target', label: 'Target' },
            ]}
            value={scaleMode}
            onChange={(v) => {
              setScaleMode(v as ScaleMode);
            }}
          />
        </div>
      )}
      <div style={{ position: 'relative', width, height }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          role="img"
          aria-label={props.ariaLabel ?? defaultAria(metricLabel, values, target, referenceLabel)}
          style={{ display: 'block', overflow: 'visible' }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const rel = e.clientX - rect.left - mL;
            const idx = stepX === 0 ? 0 : Math.round(rel / stepX);
            setHover(clampInt(idx, 0, n - 1));
          }}
          onMouseLeave={() => {
            setHover(null);
          }}
        >
          {/* good region (values on the winning side of the target) */}
          {goodRegion && (
            <rect
              x={mL}
              y={yAt(goodRegion.top)}
              width={plotW}
              height={Math.max(yAt(goodRegion.bottom) - yAt(goodRegion.top), 0)}
              fill={COLORS.goodRegion}
              fillOpacity={0.07}
            />
          )}

          {/* y gridlines + labels */}
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={mL}
                x2={mL + plotW}
                y1={yAt(t)}
                y2={yAt(t)}
                stroke={COLORS.grid}
                strokeWidth={1}
                strokeOpacity={0.5}
              />
              <text
                x={mL - 6}
                y={yAt(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={compact ? 9 : 10}
                fill={COLORS.axisText}
              >
                {formatValue(t)}
              </text>
            </g>
          ))}

          {/* target reference line or, when off-axis in fit mode, an edge chip */}
          {typeof target === 'number' && target >= lo && target <= hi ? (
            <ReferenceLine
              x={mL}
              width={plotW}
              y={yAt(target)}
              label={`${targetOperator ? `${targetOperator} ` : `${referenceLabel} `}${formatValue(target)}`}
              compact={compact}
            />
          ) : typeof target === 'number' ? (
            <EdgeTargetChip
              x={mL + plotW}
              top={mT}
              bottom={mT + plotH}
              above={target > hi}
              text={`${referenceLabel} ${formatValue(target)}`}
              compact={compact}
            />
          ) : null}
          {typeof targetHigh === 'number' && targetHigh >= lo && targetHigh <= hi && (
            <ReferenceLine
              x={mL}
              width={plotW}
              y={yAt(targetHigh)}
              label={formatValue(targetHigh)}
              compact={compact}
            />
          )}

          {/* x labels (sparse: first, mid, last) */}
          {xLabelIndices(n, compact).map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={mT + plotH + (compact ? 12 : 16)}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize={compact ? 9 : 10}
              fill={COLORS.axisText}
            >
              {formatX(i)}
            </text>
          ))}

          {/* area + line */}
          <polygon points={areaPts} fill={COLORS.line} fillOpacity={0.1} />
          <polyline
            points={linePts}
            fill="none"
            stroke={COLORS.line}
            strokeWidth={compact ? 1.4 : 1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* config-change boundaries (drawn at the run they took effect on) */}
          {!compact &&
            points.map((p, i) =>
              p.marker ? (
                <ConfigMarker
                  key={`marker-${String(i)}`}
                  x={i <= 0 ? xAt(0) : (xAt(i - 1) + xAt(i)) / 2}
                  top={mT}
                  height={plotH}
                  label={p.marker.label}
                />
              ) : null,
            )}

          {/* crosshair for the hovered run */}
          {hover !== null && (
            <line
              x1={xAt(hover)}
              x2={xAt(hover)}
              y1={mT}
              y2={mT + plotH}
              stroke={COLORS.reference}
              strokeWidth={1}
              strokeDasharray="2 3"
              strokeOpacity={0.6}
            />
          )}

          {/* points */}
          {!compact &&
            points.map((p, i) => {
              const clamped = p.value < lo || p.value > hi;
              const isBest = i === bestIdx;
              const isLatest = i === latestIdx;
              const isHover = i === hover;
              const cx = xAt(i);
              const cy = yAt(p.value);
              const r = isHover ? 5 : isLatest ? 4 : 3;
              const fill = clamped
                ? 'var(--color-surface-0)'
                : p.met === true
                  ? COLORS.met
                  : COLORS.line;
              return (
                <g key={i} style={{ pointerEvents: 'none' }}>
                  {isBest && (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r + 3}
                      fill="none"
                      stroke={p.met === true ? COLORS.met : COLORS.line}
                      strokeWidth={1.2}
                      strokeOpacity={0.7}
                    />
                  )}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={fill}
                    stroke={clamped ? COLORS.line : 'var(--color-surface-0)'}
                    strokeWidth={1.2}
                  />
                  {clamped && (
                    <text
                      x={cx}
                      y={p.value > hi ? cy - r - 2 : cy + r + 8}
                      textAnchor="middle"
                      fontSize={9}
                      fill={COLORS.axisText}
                    >
                      {p.value > hi ? '▲' : '▼'}
                    </text>
                  )}
                </g>
              );
            })}
          {/* compact: only mark the latest point */}
          {compact && (
            <circle
              cx={xAt(latestIdx)}
              cy={yAt(values[latestIdx] ?? lo)}
              r={2.5}
              fill={COLORS.line}
            />
          )}
        </svg>

        {hover !== null && !compact && (
          <ChartTooltip
            point={points[hover]}
            index={hover}
            prevValue={hover > 0 ? points[hover - 1]?.value : undefined}
            target={target}
            direction={direction}
            metricLabel={metricLabel}
            formatValue={formatValue}
            formatX={formatX}
            x={xAt(hover)}
            y={yAt(clamp(points[hover]?.value ?? lo, lo, hi))}
            chartWidth={width}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReferenceLine({
  x,
  width,
  y,
  label,
  compact,
}: {
  x: number;
  width: number;
  y: number;
  label: string;
  compact: boolean;
}) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      <line
        x1={x}
        x2={x + width}
        y1={y}
        y2={y}
        stroke={COLORS.reference}
        strokeWidth={1}
        strokeDasharray="4 3"
        strokeOpacity={0.8}
      />
      <text
        x={x + width + 4}
        y={y}
        dominantBaseline="middle"
        fontSize={compact ? 9 : 10}
        fontWeight={600}
        fill={COLORS.axisText}
      >
        {label}
      </text>
    </g>
  );
}

function EdgeTargetChip({
  x,
  top,
  bottom,
  above,
  text,
  compact,
}: {
  x: number;
  top: number;
  bottom: number;
  above: boolean;
  text: string;
  compact: boolean;
}) {
  const y = above ? top + 8 : bottom - 8;
  return (
    <text
      x={x + 4}
      y={y}
      dominantBaseline="middle"
      fontSize={compact ? 9 : 10}
      fontWeight={600}
      fill={COLORS.axisText}
      style={{ pointerEvents: 'none' }}
    >
      {above ? '↑ ' : '↓ '}
      {text}
    </text>
  );
}

/** Vertical boundary at a run where something changed (e.g. campaign config),
 *  with a short label flag at the top. Detail rides that run's tooltip. */
function ConfigMarker({
  x,
  top,
  height,
  label,
}: {
  x: number;
  top: number;
  height: number;
  label: string;
}) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      <line
        x1={x}
        x2={x}
        y1={top}
        y2={top + height}
        stroke={COLORS.marker}
        strokeWidth={1}
        strokeDasharray="3 2"
        strokeOpacity={0.75}
      />
      <text
        x={x}
        y={top - 3}
        textAnchor="middle"
        fontSize={9}
        fontWeight={600}
        fill={COLORS.marker}
      >
        {label}
      </text>
    </g>
  );
}

function ChartTooltip({
  point,
  index,
  prevValue,
  target,
  direction,
  metricLabel,
  formatValue,
  formatX,
  x,
  y,
  chartWidth,
}: {
  point: MetricChartPoint | undefined;
  index: number;
  prevValue: number | undefined;
  target: number | null;
  direction: 'maximize' | 'minimize' | null;
  metricLabel: string | undefined;
  formatValue: (v: number) => string;
  formatX: (i: number) => string;
  x: number;
  y: number;
  chartWidth: number;
}) {
  if (!point) return null;
  const isImprovement = (delta: number): boolean =>
    direction === 'minimize' ? delta < 0 : delta > 0;

  const deltaPrev = prevValue !== undefined ? point.value - prevValue : null;
  const deltaTarget = target !== null ? point.value - target : null;

  // Position above the point, flipping below when near the top; clamp to canvas.
  const flip = y < 88;
  const left = clamp(x, 70, chartWidth - 70);
  const top = flip ? y + 12 : y - 12;

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        transform: `translate(-50%, ${flip ? '0' : '-100%'})`,
        pointerEvents: 'none',
        zIndex: 3,
        minWidth: 128,
        padding: 'var(--space-2) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-3)',
        border: '1px solid var(--color-border-subtle)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Text size="xs" variant="muted">
          {point.label ?? formatX(index)}
        </Text>
        {point.met !== undefined && (
          <Text size="xs" weight="semibold" style={{ color: point.met ? COLORS.met : undefined }}>
            {point.met ? 'met' : 'below'}
          </Text>
        )}
      </div>
      <Text size="sm" weight="semibold">
        {metricLabel ? `${metricLabel} ` : ''}
        {formatValue(point.value)}
      </Text>
      {point.sublabel && (
        <div>
          <Text size="xs" variant="muted">
            {point.sublabel}
          </Text>
        </div>
      )}
      {(deltaPrev !== null || deltaTarget !== null) && (
        <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
          {deltaPrev !== null && (
            <DeltaChip
              label="prev"
              delta={deltaPrev}
              good={isImprovement(deltaPrev)}
              format={formatValue}
            />
          )}
          {deltaTarget !== null && (
            <DeltaChip
              label="target"
              delta={deltaTarget}
              good={isImprovement(deltaTarget)}
              format={formatValue}
            />
          )}
        </div>
      )}
      {point.marker && (
        <div
          style={{
            marginTop: 4,
            paddingTop: 4,
            borderTop: '1px solid var(--color-border-subtle)',
          }}
        >
          <Text size="xs" style={{ color: COLORS.marker }}>
            {point.marker.label}
          </Text>
          {point.marker.detail && (
            <div>
              <Text size="xs" variant="muted">
                {point.marker.detail}
              </Text>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeltaChip({
  label,
  delta,
  good,
  format,
}: {
  label: string;
  delta: number;
  good: boolean;
  format: (v: number) => string;
}) {
  const color =
    delta === 0
      ? 'var(--color-text-muted)'
      : good
        ? 'var(--color-success-text)'
        : 'var(--color-danger-text)';
  return (
    <Text size="xs" style={{ color }}>
      {label} {fmtSignedMetricWith(delta, format)}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Pure scale/layout helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(v, lo, hi));
}

function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0] ?? 0;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const h = idx - lo;
  return (sorted[lo] ?? 0) * (1 - h) + (sorted[hi] ?? 0) * h;
}

/**
 * The plotted y-domain. `target` mode spans every value + the target(s).
 * `fit` mode is outlier-robust: it drops points outside the 1.5·IQR fence so a
 * single 0 / wild run can't crush the run-to-run detail, but always keeps the
 * latest point in view. Both modes pad ~8% so nothing hugs the canvas edge.
 */
function computeDomain(
  values: number[],
  latest: number | null,
  mode: ScaleMode,
  targets: number[],
): [number, number] {
  if (values.length === 0) return [0, 1];
  if (mode === 'target') {
    const all = [...values, ...targets];
    return padRange(Math.min(...all), Math.max(...all));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const q25 = quantile(sorted, 0.25);
  const q75 = quantile(sorted, 0.75);
  const iqr = q75 - q25;
  const fenceLo = q25 - 1.5 * iqr;
  const fenceHi = q75 + 1.5 * iqr;
  const inFence = values.filter((v) => v >= fenceLo && v <= fenceHi);
  const base = inFence.length > 0 ? inFence : values;
  let lo = Math.min(...base);
  let hi = Math.max(...base);
  if (latest !== null) {
    lo = Math.min(lo, latest);
    hi = Math.max(hi, latest);
  }
  return padRange(lo, hi);
}

function padRange(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  const span = hi - lo;
  const pad = span > 0 ? span * 0.08 : Math.max(Math.abs(hi) * 0.05, 0.01);
  return [lo - pad, hi + pad];
}

/** Evenly spaced tick values across the domain. */
function axisTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const step = (hi - lo) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(lo + step * i);
  return out;
}

function bestIndex(values: number[], direction: 'maximize' | 'minimize' | null): number | null {
  if (values.length === 0 || direction === null) return null;
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    const a = values[i] ?? 0;
    const b = values[best] ?? 0;
    if (direction === 'minimize' ? a < b : a > b) best = i;
  }
  return best;
}

function goodRegionRect(
  target: number,
  targetHigh: number | null,
  direction: 'maximize' | 'minimize',
  lo: number,
  hi: number,
): { top: number; bottom: number } | null {
  // Between → the band [target, targetHigh]; otherwise the half-plane on the
  // winning side of the target, clipped to the visible domain.
  if (targetHigh !== null) return { top: Math.min(targetHigh, hi), bottom: Math.max(target, lo) };
  if (direction === 'maximize') return { top: hi, bottom: Math.max(target, lo) };
  return { top: Math.min(target, hi), bottom: lo };
}

function xLabelIndices(n: number, compact: boolean): number[] {
  if (n <= 1) return [0];
  if (compact || n === 2) return [0, n - 1];
  return [0, Math.floor((n - 1) / 2), n - 1];
}

function fmtSignedMetricWith(delta: number, format: (v: number) => string): string {
  if (delta === 0) return '±0';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${format(Math.abs(delta))}`;
}

function defaultAria(
  metricLabel: string | undefined,
  values: number[],
  target: number | null,
  referenceLabel: string,
): string {
  const latest = values[values.length - 1];
  const metric = metricLabel ?? 'metric';
  const tgt = target !== null ? `, ${referenceLabel} ${fmtMetric(target)}` : '';
  return `${metric} over ${String(values.length)} runs${tgt}, latest ${latest !== undefined ? fmtMetric(latest) : 'n/a'}`;
}
