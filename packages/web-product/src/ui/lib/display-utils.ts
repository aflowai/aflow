import type { BadgeVariant } from '@aflow/design-system';

export function statusToBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case 'QUEUED':
      return 'queued';
    case 'RUNNING':
      return 'running';
    case 'PAUSED':
      return 'paused';
    case 'WAITING_ON_CHILD':
      return 'running';
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'CANCELLING':
      return 'cancelled';
    case 'STALLED':
      return 'stalled';
    default:
      return 'neutral';
  }
}

/** CSS color for a status indicator dot — uses design tokens where possible, vivid overrides for active states. */
export function statusToColor(status: string): string {
  switch (status) {
    case 'QUEUED':
      return 'var(--color-status-queued-fg)';
    case 'RUNNING':
    case 'WAITING_ON_CHILD':
      return 'var(--color-interactive-default)';
    case 'PAUSED':
      return 'var(--color-status-paused-fg)';
    case 'SUCCEEDED':
      return 'var(--color-status-succeeded-fg)';
    case 'FAILED':
      return 'var(--color-status-failed-fg)';
    case 'CANCELLED':
    case 'CANCELLING':
      return 'var(--color-status-cancelled-fg)';
    case 'STALLED':
      return 'var(--color-status-stalled-fg)';
    default:
      return 'var(--color-content-muted)';
  }
}

/** Human-readable label for a run status. */
export function statusToLabel(status: string): string {
  switch (status) {
    case 'QUEUED':
      return 'Queued';
    case 'RUNNING':
      return 'Running';
    case 'WAITING_ON_CHILD':
      return 'Running Subflow';
    case 'PAUSED':
      return 'Idle';
    case 'SUCCEEDED':
      return 'Completed';
    case 'FAILED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
    case 'CANCELLING':
      return 'Cancelling';
    case 'STALLED':
      return 'Stalled';
    default:
      return status;
  }
}

export function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Map a child sessionId (or any stable string) to a hue (0-359). Used to
 * give parallel sub-agent bubbles distinct accent colors so their
 * interleaved messages are easy to visually cluster. FNV-1a-style hash —
 * cheap and spreads adjacent UUIDs apart so two sibling runners don't pick
 * neighboring shades.
 */
export function hueFromRunId(runId: string | undefined): number | undefined {
  if (!runId) return undefined;
  let h = 2166136261;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

export function formatRelative(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  const m = Math.floor(ms / 60000);
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(ms / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${String(m)}m ago`;
  if (h < 24) return `${String(h)}h ago`;
  return `${String(d)}d ago`;
}
