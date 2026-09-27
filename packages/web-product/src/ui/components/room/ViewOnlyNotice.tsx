'use client';

import { Icon, Row, Text } from '@aflow/design-system';

/**
 * Stands in for the composer when the person cannot steer.
 *
 * A viewer sees the whole room — that is the point of the visibility model —
 * but cannot advance the agent. Showing them a text box they may type into
 * and then refusing the send is a worse answer than not offering it: the
 * affordance should say what is true.
 */
export function ViewOnlyNotice() {
  return (
    <Row
      gap="sm"
      align="center"
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-2)',
      }}
    >
      <Icon name="eye" size="sm" />
      <Text size="sm" color="muted">
        You have view-only access to this space. You can follow along here, but only editors can
        message or steer.
      </Text>
    </Row>
  );
}
