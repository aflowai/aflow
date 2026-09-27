/**
 * Robot3 — the generic agent mark. Shown wherever an agent is referenced
 * (agent/AI step types, `ai.agent.turn`, workflow/skill turn rows). The
 * Helmsman and Runner personas deliberately share this mark for now.
 *
 * Glyph vendored from Remix Icon (`robot-3-fill`, Apache-2.0). It is a flat
 * fill by design — a deliberate accent in the otherwise duotone concept set —
 * so it ignores the `weight` prop like the other vendored marks.
 */
import { forwardRef } from 'react';

import type { CustomIconProps } from './types.js';

const PATH =
  'M17 2h-4V1h-2v1H7a3 3 0 0 0-3 3v3a5 5 0 0 0 5 5h6a5 5 0 0 0 5-5V5a3 3 0 0 0-3-3m-6 5.5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0m5 0a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0M4 22a8 8 0 1 1 16 0z';

export const Robot3 = forwardRef<SVGSVGElement, CustomIconProps>(function Robot3(
  { size = 24, color = 'currentColor', weight: _weight, ...rest },
  ref,
) {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path d={PATH} fill={color} />
    </svg>
  );
});
