/**
 * SplitPane — two panes that scroll independently inside one bounded region
 * (e.g. list | detail, timeline | inspector). The container owns no height of
 * its own, so a parent must give it one; without that both panes collapse.
 * All styling inline via tokens.
 */
import type { ReactNode, CSSProperties } from 'react';

export interface SplitPaneProps {
  /** Main content — takes the remaining space and scrolls on overflow */
  children: ReactNode;
  /** Secondary panel content */
  aside?: ReactNode;
  /**
   * Width of the aside panel when the panes sit side by side. A CSS width is
   * accepted too, so a rail can size to its content rather than to a guess.
   */
  asideWidth?: number | string;
  /** Show border between panes */
  bordered?: boolean;
  /** Aside background */
  asideBg?: string;
  /** Side the aside sits on. Defaults to the end (right in LTR). */
  asidePlacement?: 'start' | 'end';
  /**
   * Stack the panes vertically instead of side by side — for viewports too
   * narrow for a split. Both panes keep their own scroll.
   */
  stacked?: boolean;
  /** Height the aside takes when stacked, so the main pane keeps the rest. */
  asideStackedHeight?: number;
}

const BORDER = '1px solid var(--color-border-subtle)';

function asideBorderStyle(
  bordered: boolean,
  stacked: boolean,
  placement: 'start' | 'end',
): CSSProperties {
  if (!bordered) return {};
  if (stacked) return placement === 'start' ? { borderBottom: BORDER } : { borderTop: BORDER };
  return placement === 'start' ? { borderRight: BORDER } : { borderLeft: BORDER };
}

export function SplitPane({
  children,
  aside,
  asideWidth = 380,
  bordered = true,
  asideBg = 'var(--color-surface-1)',
  asidePlacement = 'end',
  stacked = false,
  asideStackedHeight = 200,
}: SplitPaneProps) {
  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: stacked ? 'column' : 'row',
    flex: 1,
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  };

  const mainStyle: CSSProperties = {
    flex: 1,
    overflow: 'auto',
    minWidth: 0,
    minHeight: 0,
  };

  const asideStyle: CSSProperties = {
    ...(stacked
      ? { width: '100%', height: asideStackedHeight }
      : { width: asideWidth, height: '100%' }),
    flexShrink: 0,
    overflow: 'auto',
    backgroundColor: asideBg,
    ...asideBorderStyle(bordered, stacked, asidePlacement),
  };

  const asidePane = aside ? (
    <div style={asideStyle} className="ds-scroll-subtle">
      {aside}
    </div>
  ) : null;

  return (
    <div style={containerStyle}>
      {asidePlacement === 'start' && asidePane}
      <div style={mainStyle} className="ds-scroll-subtle">
        {children}
      </div>
      {asidePlacement === 'end' && asidePane}
    </div>
  );
}
