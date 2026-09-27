'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Column, Icon, Row, Text } from '@aflow/design-system';
import { MAX_PINNED_TOOLS } from '@aflow/schemas';
import type { DirectiveCapabilityDiscovery, EntityDirectives } from '@aflow/schemas';
import { useCapabilityBundles } from '../../hooks/useCapabilityBundles.js';
import { useSpaceConnections } from '../../hooks/useSpaceConnections.js';
import { useAgentDirectives } from '../../hooks/useAgentDirectives.js';
import {
  connectionPlacements,
  placeConnection,
  pinnedToolsFor,
  setPinnedTools,
} from '../../lib/connection-placements.js';
import {
  CapabilityBundleEditor,
  bundleCurrentCost,
  type BundlePlacement,
} from './CapabilityBundleEditor.js';
import {
  ConnectionPlacementEditor,
  type ConnectionPlacement,
} from './ConnectionPlacementEditor.js';
import { formatTokens } from './surfaceRow.js';
import { AgentSettingsPopover, type AgentSettingsVariant } from './AgentSettingsPopover.js';

/**
 * What the agent can reach on a turn: which capability bundles are pinned into
 * the tool list, and which bound connections it transacts through. Bundles and
 * connections spend from one cap, so they are decided together and priced
 * against each other.
 */
export function AgentToolSettings({
  spaceId,
  open,
  onOpenChange,
  variant = 'chip',
}: {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: AgentSettingsVariant;
}) {
  const controller = useAgentDirectives(spaceId, open);
  // Off by default: seventeen capability descriptions plus every connection's
  // is a wall of prose in front of the controls, and the labels carry the
  // common case on their own.
  const [showHints, setShowHints] = useState(false);
  const { directives, edit } = controller;
  const {
    bundles: offeredBundles,
    loading: bundlesLoading,
    unavailable: bundlesUnavailable,
  } = useCapabilityBundles(open);
  // The placement handler needs the catalog to tell an explicit choice from the
  // platform default, and must not be re-created on every fetch.
  const offeredBundlesRef = useRef(offeredBundles);
  offeredBundlesRef.current = offeredBundles;
  const {
    connections,
    loading: connectionsLoading,
    unavailable: connectionsUnavailable,
  } = useSpaceConnections(spaceId, open);
  // Same reason as the bundle catalog: the placement handler has to materialize
  // the full connection list, and must not be re-created on every fetch.
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const onBundlePlace = useCallback(
    (bundleId: string, placement: BundlePlacement) => {
      edit((d): EntityDirectives => {
        const bundle = offeredBundlesRef.current.find((b) => b.id === bundleId);
        const current = { ...(d.capabilityDiscovery?.bundlePlacements ?? {}) };
        // Storing a value equal to the platform default would freeze this space
        // against a later change to that default, so an explicit match is
        // recorded as absence instead.
        if (placement === bundle?.defaultPlacement) delete current[bundleId];
        else current[bundleId] = placement;
        const nextDiscovery = { ...(d.capabilityDiscovery ?? {}) };
        if (Object.keys(current).length > 0) nextDiscovery.bundlePlacements = current;
        else delete nextDiscovery.bundlePlacements;
        return { ...d, capabilityDiscovery: nextDiscovery };
      });
    },
    [edit],
  );

  const onConnectionPlace = useCallback(
    (bindingId: string, placement: ConnectionPlacement) => {
      const connection = connectionsRef.current.find((c) => c.bindingId === bindingId);
      if (!connection) return;
      edit((d): EntityDirectives => {
        const nextDiscovery: DirectiveCapabilityDiscovery = { ...d.capabilityDiscovery };
        const nextConnections = placeConnection({
          stored: nextDiscovery.connections,
          connections: connectionsRef.current,
          connection,
          placement,
        });
        if (nextConnections === undefined) delete nextDiscovery.connections;
        else nextDiscovery.connections = nextConnections;
        return { ...d, capabilityDiscovery: nextDiscovery };
      });
    },
    [edit],
  );

  const onPinnedToolsChange = useCallback(
    (bindingId: string, toolNames: string[] | undefined) => {
      const connection = connectionsRef.current.find((c) => c.bindingId === bindingId);
      if (!connection) return;
      edit((d): EntityDirectives => {
        const nextDiscovery: DirectiveCapabilityDiscovery = { ...d.capabilityDiscovery };
        const nextConnections = setPinnedTools({
          stored: nextDiscovery.connections,
          connection,
          toolNames,
        });
        if (nextConnections === undefined) delete nextDiscovery.connections;
        else nextDiscovery.connections = nextConnections;
        return { ...d, capabilityDiscovery: nextDiscovery };
      });
    },
    [edit],
  );

  const storedConnections = directives?.capabilityDiscovery?.connections;
  const placements = useMemo(
    () => connectionPlacements(storedConnections, connections),
    [storedConnections, connections],
  );

  // Bundles and connections spend from ONE cap and one per-turn budget, so the
  // total is computed here, over both, and shown once at the top. Splitting it
  // per section would have each half quoting a number that is not the one the
  // assembler enforces.
  const bundlePlacements = directives?.capabilityDiscovery?.bundlePlacements;
  const storedConnectionsForTotals = directives?.capabilityDiscovery?.connections;
  const totals = useMemo(() => {
    const placementMap = (bundlePlacements ?? {}) as Record<string, BundlePlacement>;
    let tools = 0;
    let tokens = 0;
    // The same function the rows use, so the header can never disagree with
    // the list under it.
    for (const b of offeredBundles) {
      const cost = bundleCurrentCost(b, placementMap);
      tools += cost.tools;
      tokens += cost.tokens;
    }
    const connectionPlacementMap = connectionPlacements(storedConnectionsForTotals, connections);
    for (const c of connections) {
      const placement =
        connectionPlacementMap === null ? 'on_demand' : connectionPlacementMap[c.bindingId];
      if (placement !== 'always_on') continue;
      const names = pinnedToolsFor(storedConnectionsForTotals, c);
      const selected = names === null ? c.tools : c.tools.filter((t) => names.includes(t.name));
      tools += selected.length;
      tokens += selected.reduce((n, t) => n + t.tokens, 0);
    }
    return { tools, tokens, overCap: tools > MAX_PINNED_TOOLS };
  }, [offeredBundles, bundlePlacements, connections, storedConnectionsForTotals]);

  // A space with nothing bound has no connection to place, so the section stays
  // out of the panel. A list that failed to load is "unknown" rather than
  // empty and still renders, or the control disappears with nothing to say why.
  const showConnections = connectionsUnavailable || connectionsLoading || connections.length > 0;

  return (
    <AgentSettingsPopover
      open={open}
      onOpenChange={onOpenChange}
      variant={variant}
      icon="plugs-connected"
      title="Tools & integrations"
      controller={controller}
    >
      {(loaded) => (
        <>
          <Row
            align="center"
            justify="between"
            style={{
              padding: 'var(--space-2)',
              marginBottom: 'var(--space-2)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-surface-sunken)',
            }}
          >
            <Text
              size="sm"
              weight="semibold"
              style={{
                fontVariantNumeric: 'tabular-nums',
                ...(totals.overCap ? { color: 'var(--color-warning-default)' } : {}),
              }}
            >
              {totals.tools} of {MAX_PINNED_TOOLS} tools
            </Text>
            <Text size="sm" variant="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatTokens(totals.tokens)} tok / turn
            </Text>
          </Row>
          <Row justify="end" style={{ marginBottom: 'var(--space-1)' }}>
            <button
              type="button"
              onClick={() => {
                setShowHints((v) => !v);
              }}
              aria-pressed={showHints}
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                font: 'inherit',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-interactive-default)',
                cursor: 'pointer',
              }}
            >
              {showHints ? 'Hide descriptions' : 'Show descriptions'}
            </button>
          </Row>
          {totals.overCap && (
            <Text
              size="xs"
              style={{
                color: 'var(--color-warning-default)',
                display: 'block',
                marginBottom: 'var(--space-2)',
              }}
            >
              Over the limit. Move a capability or a connection to on demand — a turn cannot carry
              more than {MAX_PINNED_TOOLS} tools.
            </Text>
          )}
          <Column gap="xs">
            <Row align="center" gap="2">
              <Icon name="squares-four" size="sm" />
              <Text size="sm" weight="semibold">
                Capabilities
              </Text>
            </Row>
            {/* An unreadable catalog is "unknown", never "no capability" —
                hiding the section on error is indistinguishable from an agent
                that genuinely offers nothing, and gives the operator no sign
                the control exists at all. */}
            {bundlesUnavailable ? (
              <Text size="xs" variant="muted">
                Couldn’t load capabilities. Reopen this panel to retry.
              </Text>
            ) : bundlesLoading ? (
              <Text size="xs" variant="muted">
                Loading capabilities…
              </Text>
            ) : offeredBundles.length === 0 ? (
              <Text size="xs" variant="muted">
                This agent offers no adjustable capabilities.
              </Text>
            ) : (
              <CapabilityBundleEditor
                bundles={offeredBundles}
                placements={
                  (loaded.capabilityDiscovery?.bundlePlacements ?? {}) as Record<
                    string,
                    BundlePlacement
                  >
                }
                showHints={showHints}
                onPlace={onBundlePlace}
              />
            )}
          </Column>

          {showConnections && (
            <Column
              gap="xs"
              style={{
                marginTop: 'var(--space-3)',
                paddingTop: 'var(--space-2)',
                borderTop: '1px solid var(--color-border-subtle)',
              }}
            >
              <Row align="center" gap="2">
                <Icon name="plugs-connected" size="sm" />
                <Text size="sm" weight="semibold">
                  Connections
                </Text>
              </Row>
              {connectionsUnavailable ? (
                <Text size="xs" variant="muted">
                  Couldn’t load connections. Reopen this panel to retry.
                </Text>
              ) : connectionsLoading ? (
                <Text size="xs" variant="muted">
                  Loading connections…
                </Text>
              ) : (
                <ConnectionPlacementEditor
                  connections={connections}
                  placements={placements}
                  pinnedTools={Object.fromEntries(
                    connections.map((c) => [
                      c.bindingId,
                      pinnedToolsFor(loaded.capabilityDiscovery?.connections, c),
                    ]),
                  )}
                  showHints={showHints}
                  onPlace={onConnectionPlace}
                  onPinnedToolsChange={onPinnedToolsChange}
                />
              )}
            </Column>
          )}
        </>
      )}
    </AgentSettingsPopover>
  );
}
