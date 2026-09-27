'use client';

import { Row, Column, Text, Button, Icon, Badge } from '@aflow/design-system';
import type { SessionBlockedOn } from '@aflow/schemas';

type WriteApprovalBlock = Extract<SessionBlockedOn, { kind: 'needs_write_approval' }>;

/**
 * In-transcript notice that the run is parked on a write approval.
 *
 * The pause is otherwise invisible from the chat: it carries no prompt, so the
 * generic paused bubble skips it, and `SessionPaused` retires the activity
 * indicator — leaving a conversation that reads as hung when the platform is
 * in fact waiting correctly. This says what is waiting and where to answer it.
 *
 * It names the method and host but never the path or body: a resolved write URL
 * can carry secrets, which is why `blockedOn` only carries the host.
 */
export function AwaitingApprovalNotice({
  block,
  onReview,
}: {
  block: WriteApprovalBlock;
  onReview?: (() => void) | undefined;
}) {
  return (
    <Row
      gap="3"
      align="center"
      style={{
        margin: 'var(--space-2) 0',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-warning-default)',
        background: 'var(--color-surface-1)',
      }}
    >
      <Icon name="shield-check" size="sm" style={{ color: 'var(--color-warning-default)' }} />
      <Column gap="1" style={{ flex: 1, minWidth: 0 }}>
        <Row gap="2" align="center">
          <Text size="sm" weight="medium">
            Waiting for your approval
          </Text>
          {block.writeRiskTier === 'high' && <Badge variant="warning">High risk</Badge>}
        </Row>
        <Text size="xs" color="muted">
          {`${block.method} ${block.endpointId} on ${block.urlHost}`}
        </Text>
      </Column>
      {onReview && (
        <Button size="sm" variant="secondary" onClick={onReview}>
          Review
        </Button>
      )}
    </Row>
  );
}
