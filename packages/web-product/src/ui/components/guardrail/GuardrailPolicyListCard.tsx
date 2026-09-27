'use client';

import { Card, CardHeader, CardBody, Badge, Text, Inline, JsonViewer } from '@aflow/design-system';

interface PolicyListItem {
  policyId: string;
  name: string;
  description?: string;
  version: number;
  railCount: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

function isPolicyList(data: unknown): data is { policies: PolicyListItem[]; total: number } {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (!('policies' in obj) || !Array.isArray(obj['policies']) || !('total' in obj)) return false;
  if (obj['policies'].length === 0) return true;
  const first: unknown = obj['policies'][0];
  return typeof first === 'object' && first !== null && 'policyId' in first;
}

export function GuardrailPolicyListCard({ data }: { data: unknown }) {
  try {
    if (!isPolicyList(data)) {
      return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
    }

    const { policies, total } = data;

    return (
      <Card>
        <CardHeader>
          <Inline gap="2" align="center">
            <Text variant="label" size="sm">
              Guardrail Policies
            </Text>
            <Badge variant="neutral">{total} total</Badge>
          </Inline>
        </CardHeader>

        <CardBody>
          {policies.length === 0 ? (
            <Text variant="muted" size="sm">
              No guardrail policies found.
            </Text>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 'var(--font-size-sm)',
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--color-border-default)',
                      textAlign: 'left',
                    }}
                  >
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Name</th>
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Version</th>
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Rails</th>
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => (
                    <tr
                      key={policy.policyId}
                      style={{ borderBottom: '1px solid var(--color-border-default)' }}
                    >
                      <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                        <div>
                          <Text size="sm" style={{ fontWeight: 500 }}>
                            {policy.name}
                          </Text>
                          <Text
                            variant="muted"
                            size="xs"
                            style={{ fontFamily: 'var(--font-family-mono)' }}
                          >
                            {policy.policyId}
                          </Text>
                        </div>
                      </td>
                      <td style={{ padding: 'var(--space-1) var(--space-2)', textAlign: 'center' }}>
                        <Badge variant="neutral">v{policy.version}</Badge>
                      </td>
                      <td style={{ padding: 'var(--space-1) var(--space-2)', textAlign: 'center' }}>
                        <Badge variant="info">{policy.railCount}</Badge>
                      </td>
                      <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                        {policy.tags && policy.tags.length > 0 ? (
                          <Inline gap="1">
                            {policy.tags.map((tag) => (
                              <Badge key={tag} variant="neutral">
                                {tag}
                              </Badge>
                            ))}
                          </Inline>
                        ) : (
                          <Text as="span" variant="muted" size="xs">
                            -
                          </Text>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    );
  } catch {
    return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
  }
}
