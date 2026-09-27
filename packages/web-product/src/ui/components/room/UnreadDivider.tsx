'use client';

import { Text } from '@aflow/design-system';

/**
 * When the room moved on without you.
 *
 * The line marks where you stopped reading; the label says how long ago that
 * was, because "new" is the one thing the position already tells you — coming
 * back to a room, what you want to know is whether you missed the last ten
 * minutes or the last two days.
 */
export function UnreadDivider({ since }: { since: string }) {
  const label = describeGap(since);
  return (
    <div
      role="separator"
      aria-label={`Messages from ${label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        margin: 'var(--space-2) 0',
      }}
    >
      <span style={{ flex: 1, height: 1, background: 'var(--color-border-default)' }} />
      <Text size="xs" color="muted">
        {label}
      </Text>
      <span style={{ flex: 1, height: 1, background: 'var(--color-border-default)' }} />
    </div>
  );
}

/**
 * How long ago, in the terms a person would use.
 *
 * Coarse on purpose: the exact minute is on the message itself, and a divider
 * that ticked would redraw the page while someone was reading it.
 */
function describeGap(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'Earlier';

  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return 'Just now';

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${String(days)} days ago`;

  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
