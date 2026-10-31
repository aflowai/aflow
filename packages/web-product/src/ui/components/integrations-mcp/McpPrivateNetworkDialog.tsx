'use client';

import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Column,
  Dialog,
  Field,
  Label,
  Row,
  Text,
  Textarea,
} from '@aflow/design-system';
import {
  MCP_PRIVATE_NETWORK_HOSTS_ENV,
  MCP_PRIVATE_NETWORK_MAX_HOSTS,
  normalizePrivateNetworkHost,
  privateNetworkHostProblem,
} from '@aflow/schemas';
import { useEdition } from '../../hooks/useEdition.js';
import { parseHostList, proposedPrivateNetworkHosts } from './mcpEgressRefusal.js';
import { PrivateNetworkSetBy } from './McpPrivateNetworkSection.js';
import type { McpServerDefinitionSummary } from './use-mcp-integrations.js';

/**
 * The private network form (Plan 336 D2, D7): the hosts one MCP server
 * definition may reach on a private address. It writes the whole list through
 * the operator-only PUT route, and an empty list clears it.
 */
export function McpPrivateNetworkDialog({
  definition,
  refusedHost,
  spaceId,
  onSave,
  onClose,
}: {
  definition: McpServerDefinitionSummary;
  /** The host a refused connect named, added to the list the form starts from. */
  refusedHost?: string;
  spaceId: string;
  onSave: (serverId: string, hosts: string[]) => Promise<void>;
  onClose: () => void;
}) {
  // A hosted deployment honours a host only when its environment lists it too
  // (Plan 336 D5). The local edition's operator is the deployment.
  const hosted = useEdition().id === 'enterprise';
  const current = definition.privateNetwork?.hosts ?? [];
  const [text, setText] = useState(() =>
    proposedPrivateNetworkHosts(current, refusedHost, definition.serverUrl).join('\n'),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hosts = useMemo(
    () => [...new Set(parseHostList(text).map(normalizePrivateNetworkHost))],
    [text],
  );
  const problems = useMemo(
    () =>
      hosts.flatMap((host) => {
        const problem = privateNetworkHostProblem(host);
        return problem === null ? [] : [`${host} ${problem}.`];
      }),
    [hosts],
  );
  const tooMany = hosts.length > MCP_PRIVATE_NETWORK_MAX_HOSTS;

  const save = async (next: string[]) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(definition.serverId, next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set private network hosts');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Private network — ${definition.name}`}>
      <Column gap="3" style={{ padding: 'var(--space-4)', maxWidth: 600, width: '100%' }}>
        <Text size="sm">
          Each host listed here may resolve to a private network address or to shared address space,
          as a server behind a VPN does. This server reaches a listed host over https only.
          Loopback, link-local and cloud metadata addresses stay refused for every host.
        </Text>
        <Text size="sm" color="secondary">
          List the server URL host and any token or authorization endpoint host, each exactly. A
          wildcard is refused. An agent cannot change this list.
        </Text>
        {hosted && (
          <Text size="sm" tone="warning">
            This deployment reaches a listed host only when whoever runs it also lists the host in{' '}
            <code>{MCP_PRIVATE_NETWORK_HOSTS_ENV}</code>.
          </Text>
        )}

        <Field>
          <Label>Hosts, one per line</Label>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
            placeholder="mcp.corp.example"
            rows={4}
          />
        </Field>

        <Column gap="1">
          <Text size="xs" weight="medium" color="secondary">
            Covers
          </Text>
          {hosts.length === 0 ? (
            <Text size="sm" color="secondary">
              No host. Saving clears the private network setting.
            </Text>
          ) : (
            <Row gap="1" wrap>
              {hosts.map((host) => (
                <Badge key={host} variant="info">
                  <Text size="xs" style={{ fontFamily: 'var(--font-family-mono)' }}>
                    {host}
                  </Text>
                </Badge>
              ))}
            </Row>
          )}
        </Column>

        {definition.privateNetwork && (
          <PrivateNetworkSetBy acknowledgment={definition.privateNetwork} spaceId={spaceId} />
        )}

        {problems.map((problem) => (
          <Text key={problem} size="sm" tone="danger">
            {problem}
          </Text>
        ))}
        {tooMany && (
          <Text size="sm" tone="danger">
            List at most {String(MCP_PRIVATE_NETWORK_MAX_HOSTS)} hosts.
          </Text>
        )}
        {error && (
          <Text size="sm" tone="danger">
            {error}
          </Text>
        )}

        <Row justify="between" gap="2">
          {definition.privateNetwork ? (
            <Button variant="ghost" onClick={() => void save([])} disabled={saving}>
              Clear
            </Button>
          ) : (
            <span />
          )}
          <Row gap="2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void save(hosts)}
              disabled={saving || problems.length > 0 || tooMany}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </Row>
        </Row>
      </Column>
    </Dialog>
  );
}
