'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Column, Row, Text } from '@aflow/design-system';
import {
  MAX_PINNED_TOOLS,
  MAX_CAPABILITY_SCHEMA_TOKENS,
  resolveToolPlacement,
} from '@aflow/schemas';
import type { DirectiveCapabilityDiscovery, EntityDirectives } from '@aflow/schemas';
import { useCapabilityBundles } from '../../hooks/useCapabilityBundles.js';
import { useSpaceConnections } from '../../hooks/useSpaceConnections.js';

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
import { SkillPlacementEditor } from './SkillPlacementEditor.js';

/**
 * What the agent can reach on a turn: which capability bundles are pinned into
 * the tool list, and which bound connections it transacts through. Bundles and
 * connections spend from one cap, so they are decided together and priced
 * against each other.
 */
export function AgentCapabilitiesEditor({
  spaceId,
  directives,
  onChange,
  compact = false,
}: {
  spaceId: string;
  directives: EntityDirectives;
  onChange: (update: (current: EntityDirectives) => EntityDirectives) => void;
  compact?: boolean;
}) {
  const open = true;
  const loaded = directives;
  const edit = onChange;
  // Off by default: seventeen capability descriptions plus every connection's
  // is a wall of prose in front of the controls, and the labels carry the
  // common case on their own.
  const [showHints, setShowHints] = useState(false);
  const [view, setView] = useState<'tools' | 'skills' | 'connections'>('tools');
  const {
    bundles: offeredBundles,
    outputReadFloorTokens,
    loading: bundlesLoading,
    unavailable: bundlesUnavailable,
  } = useCapabilityBundles(spaceId, open, directives.capabilityDiscovery.helmsmanOperations);
  const {
    connections,
    loading: connectionsLoading,
    unavailable: connectionsUnavailable,
  } = useSpaceConnections(spaceId, open);
  // A stable callback must read the current binding inventory.
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;

  const onBundlePlace = useCallback(
    (bundleId: string, placement: BundlePlacement | undefined) => {
      edit((d): EntityDirectives => {
        const current = { ...(d.capabilityDiscovery.bundlePlacements ?? {}) };
        if (placement === undefined) delete current[bundleId];
        else current[bundleId] = placement;
        const nextOperations = { ...d.capabilityDiscovery.operationPlacements };
        for (const op of offeredBundles.find((b) => b.id === bundleId)?.operations ?? [])
          delete nextOperations[op.operationId];
        const nextDiscovery = { ...d.capabilityDiscovery, operationPlacements: nextOperations };
        if (Object.keys(current).length > 0) nextDiscovery.bundlePlacements = current;
        else delete nextDiscovery.bundlePlacements;
        return { ...d, capabilityDiscovery: nextDiscovery };
      });
    },
    [edit, offeredBundles],
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

  const storedConnections = directives.capabilityDiscovery.connections;
  const placements = useMemo(
    () => connectionPlacements(storedConnections, connections),
    [storedConnections, connections],
  );

  // Bundles and connections spend from ONE cap and one per-turn budget, so the
  // total is computed here, over both, and shown once at the top. Splitting it
  // per section would have each half quoting a number that is not the one the
  // assembler enforces.
  const bundlePlacements = directives.capabilityDiscovery.bundlePlacements;
  const storedConnectionsForTotals = directives.capabilityDiscovery.connections;
  const totals = useMemo(() => {
    const placementMap = (bundlePlacements ?? {}) as Record<string, BundlePlacement>;
    let tools = 0;
    let tokens = 0;
    let hasOutputReader = false;
    // The same function the rows use, so the header can never disagree with
    // the list under it.
    for (const b of offeredBundles) {
      const cost = bundleCurrentCost(
        b,
        placementMap,
        directives.capabilityDiscovery.operationPlacements,
      );
      tools += cost.tools;
      tokens += cost.tokens;
      hasOutputReader ||= b.operations.some((op) => {
        if (
          op.operationId !== 'memory.store.get' &&
          !op.operationId.startsWith('memory.run_output.')
        )
          return false;
        const placement = resolveToolPlacement(
          {
            operationId: op.operationId,
            bundleId: b.id,
            defaultPinned: op.defaultPinned,
            locked: b.lockedReason !== undefined,
          },
          placementMap,
          directives.capabilityDiscovery.operationPlacements,
        );
        return placement === 'always_on';
      });
    }
    if (!hasOutputReader && offeredBundles.length) {
      tools++;
      tokens += outputReadFloorTokens;
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
    return {
      tools,
      tokens,
      overCap: tools > MAX_PINNED_TOOLS || tokens > MAX_CAPABILITY_SCHEMA_TOKENS,
    };
  }, [
    offeredBundles,
    outputReadFloorTokens,
    bundlePlacements,
    connections,
    storedConnectionsForTotals,
    directives.capabilityDiscovery.operationPlacements,
  ]);

  // A space with nothing bound has no connection to place, so the section stays
  // out of the panel. A list that failed to load is "unknown" rather than
  // empty and still renders, or the control disappears with nothing to say why.
  const showConnections = connectionsUnavailable || connectionsLoading || connections.length > 0;

  return (
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
          ~{formatTokens(totals.tokens)} / {formatTokens(MAX_CAPABILITY_SCHEMA_TOKENS)} schema tok
        </Text>
      </Row>
      <div
        role="group"
        aria-label="Capability type"
        style={{
          display: 'flex',
          gap: 'var(--space-1)',
          padding: 'var(--space-1)',
          marginBottom: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface-sunken)',
        }}
      >
        {(
          [
            ['tools', 'Tool groups'],
            ['skills', 'Skills'],
            ...(showConnections ? [['connections', 'Connections']] : []),
          ] as Array<['tools' | 'skills' | 'connections', string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => {
              setView(key);
            }}
            style={{
              flex: 1,
              padding: 'var(--space-2)',
              border: 0,
              borderRadius: 'var(--radius-sm)',
              font: 'inherit',
              fontSize: 'var(--font-size-sm)',
              fontWeight: view === key ? 600 : 400,
              color: 'inherit',
              background: view === key ? 'var(--color-surface-raised)' : 'transparent',
              cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {view !== 'skills' && (
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
      )}
      {totals.overCap && (
        <Text
          size="xs"
          style={{
            color: 'var(--color-warning-default)',
            display: 'block',
            marginBottom: 'var(--space-2)',
          }}
        >
          Over the limit. Move a capability or a connection to on demand — a turn cannot carry more
          than {MAX_PINNED_TOOLS} pinned tools or {MAX_CAPABILITY_SCHEMA_TOKENS} schema tokens.
        </Text>
      )}
      <div
        style={
          compact
            ? { maxHeight: 'min(36vh, 320px)', overflowY: 'auto', paddingRight: 'var(--space-1)' }
            : undefined
        }
      >
        {view === 'tools' && (
          <Column gap="xs">
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
                  (loaded.capabilityDiscovery.bundlePlacements ?? {}) as Record<
                    string,
                    BundlePlacement
                  >
                }
                showHints={showHints}
                operationPlacements={directives.capabilityDiscovery.operationPlacements ?? {}}
                onOperationPlace={(id, placement) => {
                  edit((d) => {
                    const next = { ...d.capabilityDiscovery.operationPlacements };
                    const bundle = offeredBundles.find((entry) =>
                      entry.operations.some((op) => op.operationId === id),
                    );
                    const groups = { ...d.capabilityDiscovery.bundlePlacements };
                    if (
                      bundle &&
                      groups[bundle.id] === 'off' &&
                      placement !== undefined &&
                      placement !== 'off'
                    ) {
                      for (const op of bundle.operations) next[op.operationId] = 'off';
                      groups[bundle.id] = 'on_demand';
                    }
                    if (placement === undefined) delete next[id];
                    else next[id] = placement;
                    return {
                      ...d,
                      capabilityDiscovery: {
                        ...d.capabilityDiscovery,
                        bundlePlacements: groups,
                        operationPlacements: next,
                      },
                    };
                  });
                }}
                onPlace={onBundlePlace}
              />
            )}
            <Text size="xs" variant="muted">
              Required groups stay on. Costs show full groups; only loaded tools use the budget.
            </Text>
          </Column>
        )}

        {view === 'connections' && showConnections && (
          <Column
            gap="xs"
            style={{
              marginTop: 'var(--space-3)',
              paddingTop: 'var(--space-2)',
              borderTop: '1px solid var(--color-border-subtle)',
            }}
          >
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
                    pinnedToolsFor(loaded.capabilityDiscovery.connections, c),
                  ]),
                )}
                showHints={showHints}
                onPlace={onConnectionPlace}
                onPinnedToolsChange={onPinnedToolsChange}
              />
            )}
          </Column>
        )}
        {view === 'skills' && (
          <SkillPlacementEditor
            spaceId={spaceId}
            placements={directives.capabilityDiscovery.skillPlacements ?? {}}
            onPlace={(slug, placement) => {
              edit((d) => {
                const next = { ...d.capabilityDiscovery.skillPlacements };
                if (placement === undefined) delete next[slug];
                else next[slug] = placement;
                return {
                  ...d,
                  capabilityDiscovery: { ...d.capabilityDiscovery, skillPlacements: next },
                };
              });
            }}
          />
        )}
      </div>
    </>
  );
}
