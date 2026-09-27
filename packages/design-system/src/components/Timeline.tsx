import type { ReactNode, HTMLAttributes, CSSProperties } from 'react';
import { AnimatedHeight } from './AnimatedHeight.js';

// =============================================================================
// Timeline
// =============================================================================

export interface TimelineProps extends HTMLAttributes<HTMLDivElement> {
  /** Timeline items */
  children?: ReactNode;
  /**
   * Fraction (0–1) of the run that has reached a terminal/started state.
   * Drives the connector "fill" — the spine paints from the top down to
   * this fraction in the progress color, with a glowing leading edge. When
   * omitted the spine renders as the neutral track only.
   */
  progress?: number;
  /**
   * When true, the filled portion of the spine animates a downward
   * "energy" sweep to signal the run is live. Pair with `progress`.
   */
  active?: boolean;
  /**
   * Color tone of the progress fill / connector spine. `'success'`
   * (default) paints it green; `'failed'` flips it to the failure color
   * so a run that didn't succeed doesn't show a green spine.
   */
  tone?: 'success' | 'failed';
}

export function Timeline({
  children,
  className = '',
  progress,
  active = false,
  tone = 'success',
  style,
  ...props
}: TimelineProps) {
  const hasProgress = typeof progress === 'number';
  const clamped = hasProgress ? Math.min(1, Math.max(0, progress)) : 0;
  const rootClass = [
    'ds-timeline',
    hasProgress ? 'ds-timeline--metered' : '',
    active ? 'ds-timeline--active' : '',
    tone === 'failed' ? 'ds-timeline--tone-failed' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const mergedStyle = hasProgress
    ? ({ ...style, ['--ds-timeline-progress' as string]: String(clamped) } as CSSProperties)
    : style;
  return (
    <div className={rootClass} style={mergedStyle} {...props}>
      {hasProgress && <span className="ds-timeline__fill" aria-hidden="true" />}
      {children}
    </div>
  );
}

// =============================================================================
// TimelineItem
// =============================================================================

export type TimelineItemStatus = 'default' | 'running' | 'succeeded' | 'failed' | 'paused';

export interface TimelineItemProps extends HTMLAttributes<HTMLDivElement> {
  /** Item title */
  title: string;
  /** Timestamp or time description */
  time?: string;
  /** Status for marker styling */
  status?: TimelineItemStatus;
  /** Additional content */
  children?: ReactNode;
  /** Marker icon (overrides default status marker) */
  markerIcon?: ReactNode;
  /**
   * Small leading glyph rendered before the title — used to convey the
   * *kind* of work (e.g. an operation icon) independently of the status
   * marker, which conveys lifecycle.
   */
  titleIcon?: ReactNode;
  /**
   * Where `time` renders. `'below'` (default) stacks it under the title;
   * `'end'` right-aligns it on the title row, freeing the body for sublines
   * (and reserving room for any absolute top-right affordance). Opt-in so
   * existing consumers keep the stacked layout.
   */
  timeAlign?: 'below' | 'end';
}

export function TimelineItem({
  title,
  time,
  status = 'default',
  children,
  markerIcon,
  titleIcon,
  timeAlign = 'below',
  className = '',
  ...props
}: TimelineItemProps) {
  const rowClass =
    status !== 'default'
      ? `ds-timeline-item ds-timeline-item--${status} ${className}`.trim()
      : `ds-timeline-item ${className}`.trim();
  const markerClass =
    status !== 'default'
      ? `ds-timeline-item__marker ds-timeline-item__marker--${status}`
      : 'ds-timeline-item__marker';

  return (
    <div className={rowClass} {...props}>
      <div className={markerClass}>{markerIcon ?? <DefaultMarkerIcon status={status} />}</div>
      <div className="ds-timeline-item__content">
        <div className="ds-timeline-item__title">
          {titleIcon && (
            <span className="ds-timeline-item__title-icon" aria-hidden="true">
              {titleIcon}
            </span>
          )}
          <span className="ds-timeline-item__title-text">{title}</span>
          {timeAlign === 'end' && time && (
            <span className="ds-timeline-item__time ds-timeline-item__time--end">{time}</span>
          )}
        </div>
        {/* Always-mounted height animator: when the body mounts/unmounts
            (e.g. a live subline appearing on `running`, a summary landing on
            terminal) the row grows/shrinks gradually instead of snapping. */}
        <AnimatedHeight>
          {((timeAlign === 'below' && time) || children) && (
            // Body holds the sublines (and, in `below` mode, the time). When a
            // `titleIcon` is present it gets indented so these align under the
            // title TEXT, not under the inline icon (otherwise the sublines
            // stagger left of the title and read as misaligned).
            <div
              className={`ds-timeline-item__body${
                titleIcon ? ' ds-timeline-item__body--indented' : ''
              }`}
            >
              {timeAlign === 'below' && time && (
                <div className="ds-timeline-item__time">{time}</div>
              )}
              {children}
            </div>
          )}
        </AnimatedHeight>
      </div>
    </div>
  );
}

function DefaultMarkerIcon({ status }: { status: TimelineItemStatus }) {
  const size = 12;

  if (status === 'running') {
    // Indeterminate progress arc — a rotating ~100° stroke reads as
    // "actively working" far more than a pulsing dot. Under
    // prefers-reduced-motion the global reset stops the spin and it
    // settles as a static partial ring.
    return (
      <svg
        className="ds-marker-arc"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.18" />
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="10 28"
        />
      </svg>
    );
  }

  if (status === 'succeeded') {
    // Draw-on check: stroke-dashoffset animates full→0 so the mark draws
    // itself on completion. Resting (and reduced-motion) state is fully
    // drawn via animation-fill-mode: forwards on the final keyframe.
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path className="ds-marker-draw" d="M2 5l2 2 4-4" />
      </svg>
    );
  }

  if (status === 'failed') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path className="ds-marker-draw" d="M2 2l6 6M8 2l-6 6" />
      </svg>
    );
  }

  if (status === 'paused') {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
        <rect x="2.5" y="2" width="1.8" height="6" rx="0.6" />
        <rect x="5.7" y="2" width="1.8" height="6" rx="0.6" />
      </svg>
    );
  }

  // Default dot (scheduled / not-yet-started)
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="5" r="2" />
    </svg>
  );
}
