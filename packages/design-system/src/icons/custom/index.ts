/**
 * Phoenix custom icon registry.
 *
 * Hand-built or third-party SVG icons that complement the Phosphor
 * catalog. Each entry is keyed by a Phoenix-stable name and resolved by
 * the `Icon` component before the Phosphor lookup runs.
 *
 * Adding a game-icons.net icon:
 *   1. Create a new file under `./` calling `defineGameIcon({ path,
 *      attribution })`. The attribution metadata is type-required —
 *      that's how we stay CC BY 3.0 compliant.
 *   2. Register the component in `CUSTOM_ICONS` below under a
 *      kebab-case Phoenix name.
 *   3. Use it: `<Icon name="your-name" />`.
 */
import type { ComponentType } from 'react';

import { Bullseye } from './Bullseye.js';
import { Claude } from './Claude.js';
import { Gears } from './Gears.js';
import { Robot3 } from './Robot3.js';
import { SkillIcon } from './SkillIcon.js';
import { Slalom } from './Slalom.js';
import type { CustomIconProps } from './types.js';

export type { CustomIconProps, CustomIconWeight } from './types.js';
export {
  defineGameIcon,
  type GameIconAttribution,
  type GameIconDefinition,
  type GameIconComponent,
} from './GameIcon.js';

export const CUSTOM_ICONS = {
  // Skill — original two-state mark (graph nodes joined by a lightning edge)
  skill: SkillIcon,

  // Skill modes
  gears: Gears, // process
  bullseye: Bullseye, // optimization
  slalom: Slalom, // project

  // Agent mark — every agent reference (Helmsman/Runner share it for now)
  robot: Robot3, // ri robot-3 (fill) — deliberate flat accent in the duotone set

  // Brand marks
  claude: Claude, // Anthropic Claude — coding-agent lane (code.agent.run)
} as const satisfies Record<string, ComponentType<CustomIconProps>>;

export type CustomIconName = keyof typeof CUSTOM_ICONS;
