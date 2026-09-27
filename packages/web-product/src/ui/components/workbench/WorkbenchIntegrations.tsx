'use client';

import { Column, ListingAvatar, Row, Text, Tooltip } from '@aflow/design-system';

import { spaceRoute } from '../../lib/space-routes.js';
import {
  useSpaceIntegrations,
  type IntegrationFamily,
  type IntegrationReadiness,
  type SpaceIntegration,
} from '../../hooks/use-space-integrations.js';
import { WorkbenchEmptyRow, WorkbenchSection } from './WorkbenchSection.js';

const KIND_LABEL: Record<SpaceIntegration['kind'], string> = {
  api: 'API',
  mcp: 'MCP server',
  repo: 'Repository',
};

/** What this kind actually grants — the distinction a chip can't draw on its own. */
const KIND_HINT: Record<SpaceIntegration['kind'], string> = {
  api: 'Endpoints the agent can call.',
  mcp: 'Tools the agent can call.',
  repo: 'Coding lane: clone, branch, push. Not the same as an API connection to the host.',
};

const FAMILY_CAPTION: Record<IntegrationFamily, string> = {
  callable: 'Endpoints & tools',
  code: 'Coding lane',
};

const FAMILY_ORDER: readonly IntegrationFamily[] = ['callable', 'code'];

const READINESS_DOT: Record<IntegrationReadiness, string> = {
  ready: 'var(--color-success-default)',
  attention: 'var(--color-warning-default)',
  error: 'var(--color-danger-default)',
  idle: 'var(--color-content-muted)',
};

/**
 * What the agent can reach (Plan 228 §3.3b) — promoted APIs, MCP servers, and
 * coding-lane repos as rows of chips.
 *
 * Deliberately flatter than Skills: an integration has no runs of its own, so
 * there is nothing to expand into. What the operator needs from this section is
 * inventory plus one bit of state — is this reachable, or is it waiting on me —
 * which a chip and a dot carry. The precise state is in the tooltip and the full
 * story is one new tab away, so the board spends almost no height on it.
 *
 * Chips are **grouped by family**, and only when both families are present. A
 * repo binding and an API connection to the same host look alike and read alike
 * while granting completely different authority, so the caption does the work the
 * chip cannot: `github` under "Endpoints & tools" calls GitHub's REST API,
 * `acme/platform` under "Coding lane" is a checkout the lane may push to.
 */
export function WorkbenchIntegrations({
  spaceId,
  spaceSlug,
}: {
  spaceId: string;
  spaceSlug: string;
}) {
  const { integrations, isLoading } = useSpaceIntegrations(spaceId);

  const empty = integrations.length === 0;
  if (empty && isLoading) return null;

  const families = FAMILY_ORDER.map((family) => ({
    family,
    items: integrations.filter((i) => i.family === family),
  })).filter((group) => group.items.length > 0);
  const captioned = families.length > 1;

  const needsAttention = integrations.filter(
    (i) => i.readiness === 'attention' || i.readiness === 'error',
  ).length;

  return (
    <WorkbenchSection
      title="Integrations"
      icon="plugs-connected"
      meta={
        needsAttention > 0 ? (
          <Text size="xs" style={{ color: 'var(--color-warning-default)' }}>
            {needsAttention} need{needsAttention === 1 ? 's' : ''} setup
          </Text>
        ) : null
      }
      // Both doors are the integrations surface rather than the store, because
      // connecting is promoting an API / adding an MCP server / binding a repo,
      // and only some of that starts from a catalog listing.
      link={{
        href: spaceRoute(spaceSlug, '/integrations'),
        label: empty ? 'Connect one' : 'Manage',
      }}
    >
      {empty ? (
        <WorkbenchEmptyRow label="No integrations yet" />
      ) : (
        <Column gap="sm">
          {families.map((group) => (
            <Column gap="xs" key={group.family}>
              {captioned && (
                <Text size="xs" variant="muted">
                  {FAMILY_CAPTION[group.family]}
                </Text>
              )}
              <Row gap="xs" wrap>
                {group.items.map((integration) => (
                  <IntegrationChip
                    key={integration.key}
                    integration={integration}
                    href={spaceRoute(spaceSlug, '/integrations')}
                  />
                ))}
              </Row>
            </Column>
          ))}
        </Column>
      )}
    </WorkbenchSection>
  );
}

function IntegrationChip({ integration, href }: { integration: SpaceIntegration; href: string }) {
  return (
    <Tooltip
      content={`${KIND_LABEL[integration.kind]} · ${integration.detail}. ${KIND_HINT[integration.kind]}`}
    >
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          maxWidth: 180,
          padding: '2px var(--space-2) 2px 2px',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-surface-2)',
          color: 'var(--color-text-primary)',
          textDecoration: 'none',
        }}
      >
        <ListingAvatar
          {...(integration.icon ? { icon: integration.icon } : {})}
          name={integration.name}
          kind={integration.avatarKind}
          seed={integration.key}
          size="sm"
          style={{ borderRadius: 'var(--radius-full)' }}
        />
        <Text size="xs" truncate style={{ minWidth: 0 }}>
          {integration.name}
        </Text>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: READINESS_DOT[integration.readiness],
          }}
        />
      </a>
    </Tooltip>
  );
}
