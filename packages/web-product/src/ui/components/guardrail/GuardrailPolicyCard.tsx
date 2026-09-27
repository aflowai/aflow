'use client';

import { useState } from 'react';
import {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Badge,
  Text,
  Stack,
  Inline,
  JsonViewer,
} from '@aflow/design-system';

interface Rail {
  railId: string;
  name: string;
  layer: string;
  trigger: string;
  mode: string;
  type: string;
  config: Record<string, unknown>;
  onViolation: string;
  violationMessage?: string;
  priority: number;
  enabled: boolean;
}

interface GuardrailPolicy {
  policyId: string;
  name: string;
  description?: string;
  scope: {
    platform?: boolean;
    tenantIds?: string[];
    spaceIds?: string[];
    agentIds?: string[];
    stepIds?: string[];
    operationIds?: string[];
  };
  rails: Rail[];
  settings: {
    defaultFailBehavior: string;
    maxLatencyMs: number;
    logMode: string;
    logSampleRate: number;
  };
  tags?: string[];
}

function isGuardrailPolicy(data: unknown): data is GuardrailPolicy {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return 'policyId' in obj && 'rails' in obj;
}

const triggerVariantMap: Record<string, 'info' | 'warning' | 'neutral'> = {
  pre: 'info',
  post: 'warning',
  both: 'neutral',
};

const modeVariantMap: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  enforce: 'danger',
  monitor: 'warning',
  audit: 'info',
  disabled: 'neutral',
};

function scopeBadges(scope: GuardrailPolicy['scope']): Array<{ label: string; key: string }> {
  const badges: Array<{ label: string; key: string }> = [];
  if (scope.platform) badges.push({ label: 'Platform', key: 'platform' });
  if (scope.tenantIds && scope.tenantIds.length > 0) {
    badges.push({
      label: `${scope.tenantIds.length} tenant${scope.tenantIds.length !== 1 ? 's' : ''}`,
      key: 'tenants',
    });
  }
  if (scope.spaceIds && scope.spaceIds.length > 0) {
    badges.push({
      label: `${scope.spaceIds.length} space${scope.spaceIds.length !== 1 ? 's' : ''}`,
      key: 'spaces',
    });
  }
  if (scope.agentIds && scope.agentIds.length > 0) {
    badges.push({
      label: `${scope.agentIds.length} agent${scope.agentIds.length !== 1 ? 's' : ''}`,
      key: 'agents',
    });
  }
  if (scope.stepIds && scope.stepIds.length > 0) {
    badges.push({
      label: `${scope.stepIds.length} step${scope.stepIds.length !== 1 ? 's' : ''}`,
      key: 'steps',
    });
  }
  if (scope.operationIds && scope.operationIds.length > 0) {
    badges.push({
      label: `${scope.operationIds.length} op${scope.operationIds.length !== 1 ? 's' : ''}`,
      key: 'ops',
    });
  }
  return badges;
}

export function GuardrailPolicyCard({ data }: { data: unknown }) {
  const [expanded, setExpanded] = useState(false);

  try {
    if (!isGuardrailPolicy(data)) {
      return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
    }

    const policy = data;
    const scopes = scopeBadges(policy.scope);
    const enabledCount = policy.rails.filter((r) => r.enabled).length;

    return (
      <Card>
        <CardHeader>
          <Inline gap="2" align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
            <Inline gap="2" align="center">
              <Text variant="label" size="sm">
                {policy.name}
              </Text>
              {scopes.map((s) => (
                <Badge key={s.key} variant="info">
                  {s.label}
                </Badge>
              ))}
              {policy.tags?.map((tag) => (
                <Badge key={tag} variant="neutral">
                  {tag}
                </Badge>
              ))}
            </Inline>
            <button
              onClick={() => {
                setExpanded(!expanded);
              }}
              style={{
                background: 'none',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-sm)',
                padding: '2px 8px',
                cursor: 'pointer',
                fontSize: '12px',
                color: 'var(--color-text-muted)',
              }}
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          </Inline>
        </CardHeader>

        <CardBody>
          <Stack gap="2">
            {policy.description && <Text variant="muted">{policy.description}</Text>}

            <Text variant="muted" size="sm">
              {enabledCount}/{policy.rails.length} rail{policy.rails.length !== 1 ? 's' : ''}{' '}
              enabled
            </Text>

            {/* Rail list - always visible in compact form, full detail when expanded */}
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
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Rail</th>
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Type</th>
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Trigger</th>
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>Mode</th>
                    <th style={{ padding: 'var(--space-1) var(--space-2)' }}>On Violation</th>
                  </tr>
                </thead>
                <tbody>
                  {(expanded ? policy.rails : policy.rails.slice(0, 3)).map((rail) => (
                    <tr
                      key={rail.railId}
                      style={{
                        borderBottom: '1px solid var(--color-border-default)',
                        opacity: rail.enabled ? 1 : 0.5,
                      }}
                    >
                      <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                        <Inline gap="1" align="center">
                          <Text as="span" size="sm">
                            {rail.name}
                          </Text>
                          {!rail.enabled && <Badge variant="neutral">off</Badge>}
                        </Inline>
                      </td>
                      <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                        <Badge variant="neutral">{rail.type}</Badge>
                      </td>
                      <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                        <Badge variant={triggerVariantMap[rail.trigger] ?? 'neutral'}>
                          {rail.trigger}
                        </Badge>
                      </td>
                      <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                        <Badge variant={modeVariantMap[rail.mode] ?? 'neutral'}>{rail.mode}</Badge>
                      </td>
                      <td style={{ padding: 'var(--space-1) var(--space-2)' }}>
                        <Text as="span" variant="mono" size="xs">
                          {rail.onViolation}
                        </Text>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!expanded && policy.rails.length > 3 && (
                <Text
                  variant="muted"
                  size="xs"
                  style={{ padding: 'var(--space-1) var(--space-2)' }}
                >
                  +{policy.rails.length - 3} more rail{policy.rails.length - 3 !== 1 ? 's' : ''}
                </Text>
              )}
            </div>
          </Stack>
        </CardBody>

        {expanded && (
          <CardFooter>
            <Inline gap="3" align="center">
              <Text variant="muted" size="xs">
                Fail behavior: {policy.settings.defaultFailBehavior}
              </Text>
              <Text variant="muted" size="xs">
                Log: {policy.settings.logMode} ({(policy.settings.logSampleRate * 100).toFixed(0)}%)
              </Text>
              <Text variant="muted" size="xs">
                Max latency: {policy.settings.maxLatencyMs}ms
              </Text>
            </Inline>
          </CardFooter>
        )}
      </Card>
    );
  } catch {
    return <JsonViewer data={data} collapseDepth={3} maxHeight="400px" />;
  }
}
