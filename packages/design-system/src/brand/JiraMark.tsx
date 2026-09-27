/**
 * Jira brand mark, vendored from Simple Icons (CC0). Trademark use is
 * nominative — it identifies the service a listing connects to.
 */
import { forwardRef } from 'react';

import type { CustomIconProps } from '../icons/custom/types.js';

const PATH =
  'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z';

export const JiraMark = forwardRef<SVGSVGElement, CustomIconProps>(function JiraMark(
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
