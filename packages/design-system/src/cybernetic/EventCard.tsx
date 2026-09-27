'use client';

/**
 * EventCard — Progressive disclosure card for entity events (DL-1).
 *
 * Four depth levels:
 * - Level 0 (Pulse): not rendered as a card (just a node highlight)
 * - Level 1 (Card): label + metric + outcome + breadcrumb
 * - Level 2 (Inline expand): key fields, rationale, diff preview
 * - Level 3 (Peek panel): full content fetched by PayloadRef
 *
 * This component renders Levels 1-2. Level 3 is handled by PeekPanel.
 *
 * @example
 * ```tsx
 * <EventCard
 *   label="Worker completed: fetch-comps"
 *   metric="12.4s"
 *   outcome="success"
 *   breadcrumb="pricing-approval > fetch-comps"
 *   nodeKind="runner"
 *   expanded={false}
 *   onToggleExpand={() => setExpanded(!expanded)}
 * />
 * ```
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { MapNodeKind } from '@aflow/schemas';
import { RegisterText } from './RegisterText.js';

export interface EventCardProps {
  /** One-line label (Level 1). */
  label: string;
  /** Optional metric value. */
  metric?: string;
  /** Optional outcome indicator. */
  outcome?: string;
  /** Breadcrumb path for context. */
  breadcrumb?: string;
  /** Which Map node this event originates from. */
  nodeKind: MapNodeKind;
  /** Timestamp (epoch ms). */
  timestamp?: number;
  /** Whether Level 2 detail is expanded. */
  expanded?: boolean;
  /** Toggle expand handler. */
  onToggleExpand?: () => void;
  /** Click handler (e.g., highlight map node). */
  onClick?: () => void;
  /** Level 2 content (shown when expanded). */
  expandedContent?: ReactNode;
  /** Level 3 action (open peek panel). */
  onOpenPeek?: () => void;
  className?: string;
  style?: CSSProperties;
}

/** Accent color per node kind (mirrors AnatomicalNode). */
const KIND_COLORS: Record<MapNodeKind, string> = {
  helmsman: 'var(--color-cybernetic-helmsman)',
  runner: 'var(--color-cybernetic-runner)',
  coach: 'var(--color-cybernetic-coach)',
  memory: 'var(--color-cybernetic-memory)',
  skills: 'var(--color-cybernetic-acquired)',
  evals: 'var(--color-cybernetic-regression)',
  stagedChanges: 'var(--color-cybernetic-attention)',
  triggers: 'var(--color-cybernetic-ink-muted)',
};

const OUTCOME_COLORS: Record<string, string> = {
  success: 'var(--color-cybernetic-acquired)',
  failure: 'var(--color-cybernetic-regression)',
  regression: 'var(--color-cybernetic-regression)',
  partial: 'var(--color-cybernetic-attention)',
};

export function EventCard({
  label,
  metric,
  outcome,
  breadcrumb,
  nodeKind,
  timestamp,
  expanded,
  onToggleExpand,
  onClick,
  expandedContent,
  onOpenPeek,
  className,
  style,
}: EventCardProps) {
  const [hovered, setHovered] = useState(false);
  const accentColor = KIND_COLORS[nodeKind];
  const outcomeColor = outcome
    ? (OUTCOME_COLORS[outcome] ?? 'var(--color-cybernetic-ink-muted)')
    : undefined;

  const cardStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    padding: 'var(--space-2) var(--space-3)',
    background: hovered ? 'var(--color-cybernetic-overlay)' : 'var(--color-cybernetic-raised)',
    borderLeft: `2px solid ${accentColor}`,
    borderRadius: 'var(--radius-sm)',
    cursor: onClick ? 'pointer' : 'default',
    transition: 'background var(--transition-duration-fast)',
    ...style,
  };

  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : undefined;

  return (
    <div
      className={className}
      style={cardStyle}
      onClick={onClick}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      role="article"
      aria-label={label}
    >
      {/* Level 1: Summary line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {/* Node kind indicator dot */}
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: accentColor,
            flexShrink: 0,
          }}
        />

        {/* Label */}
        <RegisterText register="ui" size="sm" style={{ flex: 1 }} truncate>
          {label}
        </RegisterText>

        {/* Metric */}
        {metric && (
          <RegisterText register="system" size="xs" color="var(--color-cybernetic-ink-muted)">
            {metric}
          </RegisterText>
        )}

        {/* Outcome badge */}
        {outcome && (
          <span
            style={{
              fontSize: 'var(--font-size-xs)',
              fontFamily: 'var(--font-family-system)',
              color: outcomeColor,
              padding: '0 var(--space-1)',
              borderRadius: 'var(--radius-sm)',
              background: outcomeColor ? `${outcomeColor}15` : undefined,
            }}
          >
            {outcome}
          </span>
        )}

        {/* Timestamp */}
        {timeStr && (
          <RegisterText register="system" size="xs" color="var(--color-cybernetic-ink-muted)">
            {timeStr}
          </RegisterText>
        )}
      </div>

      {/* Breadcrumb */}
      {breadcrumb && (
        <RegisterText
          register="system"
          size="xs"
          color="var(--color-cybernetic-ink-muted)"
          style={{ paddingLeft: 'var(--space-3)' }}
          truncate
        >
          {breadcrumb}
        </RegisterText>
      )}

      {/* Level 2: Expanded content */}
      {expanded && expandedContent && (
        <div style={{ paddingLeft: 'var(--space-3)', paddingTop: 'var(--space-1)' }}>
          {expandedContent}
        </div>
      )}

      {/* Expand/Peek actions */}
      {(onToggleExpand || onOpenPeek) && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            paddingLeft: 'var(--space-3)',
            paddingTop: 'var(--space-0-5)',
          }}
        >
          {onToggleExpand && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-cybernetic-ink-muted)',
                fontSize: 'var(--font-size-xs)',
                fontFamily: 'var(--font-family-sans)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {expanded ? 'collapse' : 'expand'}
            </button>
          )}
          {onOpenPeek && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenPeek();
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-cybernetic-ink-muted)',
                fontSize: 'var(--font-size-xs)',
                fontFamily: 'var(--font-family-sans)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              peek
            </button>
          )}
        </div>
      )}
    </div>
  );
}
