'use client';

import { useId, useState } from 'react';
import { Button, Column, Icon, Row, Text } from '@aflow/design-system';
import { type DirectiveConnectionRef, type SpaceConnection } from '@aflow/schemas';
import { formatToolTokens, PlacementSelect, SurfaceRow } from './surfaceRow.js';

export type { SpaceConnection };

export type ConnectionPlacement = DirectiveConnectionRef['placement'];

// Two rather than the bundles' three: a connection leaves the agent's reach by
// leaving the stored list, not by a placement value.
const CONNECTION_PLACEMENTS: ReadonlyArray<{ value: ConnectionPlacement; label: string }> = [
  { value: 'always_on', label: 'Always on' },
  { value: 'on_demand', label: 'On demand' },
];

/**
 * The connection rows of the capability panel.
 *
 * Two placements rather than the bundles' three: a connection's reach is
 * governed by the list this control writes into, so there is no `off` to
 * choose here — placement moves a reachable connection between the pinned tier
 * and discovery, and only the pinned tier costs tokens.
 *
 * The running total lives at the top of the panel rather than here: it counts
 * bundles and connections together, and a combined figure sitting inside one of
 * the two things it counts read as if it were only about connections.
 */
export function ConnectionPlacementEditor({
  connections,
  placements,
  pinnedTools,
  showHints,
  onPlace,
  onPinnedToolsChange,
}: {
  connections: SpaceConnection[];
  /** Placement per binding; `null` when this agent has no stored connection list. */
  placements: Record<string, ConnectionPlacement> | null;
  /** Per binding, the tools pinned; `null` pins all of them. */
  pinnedTools: Record<string, string[] | null>;
  showHints: boolean;
  onPlace: (bindingId: string, placement: ConnectionPlacement) => void;
  onPinnedToolsChange: (bindingId: string, toolNames: string[] | undefined) => void;
}) {
  // `null` marks a connection the stored list leaves out: the space has it
  // bound, this agent cannot reach it.
  const placementOf = (c: SpaceConnection): ConnectionPlacement | null =>
    placements === null ? 'on_demand' : (placements[c.bindingId] ?? null);

  return (
    <Column gap="none">
      {connections.map((c) => (
        <ConnectionRow
          key={c.bindingId}
          connection={c}
          placement={placementOf(c)}
          pinnedTools={pinnedTools[c.bindingId] ?? null}
          showHints={showHints}
          onPlace={onPlace}
          onPinnedToolsChange={onPinnedToolsChange}
        />
      ))}
    </Column>
  );
}

function ConnectionRow({
  connection,
  placement,
  pinnedTools,
  showHints,
  onPlace,
  onPinnedToolsChange,
}: {
  connection: SpaceConnection;
  placement: ConnectionPlacement | null;
  pinnedTools: string[] | null;
  showHints: boolean;
  onPlace: (bindingId: string, placement: ConnectionPlacement) => void;
  onPinnedToolsChange: (bindingId: string, toolNames: string[] | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const placementId = useId();
  // Out of reach and unusable are different answers. Blocked hides the control,
  // because setting it would pin nothing. Out of the list keeps it: this panel
  // is the only writer of the list, so the control is the way back in.
  const reason =
    connection.blockedReason ??
    (placement === null ? 'Outside this agent’s reach — always on adds it back.' : undefined);
  const alwaysOn = placement === 'always_on';
  const selected =
    pinnedTools === null
      ? connection.tools
      : connection.tools.filter((t) => pinnedTools.includes(t.name));

  // A blocked or out-of-reach reason is never hidden behind the toggle: it
  // explains why a control is missing, which the operator needs unprompted.
  // Only the descriptive hint is opt-in.
  const reasonProps =
    reason !== undefined ? { sublabel: reason, showHint: true } : { showHint: showHints };

  return (
    <SurfaceRow
      label={connection.label}
      {...reasonProps}
      toolCount={alwaysOn ? selected.length : connection.toolCount}
      tokens={alwaysOn ? selected.reduce((n, t) => n + t.tokens, 0) : connection.alwaysOnTokens}
      // Only a genuinely unusable connection is dimmed. Being on demand is a
      // normal, chosen state — dimming it read as broken.
      {...(connection.blockedReason !== undefined ? { dimmed: true } : {})}
      {...(connection.blockedReason === undefined ? { controlId: placementId } : {})}
      control={
        connection.blockedReason !== undefined ? null : (
          <PlacementSelect
            id={placementId}
            value={alwaysOn ? 'always_on' : 'on_demand'}
            options={CONNECTION_PLACEMENTS}
            ariaLabel={`Placement for ${connection.label}`}
            onChange={(p) => {
              onPlace(connection.bindingId, p);
            }}
          />
        )
      }
    >
      {alwaysOn && connection.tools.length > 1 && (
        <ToolSubset
          connection={connection}
          pinnedTools={pinnedTools}
          open={open}
          onToggleOpen={() => {
            setOpen((v) => !v);
          }}
          onPlace={onPlace}
          onPinnedToolsChange={onPinnedToolsChange}
        />
      )}
    </SurfaceRow>
  );
}

/**
 * Which of a pinned connection's tools occupy the tier.
 *
 * Collapsed by default and only offered once the connection is always-on:
 * choosing tools for a connection that pins none is a decision about nothing,
 * and most connections are small enough that the whole set is the right answer.
 * It earns its place on the ones that are not — a broker with twenty endpoints
 * can exhaust the cap by itself.
 *
 * Clearing the last tool switches the connection back to on demand rather than
 * storing an empty selection, so the panel cannot produce a connection that
 * claims to be always-on while carrying nothing.
 */
function ToolSubset({
  connection,
  pinnedTools,
  open,
  onToggleOpen,
  onPlace,
  onPinnedToolsChange,
}: {
  connection: SpaceConnection;
  pinnedTools: string[] | null;
  open: boolean;
  onToggleOpen: () => void;
  onPlace: (bindingId: string, placement: ConnectionPlacement) => void;
  onPinnedToolsChange: (bindingId: string, toolNames: string[] | undefined) => void;
}) {
  const isOn = (name: string): boolean => pinnedTools === null || pinnedTools.includes(name);
  const selectedCount = connection.tools.filter((t) => isOn(t.name)).length;

  const toggle = (name: string): void => {
    const next = connection.tools.filter((t) => (t.name === name ? !isOn(t.name) : isOn(t.name)));
    if (next.length === 0) {
      onPlace(connection.bindingId, 'on_demand');
      onPinnedToolsChange(connection.bindingId, undefined);
      return;
    }
    onPinnedToolsChange(
      connection.bindingId,
      next.length === connection.tools.length ? undefined : next.map((t) => t.name),
    );
  };

  return (
    <Column gap="none" style={{ paddingBottom: 'var(--space-1)' }}>
      <Row justify="between" align="center">
        <Button size="sm" variant="ghost" onClick={onToggleOpen} aria-expanded={open}>
          <Row gap="1" align="center">
            <Icon name={open ? 'caret-down' : 'caret-right'} size="xs" />
            <Text size="xs" variant="muted">
              {selectedCount === connection.tools.length
                ? `All ${String(connection.tools.length)} tools`
                : `${String(selectedCount)} of ${String(connection.tools.length)} tools`}
            </Text>
          </Row>
        </Button>
      </Row>
      {open && (
        <Column gap="none" style={{ paddingLeft: 'var(--space-4)' }}>
          {connection.tools.map((t) => (
            <Row key={t.name} align="center" gap="2" style={{ padding: '2px 0' }}>
              <input
                type="checkbox"
                id={`${connection.bindingId}-${t.name}`}
                checked={isOn(t.name)}
                onChange={() => {
                  toggle(t.name);
                }}
              />
              <Text size="xs" style={{ flex: 1, minWidth: 0 }}>
                <label htmlFor={`${connection.bindingId}-${t.name}`}>{t.label}</label>
              </Text>
              <Text size="xs" variant="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatToolTokens(t.tokens)} tok
              </Text>
            </Row>
          ))}
        </Column>
      )}
    </Column>
  );
}
