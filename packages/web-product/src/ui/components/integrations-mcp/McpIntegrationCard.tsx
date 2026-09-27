'use client';

import { useMemo, useState, type ReactNode } from 'react';
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
import { ChipList, DetailRow, DetailsSection, formatJson } from '../integrations-api/helpers.js';
import { getMcpReadiness } from './mcpReadiness.js';
import type { McpReadiness } from './mcpReadiness.js';
import type { IntegrationCredentialMeta } from '../../hooks/use-integrations.js';
import type {
  McpBindingTestResult,
  McpServerBindingSummary,
  McpServerDefinitionSummary,
  McpToolFilter,
} from './use-mcp-integrations.js';

/**
 * Above this threshold the agent's pinned tool budget (MAX_TOTAL_TOOLS=50
 * in the orchestrator) is likely to blow when combined with core ops /
 * API endpoints. The badge flips to a warning + the card surfaces a hint
 * pointing the operator at the integration's Tool permissions.
 */
const MANY_TOOLS_WARN = 30;

function ReadinessBadge({ status }: { status: McpReadiness }) {
  switch (status) {
    case 'connected':
      return (
        <Badge variant="success">
          <Icon name="check-circle" size="xs" /> Connected
        </Badge>
      );
    case 'needs_secret':
      return (
        <Badge variant="warning">
          <Icon name="key" size="xs" /> Needs secret
        </Badge>
      );
    case 'not_connected':
      return (
        <Badge variant="warning">
          <Icon name="warning-circle" size="xs" /> Not connected
        </Badge>
      );
    case 'paused':
      return <Badge variant="neutral">Paused</Badge>;
    case 'no_connection':
      return <Badge variant="neutral">Not connected</Badge>;
  }
}

function effectiveToolNames(
  cachedToolNames: readonly string[],
  toolFilter: McpToolFilter | null | undefined,
): string[] {
  if (!toolFilter?.include || toolFilter.include.length === 0) {
    return [];
  }
  const includeSet = new Set(toolFilter.include);
  let filtered = cachedToolNames.filter((n) => includeSet.has(n));
  if (toolFilter.exclude && toolFilter.exclude.length > 0) {
    const excludeSet = new Set(toolFilter.exclude);
    filtered = filtered.filter((n) => !excludeSet.has(n));
  }
  return [...filtered];
}

/**
 * One card per MCP integration — collapses the prior two-level
 * "definition + binding" UI into a single surface. Each integration has
 * 0 or 1 connections; legacy multi-binding integrations show only the
 * first binding's status inline.
 *
 * The tool count is the **effective** count (after applying the
 * definition's `toolFilter`) — that's what the agent will see. The raw
 * cached count is surfaced as a parenthetical so operators can spot
 * filter mismatches.
 */
export function McpIntegrationCard({
  definition,
  /**
   * The integration's single connection, if any. If there are multiple
   * (legacy), the parent picks the first and passes it here.
   */
  binding,
  credentialsByKey,
  onEdit,
  onDelete,
  onConnect,
  onTest,
  kindBadge,
  readOnly = false,
}: {
  definition: McpServerDefinitionSummary;
  binding: McpServerBindingSummary | undefined;
  credentialsByKey: Map<string, IntegrationCredentialMeta>;
  onEdit: () => void;
  onDelete: () => void;
  /** Opens the form pre-set to add the auth (for integrations with no binding yet). */
  onConnect: () => void;
  /** Run mcp.binding.test against the connection. No-op when no binding. */
  onTest: () => Promise<McpBindingTestResult>;
  /** Optional badge rendered next to the name — used by the unified list to mark API vs MCP. */
  kindBadge?: ReactNode;
  /** Viewer-role rendering: status only, no mutation affordances (the server rejects those writes anyway). */
  readOnly?: boolean;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<McpBindingTestResult | null>(null);

  const readiness = getMcpReadiness(binding, credentialsByKey);

  const cachedCount = binding?.cachedToolCount ?? 0;
  const effectiveNames = useMemo(
    () => effectiveToolNames(binding?.cachedToolNames ?? [], definition.toolFilter),
    [binding?.cachedToolNames, definition.toolFilter],
  );
  const effectiveCount = binding?.cachedToolNames
    ? effectiveNames.length
    : // Pre-test: no cached names yet — fall back to the cached count so
      // the header badge can still narrate something useful.
      cachedCount;

  const includeList = definition.toolFilter?.include ?? [];
  const notPickedYet = includeList.length === 0;
  const filterReducedSurface =
    !notPickedYet && cachedCount > 0 && effectiveCount > 0 && effectiveCount < cachedCount;
  const filterNarrowedToZero = !notPickedYet && cachedCount > 0 && effectiveCount === 0;
  const overBudget = effectiveCount > MANY_TOOLS_WARN;

  const runRefresh = async () => {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const r = await onTest();
      setRefreshResult(r);
    } finally {
      setRefreshing(false);
    }
  };

  const toolBadgeTooltip = notPickedYet
    ? cachedCount > 0
      ? `No tools enabled. The agent will see zero tools until you pick some under Tool permissions (${String(cachedCount)} available).`
      : `No tools enabled. The agent will see zero tools until you connect and pick some under Tool permissions.`
    : filterNarrowedToZero
      ? `Server exposes ${String(cachedCount)} tools, but the Tool permissions filter doesn't match any of them — the agent currently sees zero tools.`
      : filterReducedSurface
        ? `Agent sees ${String(effectiveCount)} of ${String(cachedCount)} tools — narrowed by the Tool permissions filter.`
        : overBudget
          ? `This server exposes ${String(cachedCount)} tools — agents are capped at ~50 total. Narrow under Tool permissions.`
          : `${String(effectiveCount)} tool${effectiveCount === 1 ? '' : 's'} available to the agent.`;

  const toolBadgeVariant: 'danger' | 'warning' | 'success' | 'info' | 'neutral' = notPickedYet
    ? 'neutral'
    : filterNarrowedToZero
      ? 'danger'
      : overBudget
        ? 'warning'
        : filterReducedSurface
          ? 'success'
          : 'info';

  return (
    <Card style={{ backgroundColor: 'var(--color-surface-2)' }}>
      <CardBody>
        <Column gap="3">
          {/* Header row */}
          <Column gap="2" style={{ marginBottom: 'var(--space-xl)' }}>
            <Row gap="2" align="center" wrap>
              <ListingAvatar
                {...(definition.icon ? { icon: definition.icon } : {})}
                name={definition.name}
                kind="connector"
                seed={definition.serverId}
                size="md"
              />
              <Column gap="0" style={{ minWidth: 0, flex: 1 }}>
                <Row gap="2" align="center" wrap>
                  <Heading level={5}>{definition.name}</Heading>
                  {kindBadge}
                </Row>
                <Text size="sm" color="secondary" truncate>
                  {definition.serverUrl}
                </Text>
              </Column>
            </Row>
            <Row gap="2" align="center" wrap>
              <Badge variant="neutral">{definition.transport}</Badge>
              <Badge variant="neutral">{definition.source}</Badge>
              {definition.observedProtocolVersion && (
                <Tooltip content="MCP protocol version observed on last handshake">
                  <Badge variant="neutral">proto {definition.observedProtocolVersion}</Badge>
                </Tooltip>
              )}
              <ReadinessBadge status={readiness} />
              {binding && (
                <Tooltip content={toolBadgeTooltip}>
                  <Badge variant={toolBadgeVariant}>
                    {(filterNarrowedToZero || overBudget) && (
                      <Icon name="warning-circle" size="xs" />
                    )}
                    {filterReducedSurface || (notPickedYet && cachedCount > 0)
                      ? `${String(effectiveCount)} / ${String(cachedCount)} tools`
                      : `${String(effectiveCount)} ${effectiveCount === 1 ? 'tool' : 'tools'}`}
                  </Badge>
                </Tooltip>
              )}
              {!readOnly && binding && readiness === 'connected' && (
                <Tooltip content="Re-fetch the server's tool list">
                  <IconButton
                    icon={
                      refreshing ? (
                        <Icon name="spinner" size="sm" />
                      ) : (
                        <Icon name="refresh" size="sm" />
                      )
                    }
                    aria-label="Refresh tools"
                    onClick={() => void runRefresh()}
                  />
                </Tooltip>
              )}
              {!readOnly && (
                <>
                  <Tooltip content="Edit integration">
                    <IconButton
                      icon={<Icon name="pencil" size="sm" />}
                      aria-label="Edit integration"
                      onClick={onEdit}
                    />
                  </Tooltip>
                  <Tooltip content="Delete integration">
                    <IconButton
                      icon={<Icon name="trash" size="sm" />}
                      aria-label="Delete integration"
                      onClick={onDelete}
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

          {definition.tags.length > 0 && (
            <Row gap="1" wrap>
              {definition.tags.map((tag) => (
                <Badge key={tag} variant="neutral">
                  {tag}
                </Badge>
              ))}
            </Row>
          )}

          {/* Definition details — mirrors the API card's "API definition" section.
              Always available (no async fetch needed; the summary has everything
              we need). */}
          <DetailsSection label="Definition" rawJson={() => formatJson(definition)}>
            <DefinitionDetailsView definition={definition} />
          </DetailsSection>

          {/* Tools section — mirrors the API card's "Endpoints" section.
              Shows the effective tool names (after applying the definition's
              tool filter) so the operator sees the same surface the agent
              will see. Pre-test (no cachedToolNames), there's nothing to
              list, so we skip the section to avoid an empty caret. */}
          {binding?.cachedToolNames?.length ? (
            <ToolsSection
              cachedToolNames={binding.cachedToolNames}
              effectiveNames={effectiveNames}
              toolFilter={definition.toolFilter}
              cachedToolsAt={binding.cachedToolsAt}
            />
          ) : null}

          {/* Connect affordance when there's no binding yet — the just-created
              definition case. Mirrors the API card's connections row (divider
              + prompt). When a binding exists, the connection state is
              narrated via the readiness badge in the header + the hint text
              below, so no divider is needed. */}
          {!binding && (
            <>
              <Divider />
              <Row justify="between" align="center">
                <Text size="sm" color="secondary">
                  Add authentication to start using this integration.
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

          {/* Refresh-tools result narration */}
          {refreshResult && (
            <Text size="xs" tone={refreshResult.ok ? 'success' : 'danger'}>
              {refreshResult.ok
                ? `Refreshed — ${String(effectiveCount)} of ${String(cachedCount)} tools available to the agent.`
                : `Couldn't refresh: ${refreshResult.message ?? 'connection error'}`}
            </Text>
          )}

          {/* Readiness hints (only when there's a binding) */}
          {!readOnly && readiness === 'needs_secret' && (
            <Text size="xs" color="muted">
              Edit this integration and paste your secret to finish setup.
            </Text>
          )}
          {!readOnly && readiness === 'not_connected' && (
            <Text size="xs" color="muted">
              Edit this integration and save again to retry the handshake.
            </Text>
          )}

          {/* "No tools picked yet" — operator connected but hasn't curated
              what the agent can use. Default = none (opt-in semantics).
              This is the most common state right after a fresh connect. */}
          {!readOnly && notPickedYet && binding && readiness === 'connected' && (
            <Text size="xs" tone="warning">
              No tools enabled yet — the agent sees zero tools by default.
              {cachedCount > 0
                ? ` Edit this integration's `
                : ` Once the server's tool list is cached, edit this integration's `}
              <strong>Tool permissions</strong>
              {cachedCount > 0 ? ` to pick from the ${String(cachedCount)} available.` : '.'}
            </Text>
          )}

          {/* Filter-narrowed-to-zero — operator HAS curated but their
              names don't match the upstream's actual tool names (typos,
              stale list). Loud red signal. */}
          {filterNarrowedToZero && (
            <Text size="xs" tone="danger">
              The Tool permissions filter doesn't match any of the {String(cachedCount)} tools the
              upstream exposed. Edit this integration's <strong>Tool permissions</strong> to pick
              from the actual tool names.
            </Text>
          )}

          {/* Budget warning — effective count is approaching/exceeding the
              orchestrator's per-agent tool cap. */}
          {!filterNarrowedToZero && !notPickedYet && overBudget && (
            <Text size="xs" tone="warning">
              {String(effectiveCount)} tools available to the agent. Agents are capped at ~50 total
              tools — edit this integration's <strong>Tool permissions</strong> to narrow further.
            </Text>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}

/**
 * Definition fields rendered inside the "Definition" DetailsSection.
 * Mirrors the API card's `DefinitionDetailsView` shape: identifier, URL,
 * transport/source/version-equivalent badges, tags, timestamps.
 */
function DefinitionDetailsView({ definition }: { definition: McpServerDefinitionSummary }) {
  return (
    <Column gap="2">
      <DetailRow label="Server ID">
        <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
          {definition.serverId}
        </Text>
      </DetailRow>
      <DetailRow label="Server URL">
        <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)', wordBreak: 'break-all' }}>
          {definition.serverUrl}
        </Text>
      </DetailRow>
      <DetailRow label="Transport">
        <Badge variant="neutral">{definition.transport}</Badge>
      </DetailRow>
      <DetailRow label="Source">
        <Badge variant="neutral">{definition.source}</Badge>
      </DetailRow>
      {definition.observedProtocolVersion && (
        <DetailRow label="Protocol version">
          <Badge variant="neutral">{definition.observedProtocolVersion}</Badge>
        </DetailRow>
      )}
      {definition.tags.length > 0 && (
        <DetailRow label="Tags">
          <ChipList items={definition.tags} />
        </DetailRow>
      )}
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

/**
 * Expandable list of tool names the agent will see for this integration.
 * Mirrors the API card's "Endpoints" section. Each tool annotated with
 * whether it is op-task-only (per the definition's
 * `opTaskOnly` filter). Tools that are cached but filtered out
 * are listed under a muted "Filtered out" sub-section so the operator
 * can spot stale/wrong entries in their include list.
 */
function ToolsSection({
  cachedToolNames,
  effectiveNames,
  toolFilter,
  cachedToolsAt,
}: {
  cachedToolNames: readonly string[];
  effectiveNames: string[];
  toolFilter: McpToolFilter | null | undefined;
  cachedToolsAt: string | null;
}) {
  const effectiveSet = new Set(effectiveNames);
  const filteredOut = cachedToolNames.filter((n) => !effectiveSet.has(n));
  const opTaskOnly = new Set(toolFilter?.opTaskOnly ?? []);

  return (
    <DetailsSection
      label="Tools"
      count={effectiveNames.length}
      rawJson={() =>
        formatJson({
          effective: effectiveNames,
          filteredOut,
          toolFilter: toolFilter ?? null,
          cachedToolsAt,
        })
      }
    >
      <Column gap="2">
        {effectiveNames.length === 0 ? (
          <Text size="sm" color="secondary">
            No tools are exposed to the agent yet — pick some under Tool permissions.
          </Text>
        ) : (
          <Column gap="1">
            {effectiveNames.map((name) => (
              <Row key={name} gap="2" align="center" wrap>
                <Badge variant="info">tool</Badge>
                <Text
                  size="sm"
                  weight="medium"
                  style={{ fontFamily: 'var(--font-family-mono)', wordBreak: 'break-all' }}
                >
                  {name}
                </Text>
                {opTaskOnly.has(name) && (
                  <Tooltip content="Agents cannot call this tool directly — use a workflow operation task.">
                    <Badge variant="warning">
                      <Icon name="shield-check" size="xs" /> op-task-only
                    </Badge>
                  </Tooltip>
                )}
              </Row>
            ))}
          </Column>
        )}

        {filteredOut.length > 0 && (
          <>
            <Divider />
            <Text size="xs" weight="medium" color="secondary">
              Filtered out ({filteredOut.length})
            </Text>
            <Row gap="1" wrap>
              {filteredOut.map((name) => (
                <Badge key={name} variant="neutral">
                  <Text size="xs" style={{ fontFamily: 'var(--font-family-mono)' }}>
                    {name}
                  </Text>
                </Badge>
              ))}
            </Row>
          </>
        )}

        {cachedToolsAt && (
          <Text size="xs" color="muted">
            Cached {new Date(cachedToolsAt).toLocaleString()}
          </Text>
        )}
      </Column>
    </DetailsSection>
  );
}
