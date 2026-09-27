import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import type { FontSizeToken, FontWeightToken } from '../tokens.js';

export type TextVariant = 'body' | 'muted' | 'heading' | 'mono' | 'label';

export type TextTone = 'danger' | 'warning' | 'success' | 'info' | 'accent';

export interface TextProps extends HTMLAttributes<HTMLElement> {
  /** Content */
  children?: ReactNode;
  /** Text variant */
  variant?: TextVariant | undefined;
  /** Font size */
  size?: FontSizeToken | undefined;
  /** Font weight */
  weight?: FontWeightToken | undefined;
  /** Text color (CSS variable name without --) */
  color?: 'primary' | 'secondary' | 'muted' | 'inverse' | undefined;
  /** Semantic tone — overrides color with a semantic foreground color */
  tone?: TextTone | undefined;
  /** Text alignment */
  align?: 'left' | 'center' | 'right' | undefined;
  /** Truncate with ellipsis */
  truncate?: boolean | undefined;
  /** HTML element to render */
  as?: 'span' | 'p' | 'div' | 'label' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | undefined;
}

const variantDefaults: Record<
  TextVariant,
  {
    size: FontSizeToken;
    weight: FontWeightToken;
    color: string;
    fontFamily?: string;
  }
> = {
  body: { size: 'base', weight: 'normal', color: 'primary' },
  muted: { size: 'sm', weight: 'normal', color: 'muted' },
  heading: { size: 'lg', weight: 'normal', color: 'primary' },
  mono: { size: 'sm', weight: 'normal', color: 'primary', fontFamily: 'var(--font-family-mono)' },
  label: { size: 'sm', weight: 'medium', color: 'secondary' },
};

const elementForVariant: Record<TextVariant, TextProps['as']> = {
  body: 'p',
  muted: 'span',
  heading: 'h3',
  mono: 'span',
  label: 'label',
};

export function Text({
  children,
  variant = 'body',
  size,
  weight,
  color,
  tone,
  align,
  truncate = false,
  as,
  className = '',
  style,
  ...props
}: TextProps) {
  const defaults = variantDefaults[variant];
  const Component = as ?? elementForVariant[variant] ?? 'span';

  const resolvedColor =
    tone != null ? `var(--color-${tone}-fg)` : `var(--color-text-${color ?? defaults.color})`;

  const textStyle: CSSProperties = {
    fontSize: `var(--font-size-${size ?? defaults.size})`,
    fontWeight: `var(--font-weight-${weight ?? defaults.weight})`,
    color: resolvedColor,
    ...(defaults.fontFamily && { fontFamily: defaults.fontFamily }),
    ...(align != null ? { textAlign: align } : undefined),
    ...(truncate && {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
    ...style,
  };

  const classNames = [className].filter(Boolean).join(' ');

  return (
    <Component className={classNames} style={textStyle} {...props}>
      {children}
    </Component>
  );
}

// Convenience components for headings
export interface HeadingProps extends Omit<TextProps, 'as' | 'variant'> {
  /** Heading level (1-6) */
  level?: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
}

export function Heading({
  level = 2,
  children,
  size: sizeProp,
  weight,
  color,
  truncate,
  className,
  style,
  ...htmlProps
}: HeadingProps) {
  const sizeMap: Record<number, FontSizeToken> = {
    1: '4xl',
    2: '3xl',
    3: '2xl',
    4: 'xl',
    5: 'lg',
    6: 'base',
  };

  const size = sizeProp ?? sizeMap[level];

  return (
    <Text
      as={`h${level}` as TextProps['as']}
      variant="heading"
      size={size}
      weight={weight}
      color={color}
      truncate={truncate}
      className={className}
      style={style}
      {...htmlProps}
    >
      {children}
    </Text>
  );
}
