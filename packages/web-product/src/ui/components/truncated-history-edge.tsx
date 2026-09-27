'use client';

import { AnimatedWidth, Button, Row, Text } from '@aflow/design-system';

/**
 * The torn edge where a history has been cut short.
 *
 * A flat rule reads as "the conversation began here", which is a claim about
 * the session. A torn one reads as "this view starts here", which is a claim
 * about the view — the distinction matters because the events above it exist
 * and are one click away.
 */
export interface TruncatedHistoryEdgeProps {
  /**
   * Fired when the reader asks for the page above this edge.
   *
   * Omitted where the older pages cannot be fetched yet. The edge still shows:
   * that history exists above it is true whether or not it can be reached, and
   * a transcript that starts partway through without saying so reads as the
   * whole conversation.
   */
  onLoadOlder?: () => void;
  /** A page is in flight; the control stays visible but stops accepting clicks. */
  loading?: boolean;
  /** Overrides the label, e.g. for a surface that does not call them "events". */
  label?: string;
  /** Overrides the in-flight label, which names the same things as `label`. */
  loadingLabel?: string;
}

/**
 * The zigzag repeats every 16px, so the edge looks torn rather than dashed at
 * any width without needing a measured viewBox.
 */
const ZIGZAG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='8' viewBox='0 0 16 8'%3E%3Cpath d='M0 6 L4 2 L8 6 L12 2 L16 6' fill='none' stroke='%23888' stroke-opacity='0.55' stroke-width='1.25'/%3E%3C/svg%3E\")";

export function TruncatedHistoryEdge({
  onLoadOlder,
  loading = false,
  label = 'Show earlier events',
  loadingLabel = 'Loading earlier events…',
}: TruncatedHistoryEdgeProps) {
  return (
    <Row
      align="center"
      gap="3"
      style={{ padding: 'var(--space-2) 0' }}
      aria-label="Earlier history is not shown"
    >
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 8,
          backgroundImage: ZIGZAG,
          backgroundRepeat: 'repeat-x',
          backgroundPosition: 'center',
        }}
      />
      {onLoadOlder === undefined ? (
        <Text size="xs" variant="muted">
          {label}
        </Text>
      ) : (
        // The two labels are different lengths, and the swap happens under the
        // reader's cursor. Tweening the width keeps the torn edge either side
        // of it from jumping outward the instant the page is asked for.
        <AnimatedWidth>
          <Button size="sm" variant="ghost" disabled={loading} onClick={onLoadOlder}>
            {loading ? (
              <Text size="xs" variant="muted">
                {loadingLabel}
              </Text>
            ) : (
              <Text size="xs">{label}</Text>
            )}
          </Button>
        </AnimatedWidth>
      )}
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 8,
          backgroundImage: ZIGZAG,
          backgroundRepeat: 'repeat-x',
          backgroundPosition: 'center',
        }}
      />
    </Row>
  );
}
