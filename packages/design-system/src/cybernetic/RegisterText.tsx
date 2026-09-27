/**
 * RegisterText — Typography wrapper enforcing register-based font families.
 *
 * Three registers per §8.2 / DL-17:
 * - `system`: Monospace (JetBrains Mono) for system metadata, IDs, slugs, timestamps
 * - `cognitive`: Humanist serif (IBM Plex Serif) for entity prose, narration, reasoning
 * - `ui`: Sans-serif (Inter) for UI chrome, labels, buttons
 *
 * @example
 * ```tsx
 * <RegisterText register="cognitive">Executive routed to pricing-approval</RegisterText>
 * <RegisterText register="system" size="xs">entity.trigger.routed · 09:14:22</RegisterText>
 * <RegisterText register="ui" weight="medium">Approve</RegisterText>
 * ```
 */
import type { CSSProperties, ReactNode } from 'react';

export type TypographyRegister = 'system' | 'cognitive' | 'ui';

export interface RegisterTextProps {
  /** Which typography register to use. */
  register: TypographyRegister;
  /** Font size token name (maps to --font-size-{size}). */
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl';
  /** Font weight. */
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  /** Custom color (CSS variable reference or raw value). */
  color?: string;
  /** Whether to truncate with ellipsis. */
  truncate?: boolean;
  /** HTML element to render. */
  as?: 'span' | 'p' | 'div' | 'h1' | 'h2' | 'h3' | 'h4' | 'label' | 'time';
  /** Additional class name. */
  className?: string;
  /** Additional inline styles. */
  style?: CSSProperties;
  children: ReactNode;
}

const REGISTER_FONT_FAMILY: Record<TypographyRegister, string> = {
  system: 'var(--font-family-system)',
  cognitive: 'var(--font-family-cognitive)',
  ui: 'var(--font-family-sans)',
};

const REGISTER_LINE_HEIGHT: Record<TypographyRegister, string> = {
  system: 'var(--font-line-height-tight)',
  cognitive: 'var(--font-line-height-relaxed)',
  ui: 'var(--font-line-height-normal)',
};

export function RegisterText({
  register,
  size = 'base',
  weight = 'normal',
  color,
  truncate,
  as: Tag = 'span',
  className,
  style,
  children,
}: RegisterTextProps) {
  const computedStyle: CSSProperties = {
    fontFamily: REGISTER_FONT_FAMILY[register],
    fontSize: `var(--font-size-${size})`,
    fontWeight: `var(--font-weight-${weight})`,
    lineHeight: REGISTER_LINE_HEIGHT[register],
    color: color ?? 'inherit',
    ...(truncate
      ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
      : undefined),
    ...style,
  };

  return (
    <Tag className={className} style={computedStyle}>
      {children}
    </Tag>
  );
}
