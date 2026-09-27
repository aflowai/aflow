/**
 * GameIcon — factory for icons sourced from game-icons.net.
 *
 * game-icons.net assets are solid-silhouette SVG paths distributed under
 * CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). To stay
 * compliant we keep author/source metadata on every icon at the source
 * level — `defineGameIcon` makes this required by the type system, so a
 * new icon can't be added without it.
 *
 * Adding a new icon is then ~5 lines per file:
 *
 *   export const FooBar = defineGameIcon({
 *     path: 'M…',
 *     attribution: {
 *       author: 'Delapouite',
 *       source: 'https://game-icons.net/1x1/delapouite/foo-bar.html',
 *     },
 *   });
 *
 * Then register the component in `./index.ts` under a Phoenix icon name.
 */
import { forwardRef } from 'react';

import type { CustomIconProps } from './types.js';

export interface GameIconAttribution {
  /** Author handle on game-icons.net (e.g. "Delapouite", "Lorc"). */
  author: string;
  /** Permalink to the icon's page (used as both source attribution and discoverability). */
  source: string;
  /**
   * License URL. Defaults to CC BY 3.0 — only override if game-icons.net
   * relicenses or you're sourcing from elsewhere.
   */
  license?: string;
  /** Optional note describing modifications from the original SVG. */
  changes?: string;
}

export interface GameIconDefinition {
  /** SVG path data (the `d` attribute of the silhouette path). */
  path: string;
  /** CC BY 3.0 attribution metadata — required so it's never accidentally dropped. */
  attribution: GameIconAttribution;
  /** Override viewBox if the source isn't the game-icons.net standard 512×512. */
  viewBox?: string;
}

/**
 * Build a Phoenix-shaped icon component from a game-icons.net path.
 *
 * The returned component carries the `attribution` definition on a
 * non-rendered `_attribution` property so build-time tooling can later
 * harvest it for a NOTICE file without having to re-parse source.
 */
export function defineGameIcon(definition: GameIconDefinition) {
  const { path, viewBox = '0 0 512 512' } = definition;

  const Component = forwardRef<SVGSVGElement, CustomIconProps>(function GameIcon(
    { size = 24, color = 'currentColor', weight: _weight, ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox={viewBox}
        xmlns="http://www.w3.org/2000/svg"
        {...rest}
      >
        <path d={path} fill={color} />
      </svg>
    );
  });

  // Attach attribution as a non-rendered property — see JSDoc above.
  return Object.assign(Component, { _attribution: definition.attribution });
}

export type GameIconComponent = ReturnType<typeof defineGameIcon>;
