'use client';

import { useState } from 'react';
import { Badge, Card, CardBody, Column, Divider, Icon, Row, Text } from '@aflow/design-system';
import type {
  ApiBindingSummary,
  ApiDefinitionDetail,
  ApiDefinitionSummary,
  ApiEndpointDetail,
} from '../../hooks/use-integrations.js';
import {
  ChipList,
  DetailRow,
  DetailsSection,
  formatBytes,
  formatJson,
  formatMs,
  methodBadgeVariant,
} from './helpers.js';

// ============================================================================
// Definition Details View
// ============================================================================

export function DefinitionDetailsView({
  definition,
  detail,
}: {
  definition: ApiDefinitionSummary;
  detail: ApiDefinitionDetail | null;
}) {
  const tags = detail?.tags ?? definition.tags;
  const defaultHeaders = detail?.defaultHeaders;
  const suggested = detail?.suggestedEgressPolicy;

  return (
    <Column gap="2">
      <DetailRow label="API ID">
        <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
          {definition.apiId}
        </Text>
      </DetailRow>
      <DetailRow label="Base URL">
        <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)', wordBreak: 'break-all' }}>
          {definition.baseUrlTemplate || definition.baseUrl}
        </Text>
        {definition.baseUrlTemplate && (
          <Text size="xs" color="secondary">
            Templated — the {'{variable}'} is filled per connection (set in Connect, not here).
          </Text>
        )}
      </DetailRow>
      <DetailRow label="Version">
        <Badge variant="neutral">{definition.version}</Badge>
      </DetailRow>
      {tags.length > 0 && (
        <DetailRow label="Tags">
          <ChipList items={tags} />
        </DetailRow>
      )}
      {defaultHeaders && Object.keys(defaultHeaders).length > 0 && (
        <DetailRow label="Default headers">
          <Column gap="1">
            {Object.entries(defaultHeaders).map(([k, v]) => (
              <Text key={k} size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
                {k}: {v}
              </Text>
            ))}
          </Column>
        </DetailRow>
      )}
      {suggested && Object.keys(suggested).length > 0 && (
        <>
          <Divider />
          <Text size="xs" weight="medium" color="secondary">
            Suggested egress policy (defaults applied to new connections)
          </Text>
          {suggested.additionalHosts && suggested.additionalHosts.length > 0 && (
            <DetailRow label="Additional hosts">
              <ChipList items={suggested.additionalHosts} />
            </DetailRow>
          )}
          {suggested.allowedMethods && suggested.allowedMethods.length > 0 && (
            <DetailRow label="Methods">
              <ChipList items={suggested.allowedMethods} variant="info" />
            </DetailRow>
          )}
          {suggested.allowCrossHostRedirects != null && (
            <DetailRow label="Cross-host redirects">
              <Badge variant={suggested.allowCrossHostRedirects ? 'warning' : 'neutral'}>
                {suggested.allowCrossHostRedirects ? 'allowed' : 'blocked'}
              </Badge>
            </DetailRow>
          )}
          {suggested.minResponseBodyBytes != null && (
            <DetailRow label="Min response size">
              <Text size="sm">{formatBytes(suggested.minResponseBodyBytes)}</Text>
            </DetailRow>
          )}
          {suggested.minTimeoutMs != null && (
            <DetailRow label="Min timeout">
              <Text size="sm">{formatMs(suggested.minTimeoutMs)}</Text>
            </DetailRow>
          )}
        </>
      )}
      <Divider />
      <DetailRow label="Created">
        <Text size="sm" color="secondary">
          {new Date(definition.createdAt).toLocaleString()}
        </Text>
      </DetailRow>
      <DetailRow label="Updated">
        <Text size="sm" color="secondary">
          {new Date(definition.updatedAt).toLocaleString()}
        </Text>
      </DetailRow>
    </Column>
  );
}

// ============================================================================
// Binding Details View (egress policy, auth profile, scope)
// ============================================================================

export function BindingDetailsView({ binding }: { binding: ApiBindingSummary }) {
  const egress = binding.egressPolicy;
  const allowedHosts = (egress['allowedHosts'] as string[] | undefined) ?? [];
  const allowedMethods = (egress['allowedMethods'] as string[] | undefined) ?? [];
  const maxReq = egress['maxRequestBodyBytes'] as number | undefined;
  const maxRes = egress['maxResponseBodyBytes'] as number | undefined;
  const timeoutMs = egress['timeoutMs'] as number | undefined;
  const maxRedirects = egress['maxRedirects'] as number | undefined;
  const crossHostRedirects = egress['allowCrossHostRedirects'] as boolean | undefined;
  const retry = egress['retryPolicy'] as
    | {
        maxRetries?: number;
        retryableStatusCodes?: number[];
        retryOnlyIdempotent?: boolean;
        backoffBaseMs?: number;
        backoffMaxMs?: number;
      }
    | undefined;

  const auth = binding.auth;
  const authType = binding.authType;
  const placement = auth['placement'] as string | undefined;
  const headerName = auth['headerName'] as string | undefined;
  const queryParamName = auth['queryParamName'] as string | undefined;
  const tokenEndpoint = auth['tokenEndpoint'] as string | undefined;
  const scopes = auth['scopes'] as string[] | undefined;

  const scope = binding.scope;
  const scopeTenant = scope['tenantId'] as string | undefined;
  const scopeSpace = scope['spaceId'] as string | undefined;
  const scopeFlow = scope['flowId'] as string | undefined;

  return (
    <Column gap="2">
      <Text size="xs" weight="medium" color="secondary">
        Egress policy
      </Text>
      <DetailRow label="Allowed hosts">
        <ChipList items={allowedHosts} variant="success" />
      </DetailRow>
      <DetailRow label="Allowed methods">
        <ChipList items={allowedMethods} variant="info" />
      </DetailRow>
      {maxReq != null && (
        <DetailRow label="Max request size">
          <Text size="sm">{formatBytes(maxReq)}</Text>
        </DetailRow>
      )}
      {maxRes != null && (
        <DetailRow label="Max response size">
          <Text size="sm">{formatBytes(maxRes)}</Text>
        </DetailRow>
      )}
      {timeoutMs != null && (
        <DetailRow label="Timeout">
          <Text size="sm">{formatMs(timeoutMs)}</Text>
        </DetailRow>
      )}
      {maxRedirects != null && (
        <DetailRow label="Max redirects">
          <Text size="sm">{maxRedirects}</Text>
        </DetailRow>
      )}
      {crossHostRedirects != null && (
        <DetailRow label="Cross-host redirects">
          <Badge variant={crossHostRedirects ? 'warning' : 'neutral'}>
            {crossHostRedirects ? 'allowed' : 'blocked'}
          </Badge>
        </DetailRow>
      )}
      {retry && (
        <>
          <Divider />
          <Text size="xs" weight="medium" color="secondary">
            Retry policy
          </Text>
          {retry.maxRetries != null && (
            <DetailRow label="Max retries">
              <Text size="sm">{retry.maxRetries}</Text>
            </DetailRow>
          )}
          {retry.retryableStatusCodes && retry.retryableStatusCodes.length > 0 && (
            <DetailRow label="Retryable status codes">
              <ChipList items={retry.retryableStatusCodes.map(String)} variant="warning" />
            </DetailRow>
          )}
          {retry.retryOnlyIdempotent != null && (
            <DetailRow label="Idempotent only">
              <Badge variant={retry.retryOnlyIdempotent ? 'neutral' : 'warning'}>
                {retry.retryOnlyIdempotent ? 'yes' : 'no'}
              </Badge>
            </DetailRow>
          )}
          {retry.backoffBaseMs != null && (
            <DetailRow label="Backoff base">
              <Text size="sm">{formatMs(retry.backoffBaseMs)}</Text>
            </DetailRow>
          )}
          {retry.backoffMaxMs != null && (
            <DetailRow label="Backoff max">
              <Text size="sm">{formatMs(retry.backoffMaxMs)}</Text>
            </DetailRow>
          )}
        </>
      )}

      <Divider />
      <Text size="xs" weight="medium" color="secondary">
        Authentication
      </Text>
      <DetailRow label="Type">
        <Badge variant="neutral">{authType}</Badge>
      </DetailRow>
      {placement && (
        <DetailRow label="Placement">
          <Badge variant="neutral">{placement}</Badge>
        </DetailRow>
      )}
      {headerName && (
        <DetailRow label="Header name">
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
            {headerName}
          </Text>
        </DetailRow>
      )}
      {queryParamName && (
        <DetailRow label="Query param">
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
            {queryParamName}
          </Text>
        </DetailRow>
      )}
      {tokenEndpoint && (
        <DetailRow label="Token endpoint">
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)', wordBreak: 'break-all' }}>
            {tokenEndpoint}
          </Text>
        </DetailRow>
      )}
      {scopes && scopes.length > 0 && (
        <DetailRow label="OAuth scopes">
          <ChipList items={scopes} />
        </DetailRow>
      )}

      <Divider />
      <Text size="xs" weight="medium" color="secondary">
        Scope
      </Text>
      {scopeTenant && (
        <DetailRow label="Tenant">
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
            {scopeTenant}
          </Text>
        </DetailRow>
      )}
      {scopeSpace && (
        <DetailRow label="Space">
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
            {scopeSpace}
          </Text>
        </DetailRow>
      )}
      {scopeFlow && (
        <DetailRow label="Agent / flow">
          <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
            {scopeFlow}
          </Text>
        </DetailRow>
      )}

      <Divider />
      <DetailRow label="Created">
        <Text size="sm" color="secondary">
          {new Date(binding.createdAt).toLocaleString()}
        </Text>
      </DetailRow>
      <DetailRow label="Updated">
        <Text size="sm" color="secondary">
          {new Date(binding.updatedAt).toLocaleString()}
        </Text>
      </DetailRow>
    </Column>
  );
}

// ============================================================================
// Endpoints Section (collapsed by default)
// ============================================================================

export function EndpointsSection({
  endpointCount,
  endpoints,
  loading,
  error,
  onFirstExpand,
}: {
  endpointCount: number;
  endpoints: ApiEndpointDetail[] | null;
  loading: boolean;
  error: string | null;
  onFirstExpand: () => void | Promise<void>;
}) {
  if (endpointCount === 0) return null;

  return (
    <DetailsSection
      label="Endpoints"
      count={endpointCount}
      rawJson={() => formatJson(endpoints ?? [])}
      onFirstExpand={onFirstExpand}
      loading={loading}
      error={error}
    >
      {endpoints?.length === 0 ? (
        <Text size="sm" color="secondary">
          No endpoints defined.
        </Text>
      ) : (
        endpoints?.map((ep) => <EndpointRow key={ep.endpointId} endpoint={ep} />)
      )}
    </DetailsSection>
  );
}

function EndpointRow({ endpoint }: { endpoint: ApiEndpointDetail }) {
  const [open, setOpen] = useState(false);
  const params = endpoint.params ?? [];
  const hasDetails =
    params.length > 0 || Boolean(endpoint.description) || Boolean(endpoint.bodyEncoding);

  return (
    <Card style={{ background: 'var(--color-surface-1)' }}>
      <CardBody style={{ padding: 'var(--space-2) var(--space-3)' }}>
        <Column gap="2">
          <button
            type="button"
            onClick={() => {
              setOpen((v) => !v);
            }}
            disabled={!hasDetails}
            aria-expanded={open}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: hasDetails ? 'pointer' : 'default',
              color: 'var(--color-content-primary)',
              textAlign: 'left',
              width: '100%',
            }}
          >
            {hasDetails ? (
              <Icon
                name="caret-right"
                size="xs"
                style={{
                  transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 120ms ease',
                  flexShrink: 0,
                }}
              />
            ) : (
              <span style={{ width: 12, flexShrink: 0 }} />
            )}
            <Badge variant={methodBadgeVariant(endpoint.method)}>
              {endpoint.method.toUpperCase()}
            </Badge>
            <Text
              size="sm"
              weight="medium"
              style={{
                fontFamily: 'var(--font-family-mono)',
                wordBreak: 'break-all',
              }}
            >
              {endpoint.pathTemplate}
            </Text>
            <Text size="xs" color="secondary" truncate style={{ flex: 1, minWidth: 0 }}>
              {endpoint.name}
            </Text>
          </button>

          {open && hasDetails && (
            <Column gap="2" style={{ paddingLeft: 'var(--space-4)' }}>
              {endpoint.description && (
                <Text size="sm" color="secondary">
                  {endpoint.description}
                </Text>
              )}
              {endpoint.bodyEncoding && (
                <Row gap="2" align="center">
                  <Text size="xs" color="secondary">
                    Body encoding:
                  </Text>
                  <Badge variant="neutral">{endpoint.bodyEncoding}</Badge>
                </Row>
              )}
              {params.length > 0 && (
                <Column gap="1">
                  <Text size="xs" weight="medium" color="secondary">
                    Parameters
                  </Text>
                  {params.map((p) => (
                    <Row
                      key={`${p.location}:${p.name}`}
                      gap="2"
                      align="center"
                      wrap
                      style={{ fontSize: 'var(--font-size-sm)' }}
                    >
                      <Badge variant="neutral">{p.location}</Badge>
                      <Text
                        size="sm"
                        weight="medium"
                        style={{ fontFamily: 'var(--font-family-mono)' }}
                      >
                        {p.name}
                      </Text>
                      {p.required && <Badge variant="warning">required</Badge>}
                      {p.description && (
                        <Text size="xs" color="secondary" style={{ flex: 1, minWidth: 0 }}>
                          {p.description}
                        </Text>
                      )}
                    </Row>
                  ))}
                </Column>
              )}
            </Column>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}
