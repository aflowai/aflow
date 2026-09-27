'use client';

import { type CSSProperties, type ComponentType, type HTMLAttributes } from 'react';
import * as PhosphorIcons from '@phosphor-icons/react';
import { AppWindowIcon } from '@phosphor-icons/react/dist/csr/AppWindow';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { PlugIcon } from '@phosphor-icons/react/dist/csr/Plug';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { StackIcon } from '@phosphor-icons/react/dist/csr/Stack';
import type { IconRef } from '@aflow/schemas';

import { resolveBrandAsset } from '../brand/index.js';
import { Icon, type PhosphorIconProps } from '../icons/Icon.js';

export type ListingAvatarSize = 'sm' | 'md' | 'lg' | 'xl';
/**
 * `repo` is not a store listing — a coding-lane repo is bound by an operator,
 * never installed from the catalog. It is here because the avatar is also how
 * *installed* integrations are identified, and a repo has to be visibly a
 * different thing from an API connection to the same host: a GitHub repo binding
 * and the GitHub REST connector must not both come out wearing the GitHub mark.
 *
 * `agent` is likewise not a listing — an operator authors it — but it shares the
 * surface, and an agent must not read as a skill: one is invoked, the other is
 * talked to.
 */
export type ListingAvatarKind = 'skill' | 'bundle' | 'connector' | 'applet' | 'repo' | 'agent';

export interface ListingAvatarProps extends HTMLAttributes<HTMLDivElement> {
  /** Listing icon; absent renders the deterministic identicon fallback */
  icon?: IconRef;
  /** Accessible listing name — the name is already shown alongside the avatar, so the
   * fallback deliberately does not repeat it as initials */
  name: string;
  /** Listing kind — picks the corner glyph on the fallback tile */
  kind: ListingAvatarKind;
  /** Stable identity (catalogId) the fallback identicon pattern derives from */
  seed: string;
  /** Size preset */
  size?: ListingAvatarSize;
}

const sizeMap: Record<ListingAvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 40,
  xl: 64,
};

const radiusMap: Record<ListingAvatarSize, string> = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-md)',
  xl: 'var(--radius-lg)',
};

const KIND_GLYPHS: Record<ListingAvatarKind, ComponentType<PhosphorIconProps>> = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  skill: SparkleIcon,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  bundle: StackIcon,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  connector: PlugIcon,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  applet: AppWindowIcon,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  repo: GitBranchIcon,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  agent: RobotIcon,
};

/** FNV-1a — tiny, stable across runtimes, well-distributed for short ids */
export function hashListingSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const IDENTICON_ROWS = 5;

/**
 * A 5x5, left-right symmetric grid of filled cells derived from the seed — an
 * abstract mark for a listing with no artwork of its own. Symmetric rather than
 * fully random so it reads as a deliberate glyph instead of noise, the same
 * trick behind GitHub's and Gravatar's default avatars.
 */
export function listingIdenticonCells(seed: string): ReadonlyArray<readonly boolean[]> {
  const hash = hashListingSeed(seed);
  const rows: boolean[][] = [];
  let bit = 0;
  for (let r = 0; r < IDENTICON_ROWS; r++) {
    const outer = ((hash >>> bit) & 1) === 1;
    bit++;
    const inner = ((hash >>> bit) & 1) === 1;
    bit++;
    const axis = ((hash >>> bit) & 1) === 1;
    bit++;
    rows.push([outer, inner, axis, inner, outer]);
  }
  return rows;
}

function resolvePhosphorGlyph(name: string): ComponentType<PhosphorIconProps> | undefined {
  const pascal = name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  if (!pascal) return undefined;
  const catalog = PhosphorIcons as unknown as Record<
    string,
    ComponentType<PhosphorIconProps> | undefined
  >;
  return catalog[pascal] ?? catalog[`${pascal}Icon`];
}

export function ListingAvatar({
  icon,
  name,
  kind,
  seed,
  size = 'md',
  className = '',
  style,
  ...props
}: ListingAvatarProps) {
  const px = sizeMap[size];
  const classNames = ['ds-listing-avatar', `ds-listing-avatar--${size}`, className]
    .filter(Boolean)
    .join(' ');
  const tileBase: CSSProperties = {
    width: px,
    height: px,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radiusMap[size],
    position: 'relative',
  };
  const glyphPx = Math.round(px * 0.6);

  if (icon?.kind === 'brand') {
    const BrandMark = resolveBrandAsset(icon.assetId);
    if (BrandMark) {
      return (
        <div
          role="img"
          aria-label={name}
          className={classNames}
          style={{
            ...tileBase,
            backgroundColor: 'var(--color-surface-2)',
            border: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-primary)',
            ...style,
          }}
          {...props}
        >
          <BrandMark size={glyphPx} aria-hidden />
        </div>
      );
    }
  } else if (icon?.kind === 'phosphor') {
    const glyph = resolvePhosphorGlyph(icon.name);
    if (glyph) {
      const tint = icon.color ?? 'var(--color-accent-fg)';
      const tintBg = icon.color
        ? `color-mix(in srgb, ${icon.color} 14%, transparent)`
        : 'var(--color-accent-bg)';
      return (
        <div
          role="img"
          aria-label={name}
          className={classNames}
          style={{ ...tileBase, backgroundColor: tintBg, ...style }}
          {...props}
        >
          <Icon icon={glyph} size={glyphPx} color={tint} weight="duotone" aria-hidden />
        </div>
      );
    }
  } else if (icon?.kind === 'generated') {
    return (
      <div
        role="img"
        aria-label={name}
        className={classNames}
        style={{
          ...tileBase,
          overflow: 'hidden',
          backgroundColor: 'var(--color-surface-2)',
          border: '1px solid var(--color-border-subtle)',
          ...style,
        }}
        {...props}
      >
        {/* SVG through an <img> renders in the browser's static image mode:
            scripts, event handlers, and external loads are inert — unlike
            dangerouslySetInnerHTML, which would execute them in the page. */}
        <img
          src={`data:image/svg+xml;utf8,${encodeURIComponent(icon.svg)}`}
          alt=""
          aria-hidden
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
    );
  }

  const KindGlyph = KIND_GLYPHS[kind];
  const badgePx = Math.max(11, Math.round(px * 0.34));
  const patternPx = Math.round(px * 0.68);
  const cells = listingIdenticonCells(seed);
  return (
    <div
      role="img"
      aria-label={name}
      className={classNames}
      style={{
        ...tileBase,
        backgroundColor: 'var(--color-surface-2)',
        border: '1px solid var(--color-border-subtle)',
        color: 'var(--color-text-secondary)',
        ...style,
      }}
      {...props}
    >
      <svg
        aria-hidden
        width={patternPx}
        height={patternPx}
        viewBox={`0 0 ${IDENTICON_ROWS} ${IDENTICON_ROWS}`}
      >
        {cells.flatMap((row, r) =>
          row.map(
            (filled, c) =>
              filled && (
                <rect
                  key={`${r}-${c}`}
                  x={c}
                  y={r}
                  width={1}
                  height={1}
                  rx={0.18}
                  fill="currentColor"
                />
              ),
          ),
        )}
      </svg>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          right: -2,
          bottom: -2,
          width: badgePx,
          height: badgePx,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--radius-full)',
          backgroundColor: 'var(--color-surface-3)',
          border: '1px solid var(--color-border-subtle)',
          color: 'var(--color-text-secondary)',
        }}
      >
        <KindGlyph size={Math.round(badgePx * 0.68)} weight="fill" />
      </span>
    </div>
  );
}
