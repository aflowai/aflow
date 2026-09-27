/**
 * Phoenix logo — pixelated strawberry-robot icon.
 * Variants: "color" for header/brand, "mono" for avatars (adapts to theme).
 */
export type LogoVariant = 'color' | 'mono';

export interface LogoProps {
  /** Visual style: color (red/gray) or mono (text-primary, theme-aware) */
  variant?: LogoVariant;
  /** Size in pixels (width of the mark itself; the box scales proportionally) */
  size?: number;
  className?: string;
}

const ART_W = 5;
const ART_H = 7;
const TILT_DEG = -10;

/**
 * The tilt rotates the artwork inside the viewBox, and the box is widened to
 * the rotated bounds. A CSS transform on the <svg> instead leaves the rotated
 * corners outside the element's layout box, so any ancestor clipping its
 * overflow — the sidebar's collapsing link, PageHeader's ellipsised title —
 * shears off the top-left ear.
 */
const TILT_RAD = (TILT_DEG * Math.PI) / 180;
const ROT_W = Math.abs(ART_W * Math.cos(TILT_RAD)) + Math.abs(ART_H * Math.sin(TILT_RAD));
const ROT_H = Math.abs(ART_W * Math.sin(TILT_RAD)) + Math.abs(ART_H * Math.cos(TILT_RAD));
const VIEW_BOX = [
  (-(ROT_W - ART_W) / 2).toFixed(3),
  (-(ROT_H - ART_H) / 2).toFixed(3),
  ROT_W.toFixed(3),
  ROT_H.toFixed(3),
].join(' ');
const TILT = `rotate(${TILT_DEG} ${ART_W / 2} ${ART_H / 2})`;

export function Logo({ variant = 'color', size = 24, className }: LogoProps) {
  // One unit stays `size / ART_W` px wide whatever the box grows to, so the
  // mark renders at the same scale the caller asked for.
  const unit = size / ART_W;

  const fills =
    variant === 'mono'
      ? {
          ear: 'var(--color-text-muted)',
          head: 'var(--color-text-primary)',
          bodyA: 'var(--color-text-primary)',
          bodyB: 'var(--color-text-primary)',
          legs: 'var(--color-text-primary)',
        }
      : {
          ear: '#6B6B6B',
          head: '#8A8A8A',
          bodyA: '#E8384F',
          bodyB: '#C42D3E',
          legs: '#C42D3E',
        };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={VIEW_BOX}
      width={ROT_W * unit}
      height={ROT_H * unit}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
    >
      <g transform={TILT}>
        <rect fill={fills.ear} x="0" y="0" width="1" height="1" />
        <rect fill={fills.ear} x="4" y="0" width="1" height="1" />
        <rect fill={fills.head} x="1" y="1" width="3" height="1" />
        <rect fill={fills.bodyA} x="0" y="2" width="5" height="1" />
        <rect fill={fills.bodyB} x="0" y="3" width="5" height="1" />
        <rect fill={fills.bodyA} x="0" y="4" width="5" height="1" />
        <rect fill={fills.legs} x="1" y="5" width="3" height="2" />
      </g>
    </svg>
  );
}
