/**
 * Vercel brand mark, vendored from Simple Icons (CC0). Trademark use is
 * nominative — it identifies the service a listing connects to.
 */
import { forwardRef } from 'react';

import type { CustomIconProps } from '../icons/custom/types.js';

const PATH = 'm12 1.608 12 20.784H0Z';

export const VercelMark = forwardRef<SVGSVGElement, CustomIconProps>(function VercelMark(
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
