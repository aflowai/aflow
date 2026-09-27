import type { ReactNode } from 'react';
import { Badge, type BadgeVariant } from '../primitives/Badge.js';
import { Icon } from '../icons/Icon.js';

/**
 * Canonical display for a workflow *run* status (lowercase, as stored on
 * `workflow_runs.status` and surfaced by the run-view). One source of truth —
 * replaces the per-call maps in the Runs tab and the run surface.
 */
export type WorkflowRunStatus =
  'running' | 'in_flight' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'skipped';

const VARIANT: Record<string, BadgeVariant> = {
  running: 'running',
  in_flight: 'running',
  paused: 'paused',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'neutral',
};

const LABEL: Record<string, string> = {
  running: 'Running',
  in_flight: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** Match on substrings so run/task-level variants (e.g. `task_paused`,
 *  `in_progress`) map without an exhaustive table. */
export function workflowRunStatusVariant(status: string): BadgeVariant {
  const s = status.toLowerCase();
  if (VARIANT[s]) return VARIANT[s];
  if (s.includes('pause')) return 'paused';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('fail') || s.includes('error')) return 'failed';
  if (s.includes('complet') || s.includes('succeed') || s.includes('done')) return 'succeeded';
  if (s.includes('run') || s.includes('progress') || s.includes('flight')) return 'running';
  return 'neutral';
}

export function workflowRunStatusLabel(status: string): string {
  const s = status.toLowerCase();
  if (LABEL[s]) return LABEL[s];
  if (s.includes('pause')) return 'Paused';
  // Normalize a raw enum ("task_paused") into a readable title.
  return status.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface WorkflowRunStatusBadgeProps {
  status: string;
  /** Show the leading status dot (pulses while running). Default true. */
  showDot?: boolean;
  /**
   * Render just the status glyph (colored chip + tooltip), no label — for
   * dense lists. Stays a non-interactive badge so it reads as *status*, not a
   * control (running is a pulsing dot, not a play button).
   */
  iconOnly?: boolean;
}

export function WorkflowRunStatusBadge({
  status,
  showDot = true,
  iconOnly = false,
}: WorkflowRunStatusBadgeProps) {
  const variant = workflowRunStatusVariant(status);
  const label = workflowRunStatusLabel(status);

  if (iconOnly) {
    return <Badge variant={variant} icon={statusGlyph(variant)} title={label} aria-label={label} />;
  }

  return (
    <Badge variant={variant} icon={showDot ? <RunDot live={variant === 'running'} /> : undefined}>
      {label}
    </Badge>
  );
}

/** Glyph per state — a pulsing dot for live, a static mark otherwise. */
function statusGlyph(variant: BadgeVariant): ReactNode {
  if (variant === 'running') return <RunDot live />;
  if (variant === 'paused') return <Icon name="pause" size="xs" weight="fill" />;
  if (variant === 'succeeded') return <Icon name="check" size="xs" weight="bold" />;
  if (variant === 'failed') return <Icon name="warning" size="xs" weight="fill" />;
  if (variant === 'cancelled') return <Icon name="x" size="xs" weight="bold" />;
  return <RunDot live={false} />;
}

/** A 6px status dot that pulses only while live; static otherwise. Honors
 *  reduced-motion via the global animation reset. */
function RunDot({ live }: { live: boolean }) {
  return (
    <svg width={8} height={8} viewBox="0 0 8 8" fill="currentColor" aria-hidden>
      <circle cx="4" cy="4" r="3">
        {live && (
          <>
            <animate attributeName="r" values="2.5;3.5;2.5" dur="1.1s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.5;1" dur="1.1s" repeatCount="indefinite" />
          </>
        )}
      </circle>
    </svg>
  );
}
