/**
 * Shared types for hand-built / custom icons.
 *
 * Lives in its own file so per-icon modules don't have to depend on the
 * `GameIcon` factory or the registry — keeps the import graph acyclic
 * even as more icon families (game-icons.net, in-house SVGs, etc.) get
 * added under `./custom/`.
 */
import type { SVGProps } from 'react';

export type CustomIconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

export interface CustomIconProps extends Omit<
  SVGProps<SVGSVGElement>,
  'color' | 'width' | 'height'
> {
  size?: number;
  color?: string;
  /**
   * Accepted for interface parity with Phosphor icons. Solid-silhouette
   * icons (game-icons.net sources, etc.) ignore it; stroked custom icons
   * may use it to modulate stroke width.
   */
  weight?: CustomIconWeight;
}
