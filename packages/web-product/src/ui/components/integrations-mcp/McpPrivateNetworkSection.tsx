'use client';

import { Button, Column, Icon, Row, Text } from '@aflow/design-system';
import type { McpPrivateNetworkAcknowledgment } from '@aflow/schemas';
import { useCurrentUser } from '../user-avatar.js';
import { useSpacePeople } from '../../hooks/use-space-people.js';
import { ChipList, DetailRow, DetailsSection, formatJson } from '../integrations-api/helpers.js';
import { describeMcpRefusal, SET_PRIVATE_NETWORK_LABEL } from './mcpEgressRefusal.js';
import type { McpBindingTestResult } from './use-mcp-integrations.js';

/** Who set the acknowledgment and when, read from the record itself. */
export function PrivateNetworkSetBy({
  acknowledgment,
  spaceId,
}: {
  acknowledgment: McpPrivateNetworkAcknowledgment;
  spaceId: string;
}) {
  const me = useCurrentUser();
  const personFor = useSpacePeople(spaceId);
  const who =
    me?.userId === acknowledgment.setBy
      ? `You (${me.displayName})`
      : (personFor(acknowledgment.setBy)?.displayName ?? acknowledgment.setBy);
  return (
    <Text size="xs" color="muted">
      Set by {who} on {new Date(acknowledgment.setAt).toLocaleString()}
    </Text>
  );
}

/**
 * The definition's Private network section: the hosts it covers, and who set
 * them and when. Shown only once an operator has set the acknowledgment.
 */
export function McpPrivateNetworkSection({
  acknowledgment,
  spaceId,
  onEdit,
}: {
  acknowledgment: McpPrivateNetworkAcknowledgment;
  spaceId: string;
  /** Opens the private network form. Absent for a viewer. */
  onEdit?: () => void;
}) {
  return (
    <DetailsSection
      label="Private network"
      count={acknowledgment.hosts.length}
      rawJson={() => formatJson(acknowledgment)}
    >
      <Column gap="2">
        <Text size="sm" color="secondary">
          These hosts may resolve to a private network address or shared address space, reached over
          https only.
        </Text>
        <DetailRow label="Hosts">
          <ChipList items={[...acknowledgment.hosts]} variant="info" />
        </DetailRow>
        <PrivateNetworkSetBy acknowledgment={acknowledgment} spaceId={spaceId} />
        {onEdit && (
          <Row>
            <Button variant="ghost" leftIcon={<Icon name="pencil" size="sm" />} onClick={onEdit}>
              Change hosts
            </Button>
          </Row>
        )}
      </Column>
    </DetailsSection>
  );
}

/**
 * A failed test or refresh in words. A refused connect names its range and
 * remedy, with the action that answers it. Any other failure shows the step's
 * own message.
 */
export function McpTestFailure({
  result,
  prefix,
  onSetPrivateNetwork,
}: {
  result: McpBindingTestResult;
  prefix: string;
  /** Opens the private network form for the refused host. Absent for a viewer. */
  onSetPrivateNetwork?: (refusedHost: string | undefined) => void;
}) {
  const view = result.refusal ? describeMcpRefusal(result.refusal) : null;
  const text = view?.text ?? result.message ?? 'The server could not be reached.';
  return (
    <Column gap="1">
      <Text size="xs" tone="danger">
        {prefix} {text}
      </Text>
      {view?.action === 'set_private_network' && onSetPrivateNetwork && (
        <Row>
          <Button
            variant="secondary"
            leftIcon={<Icon name="shield-check" size="sm" />}
            onClick={() => {
              onSetPrivateNetwork(result.refusal?.target);
            }}
          >
            {SET_PRIVATE_NETWORK_LABEL}
          </Button>
        </Row>
      )}
    </Column>
  );
}
