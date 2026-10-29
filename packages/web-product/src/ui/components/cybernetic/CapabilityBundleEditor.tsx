'use client';

import { useId, useState } from 'react';
import { resolveToolPlacement } from '@aflow/schemas';
import { Column, Input, Text } from '@aflow/design-system';
import { PlacementSelect, SurfaceRow } from './surfaceRow.js';
import { PlacementSection, placementLabels } from './PlacementSection.js';

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
  operationPlacements: Record<string, BundlePlacement> = {},
): BundlePlacement | 'mixed' {
  const states = new Set(
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
  );
  return states.size > 1 ? 'mixed' : (states.values().next().value ?? bundle.defaultPlacement);
}

/**
 * A bundle whose `parentId` names another offered bundle sits under it, so a
 * group split out of another (Build artifacts out of Visuals) reads beside it
 * rather than wherever its label sorts. Other `parentId` values are family keys
 * with no row of their own, and those bundles stay top-level. Only bundles
 * passed together nest: a child placed in a different section than its parent
 * stands alone in that section. Nesting is one level deep.
 */
export function nestBundles(
  bundles: readonly OfferedBundle[],
): Array<{ bundle: OfferedBundle; children: OfferedBundle[] }> {
  const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const parentOf = (bundle: OfferedBundle): OfferedBundle | undefined =>
    bundle.parentId === undefined || bundle.parentId === bundle.id
      ? undefined
      : byId.get(bundle.parentId);
  const nestedUnder = (bundle: OfferedBundle): string | undefined => {
    const parent = parentOf(bundle);
    return parent && !parentOf(parent) ? parent.id : undefined;
  };
  const byLabel = (a: OfferedBundle, b: OfferedBundle) => a.label.localeCompare(b.label);
  return bundles
    .filter((bundle) => nestedUnder(bundle) === undefined)
    .sort(byLabel)
    .map((bundle) => ({
      bundle,
      children: bundles.filter((child) => nestedUnder(child) === bundle.id).sort(byLabel),
    }));
}

const choices = [
  { value: 'always_on', label: 'Always on' },
  { value: 'on_demand', label: 'On demand' },
  { value: 'off', label: 'Off' },
] as const;
const sections = [
  {
    state: 'always_on',
    description: 'Loaded on every turn. These tools use the schema budget above.',
  },
  { state: 'on_demand', description: 'Discoverable by Helmsman and loaded only when needed.' },
  { state: 'off', description: 'Hidden from Helmsman, including capability discovery.' },
  {
    state: 'mixed',
    description:
      'Tools within these groups have different placements. Expand a group to review them.',
  },
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
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const filtered = bundles.filter((bundle) =>
    [bundle.label, bundle.id, bundle.hint, ...bundle.operations.map((op) => op.operationId)].some(
      (text) => text.toLowerCase().includes(search),
    ),
  );
  return (
    <Column gap="xs">
      <Input
        type="search"
        aria-label="Search tool groups"
        placeholder="Search groups or tools…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      {sections.map(({ state, description }) => {
        const entries = filtered.filter(
          (bundle) => bundlePlacementOf(bundle, placements, operationPlacements) === state,
        );
        if ((state === 'mixed' || search) && !entries.length) return null;
        return (
          <PlacementSection
            key={`${state}-${search}`}
            title={placementLabels[state]}
            count={entries.length}
            description={description}
            forceOpen={search.length > 0}
          >
            {nestBundles(entries).map(({ bundle, children }) => {
              const row = (entry: OfferedBundle) => (
                <BundleRow
                  key={`${entry.id}-${search}`}
                  bundle={entry}
                  placements={placements}
                  operationPlacements={operationPlacements}
                  showHints={showHints}
                  search={search}
                  onPlace={onPlace}
                  {...(onOperationPlace ? { onOperationPlace } : {})}
                />
              );
              if (!children.length) return row(bundle);
              return (
                <div key={`${bundle.id}-family-${search}`}>
                  {row(bundle)}
                  <div
                    role="group"
                    aria-label={`Within ${bundle.label}`}
                    style={{
                      marginLeft: 'var(--space-4)',
                      paddingLeft: 'var(--space-3)',
                      borderLeft: '2px solid var(--color-border-subtle)',
                    }}
                  >
                    {children.map(row)}
                  </div>
                </div>
              );
            })}
          </PlacementSection>
        );
      })}
      {search && !filtered.length && (
        <Text size="sm" variant="muted">
          No matching groups or tools.
        </Text>
      )}
    </Column>
  );
}

function BundleRow({
  bundle,
  placements,
  operationPlacements,
  showHints,
  search,
  onPlace,
  onOperationPlace,
}: {
  bundle: OfferedBundle;
  placements: Record<string, BundlePlacement>;
  operationPlacements: Record<string, BundlePlacement>;
  showHints: boolean;
  search: string;
  onPlace: (id: string, placement: BundlePlacement | undefined) => void;
  onOperationPlace?: (id: string, placement: BundlePlacement | undefined) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<boolean | undefined>();
  const open = expanded ?? search.length > 0;
  const locked = bundle.lockedReason !== undefined;
  const custom =
    !locked && bundle.operations.some((op) => operationPlacements[op.operationId] !== undefined);
  const selected = locked ? 'always_on' : custom ? 'custom' : (placements[bundle.id] ?? 'default');
  const cost = bundleCurrentCost(bundle, placements, operationPlacements);
  return (
    <SurfaceRow
      label={bundle.label}
      sublabel={bundle.hint}
      showHint={showHints}
      toolCount={bundle.operationCount}
      tokens={bundle.alwaysOnTokens}
      annotation={locked ? 'Required' : cost.tools ? `${cost.tools} loaded` : 'unloaded'}
      onToggle={() => {
        setExpanded(!open);
      }}
      expanded={open}
      control={
        <PlacementSelect<BundlePlacement | 'default' | 'custom'>
          id={id}
          ariaLabel={`${bundle.label} placement`}
          value={selected}
          disabled={locked}
          {...(locked ? { title: bundle.lockedReason } : {})}
          options={[
            { value: 'default', label: `${placementLabels[bundle.defaultPlacement]} · default` },
            ...(custom
              ? [{ value: 'custom' as const, label: 'Custom tools', disabled: true }]
              : []),
            ...choices,
          ]}
          onChange={(value) => {
            if (value !== 'custom') onPlace(bundle.id, value === 'default' ? undefined : value);
          }}
        />
      }
    >
      {open && (
        <div
          style={{
            marginLeft: 'var(--space-4)',
            paddingLeft: 'var(--space-3)',
            marginTop: 'var(--space-2)',
            borderLeft: '2px solid var(--color-border-subtle)',
          }}
        >
          {locked && (
            <Text as="div" size="xs" variant="muted">
              {bundle.lockedReason}
            </Text>
          )}
          {bundle.operations.map((operation) => {
            const inherited = resolveToolPlacement(
              {
                operationId: operation.operationId,
                bundleId: bundle.id,
                defaultPinned: operation.defaultPinned,
                locked,
              },
              placements,
              {},
            );
            return (
              <SurfaceRow
                key={operation.operationId}
                label={operation.operationId}
                toolCount={1}
                tokens={operation.tokens}
                control={
                  <PlacementSelect
                    ariaLabel={`${operation.operationId} placement`}
                    disabled={locked || !onOperationPlace}
                    value={
                      locked ? 'default' : (operationPlacements[operation.operationId] ?? 'default')
                    }
                    options={[
                      { value: 'default', label: `${placementLabels[inherited]} · group` },
                      ...choices,
                    ]}
                    onChange={(value) =>
                      onOperationPlace?.(
                        operation.operationId,
                        value === 'default' ? undefined : value,
                      )
                    }
                  />
                }
              />
            );
          })}
        </div>
      )}
    </SurfaceRow>
  );
}
