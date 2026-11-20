'use client';

import { useCallback, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Divider,
  Heading,
  Icon,
  IconButton,
  ListingAvatar,
  Row,
  Text,
  Tooltip,
} from '@aflow/design-system';
import type {
  ApiBindingSummary,
  ApiDefinitionDetail,
  ApiDefinitionSummary,
  IntegrationCredentialMeta,
} from '../../hooks/use-integrations.js';
import { isAuthHalfBuilt } from '../integrations/authSlots.js';
import { OAuthConnectRow } from './OAuthConnectRow.js';
import { BindingDetailsView, DefinitionDetailsView, EndpointsSection } from './ApiDetailsViews.js';
import { DetailsSection, formatJson, getApiStatus, StatusBadge } from './helpers.js';

/** Resolve a binding's concrete host (template + filled values); unfilled vars stay `{name}`. */
function resolveBindingBaseUrl(
  definition: ApiDefinitionSummary,
  binding: ApiBindingSummary,
): string {
  if (!definition.baseUrlTemplate) return definition.baseUrl;
  return definition.baseUrlTemplate.replace(/\{([^}]+)\}/g, (_m, n: string) => {
    const v = binding.variableValues?.[n]?.trim();
    return v && v.length > 0 ? v : `{${n}}`;
  });
}

export function ApiCard({
  definition,
  bindings,
  credentialsByKey,
  onConnect,
  onEditConnection,
  onDeleteConnection,
  onEditDefinition,
  onAddSecret,
  onDeleteApi,
  loadDetail,
  kindBadge,
  renderConnectionRepos,
  renderConnectionSimulation,
  readOnly = false,
}: {
  definition: ApiDefinitionSummary;
  bindings: ApiBindingSummary[];
  credentialsByKey: Map<string, IntegrationCredentialMeta>;
  /** Opens the connection dialog in "add" mode. */
  onConnect: () => void;
  /** Opens the connection dialog in "edit" mode against the existing binding. */
  onEditConnection: (binding: ApiBindingSummary) => void;
  /** Removes a single connection (its own auth); blocked server-side if repos still resolve through it. */
  onDeleteConnection: (binding: ApiBindingSummary) => void;
  /**
   * Opens the definition dialog in "edit" mode. The page is responsible
   * for loading the full `ApiDefinitionDetail` (endpoints included) before
   * showing the dialog — the card only signals intent.
   */
  onEditDefinition: () => void;
  onAddSecret: (key: string) => void;
  onDeleteApi: () => Promise<void>;
  loadDetail: (apiId: string) => Promise<ApiDefinitionDetail>;
  /** Optional badge rendered next to the name — used by the unified list to mark API vs MCP. */
  kindBadge?: ReactNode;
  /** Optional surface rendered beneath a connection (e.g. its github-linked repos). */
  renderConnectionRepos?: (binding: ApiBindingSummary) => ReactNode;
  /** Optional surface rendered beneath a connection whose fulfillment is simulated. */
  renderConnectionSimulation?: (binding: ApiBindingSummary) => ReactNode;
  /** Viewer-role rendering: status only, no mutation affordances (the server rejects those writes anyway). */
  readOnly?: boolean;
}) {
  // The provider-card header URL is definition-level (the raw template with its
  // {var} slots); each connection shows its OWN resolved URL.
  const definitionBaseUrl = definition.baseUrlTemplate ?? definition.baseUrl;

  const [detail, setDetail] = useState<ApiDefinitionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const ensureDetail = useCallback(async () => {
    if (detail !== null || detailLoading) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const d = await loadDetail(definition.apiId);
      setDetail(d);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Failed to load details');
    } finally {
      setDetailLoading(false);
    }
  }, [definition.apiId, detail, detailLoading, loadDetail]);

  // Two OAuth-code bindings share one connect-once identity (keyed on apiId), so a
  // second account is a real foot-gun until resourceKey incorporates bindingId.
  const hasOAuthCodeBinding = bindings.some((b) => b.authType === 'oauth2_authorization_code');
  const single = bindings.length === 1 ? bindings[0] : undefined;

  return (
    <Card style={{ backgroundColor: 'var(--color-surface-2)' }}>
      <CardBody>
        <Column gap="3">
          {/* Header — name + definition-level URL + kind badge */}
          <Column gap="2">
            <Row gap="2" align="center" wrap>
              <ListingAvatar
                {...(definition.icon ? { icon: definition.icon } : {})}
                name={definition.name}
                kind="connector"
                seed={definition.apiId}
                size="md"
              />
              <Column gap="0" style={{ minWidth: 0, flex: 1 }}>
                <Row gap="2" align="center" wrap>
                  <Heading level={5}>{definition.name}</Heading>
                  {kindBadge}
                </Row>
                <Text size="sm" color="secondary" truncate>
                  {definitionBaseUrl}
                </Text>
              </Column>
            </Row>
            <Row gap="2" align="center" wrap>
              <Badge variant="neutral">{String(definition.endpointCount)} endpoints</Badge>
              {!readOnly && (
                <>
                  <Tooltip content="Edit API definition (name, endpoints, tags)">
                    <IconButton
                      icon={<Icon name="gear-six" size="sm" />}
                      aria-label="Edit API definition"
                      onClick={onEditDefinition}
                    />
                  </Tooltip>
                  <Tooltip content="Delete integration">
                    <IconButton
                      icon={<Icon name="trash" size="sm" />}
                      aria-label="Delete integration"
                      onClick={() => void onDeleteApi()}
                    />
                  </Tooltip>
                </>
              )}
            </Row>
          </Column>

          {definition.description && (
            <Text size="sm" color="secondary">
              {definition.description}
            </Text>
          )}

          <DetailsSection
            label="Definition"
            rawJson={() => formatJson(detail ?? definition)}
            onFirstExpand={ensureDetail}
            loading={detailLoading}
            error={detailError}
          >
            <DefinitionDetailsView definition={definition} detail={detail} />
          </DetailsSection>

          <EndpointsSection
            endpointCount={definition.endpointCount}
            endpoints={detail?.endpoints ?? null}
            loading={detailLoading}
            error={detailError}
            onFirstExpand={ensureDetail}
          />

          {/* Connect affordance when there's no connection yet. Mirrors MCP
              card: divider + prompt sit below the definition/endpoint sections
              so the operator can scan capabilities first, then decide. */}
          {bindings.length === 0 && (
            <>
              <Divider />
              <Row justify="between" align="center">
                <Text size="sm" color="secondary">
                  This API is not connected yet. Add a connection to use it in flows.
                </Text>
                {!readOnly && (
                  <Button
                    variant="primary"
                    leftIcon={<Icon name="plugs-connected" size="sm" />}
                    onClick={onConnect}
                  >
                    Connect
                  </Button>
                )}
              </Row>
            </>
          )}

          {/* Single connection: render inline exactly as a one-account card —
              no "Connections" label, no sub-card wrapper. */}
          {single && (
            <ApiConnectionCard
              binding={single}
              definition={definition}
              credentialsByKey={credentialsByKey}
              onEditConnection={onEditConnection}
              onDeleteConnection={onDeleteConnection}
              onAddSecret={onAddSecret}
              repos={renderConnectionRepos?.(single)}
              simulation={renderConnectionSimulation?.(single)}
              readOnly={readOnly}
            />
          )}

          {/* Two or more connections: label + a sub-card per connection, each
              hosting its own repos. */}
          {bindings.length >= 2 && (
            <Column gap="2">
              <Text size="xs" weight="medium" color="secondary">
                Connections
              </Text>
              {bindings.map((b) => (
                <ApiConnectionCard
                  key={b.bindingId}
                  asCard
                  binding={b}
                  definition={definition}
                  credentialsByKey={credentialsByKey}
                  onEditConnection={onEditConnection}
                  onDeleteConnection={onDeleteConnection}
                  onAddSecret={onAddSecret}
                  repos={renderConnectionRepos?.(b)}
                  simulation={renderConnectionSimulation?.(b)}
                  readOnly={readOnly}
                />
              ))}
            </Column>
          )}

          {/* OAuth-code providers are single-account (one connect-once identity per
              apiId), so the affordance is offered only for non-OAuth providers. */}
          {bindings.length >= 1 && !hasOAuthCodeBinding && !readOnly && (
            <Row>
              <Button
                variant="secondary"
                leftIcon={<Icon name="plus" size="sm" />}
                onClick={onConnect}
              >
                Add connection
              </Button>
            </Row>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

/**
 * The per-connection surface — status/auth badges, credential pills, the
 * collapsed Connection details, readiness hints, OAuth sign-in, and the
 * connection's own nested repos. Rendered inline for the single-connection case
 * and inside a bordered sub-card when a provider hosts two or more connections.
 */
function ApiConnectionCard({
  binding,
  definition,
  credentialsByKey,
  onEditConnection,
  onDeleteConnection,
  onAddSecret,
  repos,
  simulation,
  asCard = false,
  readOnly = false,
}: {
  binding: ApiBindingSummary;
  definition: ApiDefinitionSummary;
  credentialsByKey: Map<string, IntegrationCredentialMeta>;
  onEditConnection: (binding: ApiBindingSummary) => void;
  onDeleteConnection: (binding: ApiBindingSummary) => void;
  onAddSecret: (key: string) => void;
  repos?: ReactNode;
  simulation?: ReactNode;
  asCard?: boolean;
  readOnly?: boolean;
}) {
  const requiredVariables = (definition.variables ?? [])
    .filter((v) => v.required)
    .map((v) => v.name);
  const isOAuthCodeBinding = binding.authType === 'oauth2_authorization_code';
  const isOAuthConnected = binding.oauthConnection?.status === 'connected';
  // A live OAuth-code binding's row says whether a token exists and for which
  // account, so the generic badge would only repeat it.
  const oauthRowStatesStatus = isOAuthCodeBinding && binding.fulfillment.mode !== 'simulated';
  const status = getApiStatus(binding, credentialsByKey, requiredVariables, isOAuthConnected);
  const displayBaseUrl = resolveBindingBaseUrl(definition, binding);
  const halfBuilt = isAuthHalfBuilt(binding);

  const inner = (
    <Column gap="3">
      {asCard && (
        <Row gap="2" align="center" wrap>
          <Icon name="plugs-connected" size="sm" />
          <Column gap="0" style={{ minWidth: 0, flex: 1 }}>
            <Text size="sm" weight="medium" truncate>
              {binding.name}
            </Text>
            <Text size="xs" color="secondary" truncate>
              {displayBaseUrl}
            </Text>
          </Column>
        </Row>
      )}

      <Row gap="2" align="center" wrap>
        {!oauthRowStatesStatus && <StatusBadge status={status} />}
        {binding.fulfillment.mode === 'simulated' ? (
          <Tooltip
            content={`Answered by simulation "${binding.fulfillment.simulationId}". Calls through this connection reach no external host.`}
          >
            <Badge variant="info">
              <Icon name="flask" size="xs" /> Simulated
            </Badge>
          </Tooltip>
        ) : (
          <Badge variant="neutral">{binding.authType}</Badge>
        )}
        {!binding.enabled && <Badge variant="warning">disabled</Badge>}
        {halfBuilt && (
          <Tooltip
            content={
              binding.authType === 'basic'
                ? 'Basic auth needs both a username and a password credential. Click Edit to add the missing one.'
                : 'OAuth2 client credentials needs both a client ID and a client secret. Click Edit to add the missing one.'
            }
          >
            <Badge variant="warning">
              <Icon name="warning-circle" size="xs" /> half-built
            </Badge>
          </Tooltip>
        )}
        {!readOnly && (
          <>
            <Tooltip content="Edit connection">
              <IconButton
                icon={<Icon name="pencil" size="sm" />}
                aria-label="Edit connection"
                onClick={() => {
                  onEditConnection(binding);
                }}
              />
            </Tooltip>
            <Tooltip content="Delete connection">
              <IconButton
                icon={<Icon name="trash" size="sm" />}
                aria-label="Delete connection"
                onClick={() => {
                  onDeleteConnection(binding);
                }}
              />
            </Tooltip>
          </>
        )}
      </Row>

      {/* For a templated connector the provider header shows the raw template, so
          surface the concrete resolved URL here too. */}
      {!asCard && definition.baseUrlTemplate && (
        <Text size="sm" color="secondary" truncate>
          {displayBaseUrl}
        </Text>
      )}

      {/* Credential pills — clickable badges that open the credential dialog. */}
      {binding.credentialKeys.length > 0 && (
        <Row gap="1" align="center" wrap>
          {binding.credentialKeys.map((key) => {
            const cred = credentialsByKey.get(key);
            const configured = cred?.hasValue;
            return (
              <Tooltip
                key={key}
                content={
                  configured
                    ? `${key} — configured`
                    : readOnly
                      ? `${key} — missing secret`
                      : `${key} — click to add your secret`
                }
              >
                <Badge
                  variant={configured ? 'success' : 'warning'}
                  {...(readOnly
                    ? {}
                    : {
                        style: { cursor: 'pointer' },
                        onClick: () => {
                          onAddSecret(key);
                        },
                      })}
                >
                  <Icon name={configured ? 'shield-check' : 'key'} size="xs" />
                  {key}
                </Badge>
              </Tooltip>
            );
          })}
        </Row>
      )}

      <DetailsSection label="Connection" rawJson={() => formatJson(binding)}>
        <BindingDetailsView binding={binding} />
      </DetailsSection>

      {!readOnly && status === 'needs_secret' && (
        <Text size="xs" color="muted">
          Click a missing-secret pill above (or Edit) to paste your secret.
        </Text>
      )}
      {!readOnly && !isOAuthCodeBinding && status === 'needs_setup' && (
        <Text size="xs" color="muted">
          Edit the connection to finish configuring authentication.
        </Text>
      )}
      {isOAuthCodeBinding && <OAuthConnectRow binding={binding} readOnly={readOnly} />}

      {simulation && (
        <>
          <Divider />
          {simulation}
        </>
      )}

      {repos && (
        <>
          <Divider />
          {repos}
        </>
      )}
    </Column>
  );

  if (!asCard) return inner;

  // Sunken surface-3 keeps the connection sub-card distinct from BOTH the provider
  // card (surface-2) and its own nested repo cards (surface-1).
  return (
    <Card style={{ backgroundColor: 'var(--color-surface-3)' }}>
      <CardBody>{inner}</CardBody>
    </Card>
  );
}
