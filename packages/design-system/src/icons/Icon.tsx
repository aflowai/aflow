/**
 * Icon v2 — Name-based icon API backed by Phosphor.
 *
 * Primary API (v2):
 *   <Icon name="chat" size="md" />
 *
 * Legacy API (v1 compat — migrate away from this):
 *   <Icon icon={PhosphorComponent} size={20} />
 */
import { type HTMLAttributes, type ComponentType, forwardRef } from 'react';
import * as PhosphorIcons from '@phosphor-icons/react';
import { Microphone } from '@phosphor-icons/react/dist/csr/Microphone';
import { MicrophoneSlash } from '@phosphor-icons/react/dist/csr/MicrophoneSlash';
import { MicrophoneStage } from '@phosphor-icons/react/dist/csr/MicrophoneStage';
import { ICON_MAP, type IconName } from './iconMap.js';
import { CUSTOM_ICONS, type CustomIconName } from './custom/index.js';

/** Explicit imports for icons that may be tree-shaken when using dynamic lookup */
const EXPLICIT_ICONS: Record<
  string,
  ComponentType<{ size?: number; color?: string; weight?: string }>
> = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  Microphone,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  MicrophoneSlash,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- CSR imports have error types in eslint
  MicrophoneStage,
};

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_MAP: Record<IconSize, number> = {
  xs: 16,
  sm: 18,
  md: 22,
  lg: 28,
  xl: 36,
};

export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

/** Legacy Phosphor icon component type (v1 compat) */
export interface PhosphorIconProps {
  size?: number | string;
  color?: string;
  weight?: IconWeight;
  mirrored?: boolean;
}

// v2 API: name-based
interface IconPropsV2 extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  /** Phoenix icon name from the curated set */
  name: IconName;
  /** Size preset or raw pixel number */
  size?: IconSize | number;
  /** Icon color */
  color?: string;
  /** Phosphor weight */
  weight?: IconWeight;
  icon?: never;
}

// v1 API: component-based (legacy compat)
interface IconPropsV1 extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  /** Phosphor icon component (legacy — use `name` instead) */
  icon: ComponentType<PhosphorIconProps>;
  /** Size in pixels */
  size?: number;
  /** Icon color */
  color?: string;
  /** Phosphor weight */
  weight?: IconWeight;
  name?: never;
}

export type IconProps = IconPropsV2 | IconPropsV1;

/** Per-name default Phosphor weight when `weight` is omitted; otherwise icons use `regular`. */
const DEFAULT_WEIGHT_BY_NAME: Partial<Record<IconName, IconWeight>> = {
  stop: 'fill',
  // Cybernetic concept set reads as solid fill by default (more character
  // than the thin-line default); callers can still override per placement.
  books: 'fill',
  lightbulb: 'fill',
  buildings: 'fill',
  stethoscope: 'fill',
  scales: 'fill',
};

export const Icon = forwardRef<HTMLSpanElement, IconProps>(function Icon(props, ref) {
  const { color = 'currentColor', weight: weightProp, style, className = '', ...rest } = props;
  const weight: IconWeight =
    weightProp ??
    ('name' in props && props.name != null
      ? (DEFAULT_WEIGHT_BY_NAME[props.name] ?? 'thin')
      : 'thin');

  let pxSize: number;
  let IconComponent: ComponentType<{ size?: number; color?: string; weight?: string }> | undefined;

  if ('name' in props && props.name != null) {
    // v2 API
    const sizeInput = props.size ?? 'md';
    pxSize = typeof sizeInput === 'number' ? sizeInput : SIZE_MAP[sizeInput];
    if (props.name in CUSTOM_ICONS) {
      IconComponent = CUSTOM_ICONS[props.name as CustomIconName] as ComponentType<{
        size?: number;
        color?: string;
        weight?: string;
      }>;
    } else {
      const phosphorName = ICON_MAP[props.name as keyof typeof ICON_MAP];
      IconComponent =
        EXPLICIT_ICONS[phosphorName] ??
        (
          PhosphorIcons as Record<
            string,
            ComponentType<{ size?: number; color?: string; weight?: string }>
          >
        )[phosphorName];
    }
    // Clean up extra props before spreading
    const { name: _name, size: _size, ...htmlRest } = rest as Record<string, unknown>;
    return renderIcon(ref, IconComponent, pxSize, color, weight, style, className, htmlRest);
  } else if ('icon' in props && props.icon != null) {
    // v1 legacy API
    pxSize = props.size ?? 20;
    IconComponent = props.icon as ComponentType<{ size?: number; color?: string; weight?: string }>;
    const { icon: _icon, size: _size, ...htmlRest } = rest as Record<string, unknown>;
    return renderIcon(ref, IconComponent, pxSize, color, weight, style, className, htmlRest);
  }

  // Fallback
  return (
    <span
      ref={ref}
      className={`ds-icon ${className}`}
      style={{ display: 'inline-flex', ...style }}
    />
  );
});

function renderIcon(
  ref: React.Ref<HTMLSpanElement>,
  IconComponent: ComponentType<{ size?: number; color?: string; weight?: string }> | undefined,
  pxSize: number,
  color: string,
  weight: IconWeight,
  style: React.CSSProperties | undefined,
  className: string,
  htmlRest: Record<string, unknown>,
) {
  const wrapperStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    lineHeight: 0,
    width: pxSize,
    height: pxSize,
    ...style,
  };

  return (
    <span ref={ref} className={`ds-icon ${className}`} style={wrapperStyle} {...htmlRest}>
      {IconComponent && <IconComponent size={pxSize} color={color} weight={weight} />}
    </span>
  );
}

export { type IconName } from './iconMap.js';
