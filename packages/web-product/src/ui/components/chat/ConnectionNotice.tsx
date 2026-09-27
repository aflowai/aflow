'use client';

import { Row, Text } from '@aflow/design-system';

import { connectionNoticeLabel, useConnectionNotice } from '../../hooks/use-connection-notice.js';

/**
 * The state of the live channel, where the operator types.
 *
 * The Workbench has shown this for a while; the composer has not, so a tab in
 * reconnect backoff after a server restart looked like a conversation that had
 * simply gone quiet, and a running step's card read as a harness that had said
 * nothing. Quiet on purpose — one muted line, no border, nothing to dismiss —
 * because the connection is a fact about this tab, not about the run.
 */
export function ConnectionNotice({ isConnected }: { isConnected: boolean }) {
  const phase = useConnectionNotice(isConnected);
  const label = connectionNoticeLabel(phase);
  if (label === undefined) return null;

  return (
    <Row
      gap="2"
      align="center"
      role="status"
      style={{ padding: '0 var(--space-2) var(--space-1)' }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor:
            phase === 'reconnecting'
              ? 'var(--color-warning-default)'
              : 'var(--color-status-succeeded)',
        }}
      />
      <Text size="xs" variant="muted">
        {label}
      </Text>
    </Row>
  );
}
