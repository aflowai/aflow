/**
 * Anthropic brand mark, vendored from Simple Icons (CC0). Trademark use is
 * nominative — it identifies the model provider a run can be pointed at.
 */
import { forwardRef } from 'react';

import type { CustomIconProps } from '../icons/custom/types.js';

const PATH =
  'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z';

export const AnthropicMark = forwardRef<SVGSVGElement, CustomIconProps>(function AnthropicMark(
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
