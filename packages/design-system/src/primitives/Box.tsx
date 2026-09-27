import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import type { SpaceToken } from '../tokens.js';

export interface BoxProps extends HTMLAttributes<HTMLDivElement> {
  /** Content */
  children?: ReactNode;
  /** Padding (all sides) */
  p?: SpaceToken;
  /** Padding horizontal */
  px?: SpaceToken;
  /** Padding vertical */
  py?: SpaceToken;
  /** Padding top */
  pt?: SpaceToken;
  /** Padding right */
  pr?: SpaceToken;
  /** Padding bottom */
  pb?: SpaceToken;
  /** Padding left */
  pl?: SpaceToken;
  /** Margin (all sides) */
  m?: SpaceToken;
  /** Margin horizontal */
  mx?: SpaceToken;
  /** Margin vertical */
  my?: SpaceToken;
  /** Margin top */
  mt?: SpaceToken;
  /** Margin right */
  mr?: SpaceToken;
  /** Margin bottom */
  mb?: SpaceToken;
  /** Margin left */
  ml?: SpaceToken;
  /** HTML element to render */
  as?: 'div' | 'section' | 'article' | 'aside' | 'main' | 'header' | 'footer' | 'nav';
}

function spaceVar(token: SpaceToken): string {
  return `var(--space-${token})`;
}

export function Box({
  children,
  p,
  px,
  py,
  pt,
  pr,
  pb,
  pl,
  m,
  mx,
  my,
  mt,
  mr,
  mb,
  ml,
  as: Component = 'div',
  style,
  ...props
}: BoxProps) {
  const boxStyle: CSSProperties = {
    ...(p !== undefined && { padding: spaceVar(p) }),
    ...(px !== undefined && { paddingLeft: spaceVar(px), paddingRight: spaceVar(px) }),
    ...(py !== undefined && { paddingTop: spaceVar(py), paddingBottom: spaceVar(py) }),
    ...(pt !== undefined && { paddingTop: spaceVar(pt) }),
    ...(pr !== undefined && { paddingRight: spaceVar(pr) }),
    ...(pb !== undefined && { paddingBottom: spaceVar(pb) }),
    ...(pl !== undefined && { paddingLeft: spaceVar(pl) }),
    ...(m !== undefined && { margin: spaceVar(m) }),
    ...(mx !== undefined && { marginLeft: spaceVar(mx), marginRight: spaceVar(mx) }),
    ...(my !== undefined && { marginTop: spaceVar(my), marginBottom: spaceVar(my) }),
    ...(mt !== undefined && { marginTop: spaceVar(mt) }),
    ...(mr !== undefined && { marginRight: spaceVar(mr) }),
    ...(mb !== undefined && { marginBottom: spaceVar(mb) }),
    ...(ml !== undefined && { marginLeft: spaceVar(ml) }),
    ...style,
  };

  return (
    <Component style={boxStyle} {...props}>
      {children}
    </Component>
  );
}
