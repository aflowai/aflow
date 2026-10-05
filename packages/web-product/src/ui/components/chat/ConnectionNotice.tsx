'use client';

import { Row, Text } from '@aflow/design-system';

import { statusLine, useConnectionNotice } from '../../hooks/use-connection-notice.js';
import { useOrchestratorNotice } from '../../hooks/use-orchestrator-health.js';

/**
 * The state of the live channel, where the operator types — and whether an
 * orchestrator is there to take what they send.
 *
 * The Workbench has shown this for a while; the composer has not, so a tab in
 * reconnect backoff after a server restart looked like a conversation that had
 * simply gone quiet, and a running step's card read as a coding agent that had
 * said nothing. Quiet on purpose — one muted line, no border, nothing to dismiss
 * — because the connection is a fact about this tab, not about the run.
 *
 * The channel's phase speaks for a session that exists; a conversation with
 * none holds no subscription to report on. A missing orchestrator is said
 * either way, since the first message of a new conversation waits on it too.
 */
export function ConnectionNotice({
  isConnected,
  hasSession,
}: {
  isConnected: boolean;
  hasSession: boolean;
}) {
  const phase = useConnectionNotice(isConnected, hasSession);
  const orchestratorNotice = useOrchestratorNotice();
  const line = statusLine(phase, orchestratorNotice);
  if (line === undefined) return null;

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
            line.tone === 'warning'
              ? 'var(--color-warning-default)'
              : 'var(--color-status-succeeded)',
        }}
      />
      <Text size="xs" variant="muted">
        {line.label}
      </Text>
    </Row>
  );
}
