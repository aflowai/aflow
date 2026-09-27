'use client';

/**
 * PageHeader — Consistent header bar at the top of each page.
 * Provides a title slot on the left, actions slot on the right.
 * Full-width (no max-width); no top margin; bottom margin separates from body content.
 * All styling inline via tokens.
 *
 * Below the shell's desktop breakpoint the title row teleports into the
 * AppShell mobile top bar (hamburger · title · actions) so pages render one
 * bar of chrome instead of a stack; only subtitle/tabs stay in-flow.
 */
import { useEffect, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useMobileHeaderSlot } from './AppShell.js';

export interface PageHeaderProps {
  /** Breadcrumb prefix rendered before the title (e.g. space indicator) */
  prefix?: ReactNode;
  /** Title content (left side) */
  title?: ReactNode;
  /** Action buttons / controls (right side) */
  actions?: ReactNode;
  /** Optional subtitle or breadcrumb below the title */
  subtitle?: ReactNode;
  /** Tab navigation rendered below the title row, inside the header border */
  tabs?: ReactNode;
  /** Whether to show bottom border (default true) */
  bordered?: boolean;
  /** Children rendered between title and actions */
  children?: ReactNode;
}

export function PageHeader({
  prefix,
  title,
  actions,
  subtitle,
  bordered = true,
  tabs,
  children,
}: PageHeaderProps) {
  const { el: mobileSlotEl, register } = useMobileHeaderSlot();
  const inBar = mobileSlotEl != null;

  useEffect(() => {
    if (!inBar) return;
    return register();
  }, [inBar, register]);

  const showBorder = bordered && !tabs;
  const hasInFlowContent = Boolean(subtitle || tabs);

  const wrapperStyle: CSSProperties = {
    flexShrink: 0,
    fontFamily: 'var(--font-family-title)',
    fontSize: 'var(--font-size-lg)',
    fontWeight: 'var(--font-weight-thin)',
    color: 'var(--color-content-primary)',
    letterSpacing: 'var(--font-letter-spacing-tight)',
    margin: 0,
    marginBottom: bordered ? 'var(--space-5)' : 0,
    whiteSpace: 'nowrap',
    padding: '0 var(--space-5)',
    width: '100%',
    borderBottom: showBorder ? '1px solid var(--color-border-subtle)' : 'none',
  };

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-3)',
    minHeight: 48,
    flexWrap: 'wrap',
  };

  const titleAreaStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    minWidth: 0,
    fontFamily: 'var(--font-family-title)',
    fontSize: 'var(--font-size-lg)',
    fontWeight: 'var(--font-weight-thin)',
    color: 'var(--color-content-primary)',
    letterSpacing: 'var(--font-letter-spacing-tight)',
    margin: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
  };

  const titleStyle: CSSProperties = {
    fontSize: inBar ? 'var(--font-size-base)' : 'var(--font-size-xl)',
    fontFamily: 'var(--font-family-title)',
    fontWeight: 'var(--font-weight-thin)',
    color: 'var(--color-content-primary)',
    letterSpacing: 'var(--font-letter-spacing-normal)',
    margin: 0,
    paddingTop: 'var(--space-2)',
    paddingBottom: 'var(--space-2)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const subtitleStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-content-muted)',
    paddingBottom: 'var(--space-2)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const actionsStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    flexShrink: 0,
  };

  const prefixSepStyle: CSSProperties = {
    color: 'var(--color-content-muted)',
    opacity: 0.4,
    fontSize: 'var(--font-size-lg)',
    fontWeight: 'var(--font-weight-thin)',
    userSelect: 'none',
  };

  // Tab strips can outgrow narrow viewports; scroll them in place instead of
  // widening the page.
  const tabsWrapperStyle: CSSProperties = {
    borderBottom: bordered ? '1px solid var(--color-border-subtle)' : 'none',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    maxWidth: '100%',
  };

  const titleRow = (
    <>
      <div style={{ ...titleAreaStyle, ...(inBar ? { gap: 'var(--space-2)', flex: 1 } : {}) }}>
        {prefix && !inBar && (
          <>
            {prefix}
            {title != null && <span style={prefixSepStyle}>/</span>}
          </>
        )}
        {typeof title === 'string' ? <h2 style={titleStyle}>{title}</h2> : title}
        {children}
      </div>
      {actions && <div style={actionsStyle}>{actions}</div>}
    </>
  );

  if (inBar) {
    return (
      <>
        {createPortal(titleRow, mobileSlotEl)}
        {hasInFlowContent && (
          <div style={{ ...wrapperStyle, marginBottom: bordered ? 'var(--space-3)' : 0 }}>
            {subtitle && <div style={subtitleStyle}>{subtitle}</div>}
            {tabs && <div style={tabsWrapperStyle}>{tabs}</div>}
          </div>
        )}
      </>
    );
  }

  return (
    <div style={wrapperStyle}>
      <div style={rowStyle}>{titleRow}</div>
      {subtitle && <div style={subtitleStyle}>{subtitle}</div>}
      {tabs && <div style={tabsWrapperStyle}>{tabs}</div>}
    </div>
  );
}
