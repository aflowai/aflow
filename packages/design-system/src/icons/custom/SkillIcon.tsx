/**
 * SkillIcon — visual mark for Skills, the platform's own concept.
 *
 * A flat, monochrome reduction of the aflow orb (landing hero, run-status
 * orbs): a ring holding two aurora blobs and a four-point spark, placed
 * asymmetrically like the running orb's drift ellipses. A skill is one of
 * these living things — a contained system with a spark inside.
 *
 * Blobs and spark stay solid at every outline weight (ChatDots keeps its
 * dots solid at thin — same idiom); only the ring stroke tracks the
 * weight. The fill state is the solid disc with the contents knocked out.
 */
import { forwardRef } from 'react';

import type { CustomIconProps, CustomIconWeight } from './types.js';

/** [cx, cy, r] — medium left, small top (orb-running's drift ellipses). */
const BLOBS: ReadonlyArray<readonly [number, number, number]> = [
  [92, 120, 26],
  [138, 78, 16],
];

/**
 * The big lower-right blob is the spark: a slim four-point sparkle
 * (quadratic tips, controls at center). At rail size it stays a glint;
 * from ~32px up it reads as the star.
 */
function sparklePath(x: number, y: number, r: number): string {
  return `M${x},${y - r} Q${x},${y} ${x + r},${y} Q${x},${y} ${x},${y + r} Q${x},${y} ${x - r},${y} Q${x},${y} ${x},${y - r} Z`;
}

const SPARK = sparklePath(158, 150, 46);

const RING = { cx: 128, cy: 128, r: 104 };

const blobHoles = BLOBS.map(
  ([x, y, r]) => `M${x - r},${y} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`,
).join(' ');

const FILL_PATH = `M${RING.cx - RING.r},${RING.cy} a${RING.r},${RING.r} 0 1,0 ${2 * RING.r},0 a${RING.r},${RING.r} 0 1,0 ${-2 * RING.r},0 Z ${SPARK} ${blobHoles}`;

const STROKE_BY_WEIGHT: Record<Exclude<CustomIconWeight, 'fill'>, number> = {
  thin: 8,
  light: 12,
  regular: 16,
  duotone: 16,
  bold: 24,
};

export const SkillIcon = forwardRef<SVGSVGElement, CustomIconProps>(function SkillIcon(
  { size = 24, color = 'currentColor', weight = 'regular', ...rest },
  ref,
) {
  const common = {
    ref,
    width: size,
    height: size,
    viewBox: '0 0 256 256',
    xmlns: 'http://www.w3.org/2000/svg',
    ...rest,
  };

  if (weight === 'fill') {
    return (
      <svg {...common} fill={color}>
        <path fillRule="evenodd" d={FILL_PATH} />
      </svg>
    );
  }

  const strokeWidth = STROKE_BY_WEIGHT[weight];
  return (
    <svg {...common} fill={color}>
      <circle
        cx={RING.cx}
        cy={RING.cy}
        r={RING.r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <path d={SPARK} />
      {BLOBS.map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />
      ))}
    </svg>
  );
});
