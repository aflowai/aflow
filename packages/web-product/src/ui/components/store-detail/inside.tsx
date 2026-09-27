'use client';

import { Badge, Column, Icon, Row, Text } from '@aflow/design-system';
import type { SkillBundle } from '@aflow/schemas';

export function BundleInside({
  payload,
  memberByCatalogId,
}: {
  payload: SkillBundle;
  memberByCatalogId: Map<string, { name: string; installed: boolean }>;
}) {
  const integrationNames = [
    ...payload.apiDefinitions.map((d) => d.definition.name || d.apiId),
    ...payload.mcpDefinitions.map((d) => d.definition.name || d.serverId),
  ];
  return (
    <Column gap="sm">
      <Column gap="xs">
        <Text size="sm" weight="medium">
          Skills
        </Text>
        {payload.skillCatalogIds.map((memberId) => {
          const member = memberByCatalogId.get(memberId);
          return (
            <Row key={memberId} gap="sm" align="center">
              {member?.installed ? (
                <Icon name="check-circle" size="xs" />
              ) : (
                <Text
                  size="xs"
                  style={{ width: '1em', textAlign: 'center', color: 'var(--color-text-muted)' }}
                >
                  •
                </Text>
              )}
              <Text size="xs">{member?.name ?? memberId}</Text>
              {member?.installed && <Badge variant="success">Installed</Badge>}
            </Row>
          );
        })}
      </Column>
      {integrationNames.length > 0 && (
        <Column gap="xs">
          <Text size="sm" weight="medium">
            Integrations
          </Text>
          {integrationNames.map((name) => (
            <Row key={name} gap="sm" align="center">
              <Icon name="plugs" size="xs" />
              <Text size="xs">{name}</Text>
            </Row>
          ))}
        </Column>
      )}
      {payload.memorySeed.length > 0 && (
        <Column gap="xs">
          <Text size="sm" weight="medium">
            Documents
          </Text>
          {payload.memorySeed.map((doc) => (
            <Row key={doc.path} gap="sm" align="center">
              <Icon name="file-text" size="xs" />
              <Text size="xs" style={{ fontFamily: 'monospace' }}>
                {doc.path}
              </Text>
            </Row>
          ))}
        </Column>
      )}
    </Column>
  );
}

export function ConnectorInside({
  hosts,
  endpointCount,
}: {
  hosts: string[];
  endpointCount: number | null;
}) {
  return (
    <Column gap="xs">
      {hosts.length > 0 && (
        <Row gap="sm" align="center">
          <Icon name="globe" size="sm" />
          <Text size="sm">
            Talks to {hosts.join(', ')}
            {hosts.length === 1 ? ' only' : ''}
          </Text>
        </Row>
      )}
      {endpointCount !== null && (
        <Row gap="sm" align="center">
          <Icon name="plugs" size="sm" />
          <Text size="sm">
            {String(endpointCount)} endpoint{endpointCount === 1 ? '' : 's'} ready to use
          </Text>
        </Row>
      )}
      {endpointCount === null && (
        <Row gap="sm" align="center">
          <Icon name="plugs" size="sm" />
          <Text size="sm">Tools are discovered when you connect.</Text>
        </Row>
      )}
    </Column>
  );
}
