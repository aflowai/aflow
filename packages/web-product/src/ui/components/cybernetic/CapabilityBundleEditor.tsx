'use client';

import { useId } from 'react';
import { resolveToolPlacement } from '@aflow/schemas';
import { Column, Text } from '@aflow/design-system';
import { PlacementSelect, SurfaceRow } from './surfaceRow.js';

export type BundlePlacement = 'always_on' | 'on_demand' | 'off';
export interface OfferedBundle {
  id: string;
  label: string;
  hint: string;
  tier: 'loaded' | 'on_demand';
  parentId?: string;
  lockedReason?: string;
  defaultPlacement: 'always_on' | 'on_demand' | 'mixed';
  alwaysOnTokens: number;
  operationCount: number;
  authoredPinnedTokens: number;
  authoredPinnedCount: number;
  operations: Array<{ operationId: string; tokens: number; defaultPinned: boolean }>;
}

export function bundleCurrentCost(
  bundle: OfferedBundle,
  placements: Record<string, BundlePlacement>,
  operationPlacements: Record<string, BundlePlacement> = {},
): { tools: number; tokens: number } {
  return bundle.operations.reduce(
    (total, operation) => {
      const placement = resolveToolPlacement(
        {
          operationId: operation.operationId,
          bundleId: bundle.id,
          defaultPinned: operation.defaultPinned,
          locked: bundle.lockedReason !== undefined,
        },
        placements,
        operationPlacements,
      );
      return placement === 'always_on'
        ? { tools: total.tools + 1, tokens: total.tokens + operation.tokens }
        : total;
    },
    { tools: 0, tokens: 0 },
  );
}

export function bundlePlacementOf(
  bundle: OfferedBundle,
  placements: Record<string, BundlePlacement>,
) {
  return bundle.lockedReason
    ? bundle.defaultPlacement
    : (placements[bundle.id] ?? bundle.defaultPlacement);
}
const choices = [
  { value: 'default', label: 'Follow default' },
  { value: 'always_on', label: 'Always on' },
  { value: 'on_demand', label: 'On demand' },
  { value: 'off', label: 'Off' },
] as const;

export function CapabilityBundleEditor({
  bundles,
  placements,
  operationPlacements = {},
  showHints,
  onPlace,
  onOperationPlace,
}: {
  bundles: OfferedBundle[];
  placements: Record<string, BundlePlacement>;
  operationPlacements?: Record<string, BundlePlacement>;
  showHints: boolean;
  onPlace: (id: string, placement: BundlePlacement | undefined) => void;
  onOperationPlace?: (id: string, placement: BundlePlacement | undefined) => void;
}) {
  const prefix = useId();
  const parents = new Map<string, OfferedBundle[]>();
  for (const bundle of bundles) {
    const parent = bundle.parentId ?? bundle.id;
    parents.set(parent, [...(parents.get(parent) ?? []), bundle]);
  }
  const renderBundle = (bundle: OfferedBundle) => {
    const cost = bundleCurrentCost(bundle, placements, operationPlacements);
    const id = `${prefix}-${bundle.id}`;
    const selected = bundle.lockedReason ? undefined : placements[bundle.id];
    return (
      <SurfaceRow
        key={bundle.id}
        label={bundle.label}
        sublabel={bundle.hint}
        showHint={showHints}
        toolCount={cost.tools}
        tokens={cost.tokens}
        controlId={id}
        control={
          bundle.lockedReason ? (
            <Text size="xs" variant="muted">
              Required
            </Text>
          ) : (
            <PlacementSelect
              id={id}
              ariaLabel={`${bundle.label} placement`}
              value={selected ?? 'default'}
              options={choices.map((choice) =>
                choice.value === 'default' ? { ...choice, label: 'Default' } : choice,
              )}
              onChange={(value) => {
                onPlace(bundle.id, value === 'default' ? undefined : value);
              }}
            />
          )
        }
      >
        {!bundle.lockedReason && (
          <details style={{ paddingLeft: 'var(--space-2)' }}>
            <summary>
              <Text size="xs" variant="muted">
                {bundle.operationCount} available tools · {bundle.alwaysOnTokens} estimated tokens
                if all pinned
              </Text>
            </summary>
            {bundle.operations.map((operation) => (
              <div
                key={operation.operationId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-1) 0',
                }}
              >
                <Text size="xs" style={{ flex: 1, overflowWrap: 'anywhere' }}>
                  {operation.operationId} · {operation.tokens} tok
                </Text>
                <PlacementSelect
                  ariaLabel={`${operation.operationId} placement`}
                  value={operationPlacements[operation.operationId] ?? 'default'}
                  options={choices.map((choice) =>
                    choice.value === 'default'
                      ? {
                          ...choice,
                          label: `Group · ${selected?.replaceAll('_', ' ') ?? (operation.defaultPinned ? 'always on' : 'on demand')}`,
                        }
                      : choice,
                  )}
                  onChange={(value) =>
                    onOperationPlace?.(
                      operation.operationId,
                      value === 'default' ? undefined : value,
                    )
                  }
                />
              </div>
            ))}
          </details>
        )}
      </SurfaceRow>
    );
  };
  const parentPlacement = (children: OfferedBundle[]): string => {
    const states = new Set(
      children.flatMap((bundle) =>
        bundle.operations.map((operation) =>
          resolveToolPlacement(
            {
              operationId: operation.operationId,
              bundleId: bundle.id,
              defaultPinned: operation.defaultPinned,
              locked: bundle.lockedReason !== undefined,
            },
            placements,
            operationPlacements,
          ),
        ),
      ),
    );
    return states.size > 1
      ? 'Mixed'
      : (states.values().next().value ?? 'on_demand').replaceAll('_', ' ');
  };
  return (
    <Column gap="xs">
      <Text size="xs" variant="muted">
        On demand leaves schemas unloaded until promoted. Off removes tools from this agent.
        Estimates exclude history and discovery summaries.
      </Text>
      {[...parents].map(([parent, children]) =>
        children.length === 1 ? (
          renderBundle(children[0]!)
        ) : (
          <details key={parent}>
            <summary>
              <Text size="sm" weight="semibold">
                {parent.replaceAll('_', ' ')} · {parentPlacement(children)}
              </Text>
            </summary>
            {children.map(renderBundle)}
          </details>
        ),
      )}
    </Column>
  );
}
