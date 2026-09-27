'use client';

import { useId, useState } from 'react';
import { Column } from '@aflow/design-system';
import { PlacementSelect, SurfaceRow, SurfaceSection } from './surfaceRow.js';

export type BundlePlacement = 'always_on' | 'on_demand' | 'off';

export interface OfferedBundle {
  id: string;
  label: string;
  hint: string;
  tier: 'loaded' | 'on_demand';
  lockedReason?: string;
  defaultPlacement: BundlePlacement;
  /** Per-turn cost if every operation this bundle owns is pinned. */
  alwaysOnTokens: number;
  operationCount: number;
  /** What it costs while sitting at its authored default. */
  authoredPinnedTokens: number;
  authoredPinnedCount: number;
}

/**
 * What a bundle contributes to THIS turn.
 *
 * An explicit always_on pins everything it owns; left at its default it carries
 * only what the agent definition authored as pinned, which for a bundle spread
 * across both tiers is much less. Quoting the always-on figure in both cases
 * would have the panel's total disagree with what the turn actually carries.
 */
export function bundleCurrentCost(
  bundle: OfferedBundle,
  placements: Record<string, BundlePlacement>,
): { tools: number; tokens: number } {
  const explicit = bundle.lockedReason === undefined ? placements[bundle.id] : undefined;
  if (explicit === 'on_demand' || explicit === 'off') return { tools: 0, tokens: 0 };
  if (explicit === 'always_on')
    return { tools: bundle.operationCount, tokens: bundle.alwaysOnTokens };
  return bundlePlacementOf(bundle, placements) === 'always_on'
    ? { tools: bundle.authoredPinnedCount, tokens: bundle.authoredPinnedTokens }
    : { tools: 0, tokens: 0 };
}

const PLACEMENTS: ReadonlyArray<{ value: BundlePlacement; label: string }> = [
  { value: 'always_on', label: 'Always on' },
  { value: 'on_demand', label: 'On demand' },
  { value: 'off', label: 'Off' },
];

/**
 * Where a bundle actually sits: a locked bundle ignores anything stored for it,
 * and an unplaced one follows the platform default rather than a stored value.
 * Shared because the panel's pinned totals have to agree with the rows they are
 * counting.
 */
export function bundlePlacementOf(
  bundle: OfferedBundle,
  placements: Record<string, BundlePlacement>,
): BundlePlacement {
  if (bundle.lockedReason !== undefined) return 'always_on';
  return placements[bundle.id] ?? bundle.defaultPlacement;
}

/**
 * The capability rows of the tool panel.
 *
 * The three sections ARE the three placements, so changing a bundle moves its
 * row and the operator sees where a capability now lives. Every row quotes its
 * tool count and its always-on cost regardless of tier, because that is the
 * figure the decision to move it turns on.
 */
export function CapabilityBundleEditor({
  bundles,
  placements,
  showHints,
  onPlace,
}: {
  bundles: OfferedBundle[];
  placements: Record<string, BundlePlacement>;
  showHints: boolean;
  onPlace: (bundleId: string, placement: BundlePlacement) => void;
}) {
  // Scoped per mount, so a second editor on the page cannot hand two selects
  // the same id and steal the other's label clicks.
  const idPrefix = useId();
  // Off starts collapsed: it is the tier an operator scans least, and a long
  // list of things the agent cannot do should not be the first thing read.
  const [openSections, setOpenSections] = useState<Record<BundlePlacement, boolean>>({
    always_on: true,
    on_demand: true,
    off: false,
  });
  const toggle = (tier: BundlePlacement): void => {
    setOpenSections((prev) => ({ ...prev, [tier]: !prev[tier] }));
  };

  const placementOf = (b: OfferedBundle): BundlePlacement => bundlePlacementOf(b, placements);
  const inTier = (tier: BundlePlacement): OfferedBundle[] =>
    bundles.filter((b) => placementOf(b) === tier);

  const section = (tier: BundlePlacement, title: string, footnote?: string): React.ReactNode => {
    const rows = inTier(tier);
    const toolCount = rows.reduce(
      (s, b) =>
        s + (tier === 'always_on' ? bundleCurrentCost(b, placements).tools : b.operationCount),
      0,
    );
    return (
      <SurfaceSection
        title={title}
        count={rows.length}
        toolCount={toolCount}
        // Only always-on spends tokens per turn, so only it carries a price in
        // the header. Quoting one on the other tiers would imply a running cost
        // they do not have.
        {...(tier === 'always_on'
          ? { tokens: rows.reduce((s, b) => s + bundleCurrentCost(b, placements).tokens, 0) }
          : {})}
        open={openSections[tier]}
        onToggle={() => {
          toggle(tier);
        }}
        {...(footnote !== undefined ? { footnote } : {})}
      >
        {rows.map((b) => (
          <SurfaceRow
            key={b.id}
            label={b.label}
            sublabel={b.hint}
            showHint={showHints}
            // In Always on the row states what it costs now, so the rows sum to
            // the header and the header to the panel total. Elsewhere it states
            // what turning it on would cost, which is the number the operator
            // is weighing.
            toolCount={
              tier === 'always_on' ? bundleCurrentCost(b, placements).tools : b.operationCount
            }
            tokens={
              tier === 'always_on' ? bundleCurrentCost(b, placements).tokens : b.alwaysOnTokens
            }
            tokenPrefix={tier === 'always_on' ? undefined : '+'}
            {...(b.lockedReason === undefined ? { controlId: `${idPrefix}${b.id}` } : {})}
            control={
              // A locked bundle shows no control and no explanation. It sits in
              // Always on, which says what it is; a badge repeating that was
              // noise on the rows the operator can do least about.
              b.lockedReason !== undefined ? null : (
                <PlacementSelect
                  id={`${idPrefix}${b.id}`}
                  value={placementOf(b)}
                  options={PLACEMENTS}
                  ariaLabel={`Placement for ${b.label}`}
                  onChange={(p) => {
                    onPlace(b.id, p);
                  }}
                />
              )
            }
          />
        ))}
      </SurfaceSection>
    );
  };

  return (
    <Column gap="xs">
      {section('always_on', 'Always on')}
      {section('on_demand', 'On demand', 'Found and added when needed. Costs nothing until used.')}
      {section('off', 'Off', 'Not reachable at all.')}
    </Column>
  );
}
