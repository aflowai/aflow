/**
 * Icon — thin wrapper around Phosphor Icons for consistent sizing and color.
 *
 * Usage:
 *   import { Icon } from "@aflow/design-system";
 *   import { ChatCircle } from "@phosphor-icons/react";
 *   <Icon icon={ChatCircle} size={20} />
 */
import type { ComponentType, CSSProperties, HTMLAttributes } from 'react';

export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

export interface PhosphorIconProps {
  size?: number | string;
  color?: string;
  weight?: IconWeight;
  mirrored?: boolean;
}

export interface IconProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  /** Phosphor icon component */
  icon: ComponentType<PhosphorIconProps>;
  /** Size in pixels */
  size?: number;
  /** CSS color value */
  color?: string;
  /** Phosphor weight variant */
  weight?: IconWeight;
  /** Additional className */
  className?: string;
}

export function Icon({
  icon: IconComponent,
  size = 20,
  color = 'currentColor',
  weight = 'regular',
  className = '',
  style,
  ...props
}: IconProps) {
  const wrapperStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    lineHeight: 0,
    ...style,
  };

  return (
    <span className={`ds-icon ${className}`} style={wrapperStyle} {...props}>
      <IconComponent size={size} color={color} weight={weight} />
    </span>
  );
}
