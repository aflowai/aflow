'use client';

/**
 * AppShell — Top-level layout shell: collapsible sidebar + main content area.
 *
 * On desktop (>= lg): traditional sidebar with collapse toggle.
 * On mobile/tablet (< lg): sidebar becomes an overlay drawer with backdrop.
 *
 * All styling is inline via design tokens + minimal CSS classes for transitions.
 */
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
  type ReactNode,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { Icon } from '../icons/Icon.js';

// ---------------------------------------------------------------------------
// Context for sidebar state
// ---------------------------------------------------------------------------
interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
  /** True when viewport is below the lg breakpoint */
  isMobile: boolean;
  /** Open the mobile drawer */
  openDrawer: () => void;
  /** Close the mobile drawer */
  closeDrawer: () => void;
  /** Whether the mobile drawer is open */
  drawerOpen: boolean;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  setCollapsed: () => {},
  toggle: () => {},
  isMobile: false,
  openDrawer: () => {},
  closeDrawer: () => {},
  drawerOpen: false,
});

export function useSidebar() {
  return useContext(SidebarContext);
}

// ---------------------------------------------------------------------------
// Mobile header slot — PageHeader teleports its title row into the shell's
// single top bar (<1024px) so pages never stack a second header under it.
// ---------------------------------------------------------------------------
interface MobileHeaderSlotContextValue {
  /** Portal target inside the mobile top bar; null when the bar is absent. */
  el: HTMLElement | null;
  /** Registers a slot occupant; the bar hides its fallback while any exist. */
  register: () => () => void;
}

const MobileHeaderSlotContext = createContext<MobileHeaderSlotContextValue>({
  el: null,
  register: () => () => {},
});

export function useMobileHeaderSlot() {
  return useContext(MobileHeaderSlotContext);
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------
export interface AppShellProps {
  /** Sidebar content (use <Sidebar>) */
  sidebar: ReactNode;
  /** Main content */
  children: ReactNode;
  /** Start collapsed */
  defaultCollapsed?: boolean;
  /** Sidebar width when expanded (px) */
  sidebarWidth?: number;
  /** Sidebar width when collapsed (px) */
  collapsedWidth?: number;
  /** Fallback content for the mobile top bar when no PageHeader occupies it */
  mobileBarFallback?: ReactNode;
}

export function AppShell({
  sidebar,
  children,
  defaultCollapsed = false,
  sidebarWidth = 220,
  collapsedWidth = 56,
  mobileBarFallback,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [slotUsers, setSlotUsers] = useState(0);
  const registerSlotUser = useCallback(() => {
    setSlotUsers((n) => n + 1);
    return () => {
      setSlotUsers((n) => n - 1);
    };
  }, []);
  const slotContextValue = useMemo(
    () => ({ el: slotEl, register: registerSlotUser }),
    [slotEl, registerSlotUser],
  );
  /** Desktop sidebar rail: hover affordance + cursor for click-to-toggle empty areas */
  const [sidebarRailHover, setSidebarRailHover] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isMobile = !isDesktop;

  const toggle = useCallback(() => {
    if (isMobile) {
      setDrawerOpen((d) => !d);
    } else {
      setCollapsed((c) => !c);
    }
  }, [isMobile]);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  // Close drawer when switching to desktop
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  // Drawer a11y: Escape closes; focus moves into the drawer on open and back
  // to the opener on close. The main content is inert while open (below), so
  // Tab stays inside the drawer without a bespoke trap.
  const drawerRef = useRef<HTMLElement>(null);
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    drawerOpenerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    drawerRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      drawerOpenerRef.current?.focus();
      drawerOpenerRef.current = null;
    };
  }, [drawerOpen]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  const shellStyle: CSSProperties = {
    display: 'flex',
    height: '100dvh',
    overflow: 'hidden',
    color: 'var(--color-content-primary)',
  };

  const desktopSidebarStyle: CSSProperties = {
    flexShrink: 0,
    width: collapsed ? collapsedWidth : sidebarWidth,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--surface-overlay-alpha, var(--color-surface-overlay))',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    borderRight: !sidebarRailHover
      ? '0px solid var(--color-border-default)'
      : '0.5px solid var(--color-border-muted)',
    borderRadius: '0 var(--space-xl) var(--space-xl) 0',
    boxShadow: sidebarRailHover
      ? `inset 0 0 0 1px color-mix(in srgb, var(--color-border-default) ${collapsed ? '55%' : '40%'}, transparent)`
      : undefined,
    // e-resize / w-resize hint: expand rail vs collapse (interactive children keep pointer from their own styles)
    cursor: isDesktop && sidebarRailHover ? (collapsed ? 'e-resize' : 'w-resize') : undefined,
    transition:
      'width var(--transition-duration-normal) var(--transition-timing-ease-out), background-color var(--transition-duration-fast) var(--transition-timing-default), box-shadow var(--transition-duration-fast) var(--transition-timing-default)',
    overflow: 'visible',
  };

  /** Click empty rail chrome to expand (collapsed) or collapse (expanded); mirrors the caret toggle. */
  const handleSidebarRailClick = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (!isDesktop) return;
      const t = e.target as HTMLElement;
      if (t.closest('a[href], button, [role="button"], input, select, textarea')) {
        return;
      }
      // Tooltip wraps many sidebar controls in `.ds-tooltip`; padding there is not "rail" chrome.
      if (t.closest('.ds-tooltip')) {
        return;
      }
      setCollapsed((c) => !c);
    },
    [isDesktop],
  );

  const mainStyle: CSSProperties = {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  };

  return (
    <SidebarContext.Provider
      value={{ collapsed, setCollapsed, toggle, isMobile, openDrawer, closeDrawer, drawerOpen }}
    >
      <MobileHeaderSlotContext.Provider value={slotContextValue}>
        <div style={shellStyle}>
          {/* Desktop sidebar */}
          {isDesktop && (
            <aside
              style={desktopSidebarStyle}
              onMouseEnter={() => {
                setSidebarRailHover(true);
              }}
              onMouseLeave={() => {
                setSidebarRailHover(false);
              }}
              onClick={handleSidebarRailClick}
            >
              {sidebar}
            </aside>
          )}

          {/* Mobile overlay + drawer */}
          {isMobile && (
            <>
              <div
                className={`ds-sidebar-overlay${drawerOpen ? ' ds-sidebar-overlay--visible' : ''}`}
                onClick={closeDrawer}
                aria-hidden="true"
              />
              <aside
                ref={drawerRef}
                className={`ds-sidebar-drawer${drawerOpen ? ' ds-sidebar-drawer--open' : ''}`}
                inert={!drawerOpen}
                tabIndex={-1}
              >
                {sidebar}
              </aside>
            </>
          )}

          {/* Main content */}
          <div style={mainStyle} inert={isMobile && drawerOpen}>
            {isMobile && (
              <div className="ds-mobile-header">
                <button
                  onClick={openDrawer}
                  aria-label="Open menu"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 'var(--space-sm)',
                    marginLeft: 'calc(-1 * var(--space-sm))',
                    minWidth: 40,
                    minHeight: 40,
                    color: 'var(--color-content-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Icon name="list" size={20} />
                </button>
                <div
                  ref={setSlotEl}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                  }}
                />
                {slotUsers === 0 && mobileBarFallback}
              </div>
            )}
            <main
              style={{
                flex: 1,
                overflow: 'auto',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              {children}
            </main>
          </div>
        </div>
      </MobileHeaderSlotContext.Provider>
    </SidebarContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Sidebar sub-components
// ---------------------------------------------------------------------------

/** Sidebar header (logo area) */
export interface SidebarHeaderProps {
  children: ReactNode;
}

export function SidebarHeader({ children }: SidebarHeaderProps) {
  const style: CSSProperties = {
    padding: 'var(--space-3) var(--space-4)',
    flexShrink: 0,
  };
  return <div style={style}>{children}</div>;
}

/** Sidebar nav section */
export interface SidebarNavProps {
  children: ReactNode;
}

export function SidebarNav({ children }: SidebarNavProps) {
  const { collapsed, isMobile } = useSidebar();
  /** Center nav stack in the rail when collapsed; full width when expanded or mobile drawer */
  const railCentered = collapsed && !isMobile;
  const style: CSSProperties = {
    flex: 1,
    padding: 'var(--space-1) var(--space-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    overflowY: 'auto',
    overflowX: 'hidden',
    alignItems: railCentered ? 'center' : 'stretch',
    justifyContent: 'center',
  };
  return <nav style={style}>{children}</nav>;
}

/** Individual nav item */
export interface SidebarNavItemProps {
  /** Display label */
  label: string;
  /** Route href */
  href: string;
  /** Whether currently active */
  active?: boolean;
  /** Left icon (ReactNode) */
  icon?: ReactNode;
  /** onClick override (for non-link items) */
  onClick?: () => void;
  /** Render prop — allows wrapping with Next.js Link */
  as?: React.ElementType;
  /**
   * Optional right-aligned slot — typically a small badge with a count.
   * Hidden alongside the label when the sidebar collapses, so the rail
   * stays icon-only. Pass `null` to render nothing on the right.
   */
  trailing?: ReactNode;
}

export function SidebarNavItem({
  label,
  href,
  active = false,
  icon,
  onClick,
  as: Component = 'a',
  trailing,
}: SidebarNavItemProps) {
  const { collapsed, isMobile } = useSidebar();
  // On mobile drawer, always show expanded
  const showLabel = isMobile || !collapsed;

  // Grid-based layout keeps the icon in place while the label column
  // smoothly collapses to 0fr, staying in sync with the sidebar width.
  // Trailing column is `auto` only when expanded; collapses to 0fr on
  // the rail so the badge slides out with the label.
  const hasTrailing = trailing !== undefined && trailing !== null;
  const style: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: showLabel
      ? hasTrailing
        ? 'auto 1fr auto'
        : 'auto 1fr'
      : hasTrailing
        ? 'auto 0fr 0fr'
        : 'auto 0fr',
    alignItems: 'center',
    columnGap: showLabel ? 'var(--space-3)' : 0,
    padding: '10px var(--space-3)',
    borderRadius: 'var(--radius-lg)',
    textDecoration: 'none',
    fontSize: 'var(--font-size-base)',
    fontWeight: active ? 'var(--font-weight-medium)' : 'var(--font-weight-normal)',
    color: active ? 'var(--color-content-primary)' : 'var(--color-content-secondary)',
    backgroundColor: active ? 'var(--color-interactive-muted)' : 'transparent',
    cursor: 'pointer',
    transition: [
      'background-color var(--transition-duration-fast) var(--transition-timing-default)',
      'color var(--transition-duration-fast) var(--transition-timing-default)',
      'grid-template-columns var(--transition-duration-normal) var(--transition-timing-ease-out)',
      'column-gap var(--transition-duration-normal) var(--transition-timing-ease-out)',
    ].join(', '),
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    border: 'none',
    outline: 'none',
    lineHeight: 1,
  };

  const labelStyle: CSSProperties = {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    opacity: showLabel ? 1 : 0,
    transform: showLabel ? 'translateX(0)' : 'translateX(-4px)',
    transition:
      'opacity var(--transition-duration-normal) var(--transition-timing-ease-out), transform var(--transition-duration-normal) var(--transition-timing-ease-out)',
  };

  const hoverBg = active ? undefined : 'var(--color-surface-overlay)';

  return (
    <Component
      href={href}
      onClick={onClick}
      style={style}
      onMouseEnter={(e: React.MouseEvent<HTMLElement>) => {
        if (!active && hoverBg) {
          (e.currentTarget as HTMLElement).style.backgroundColor = hoverBg;
          (e.currentTarget as HTMLElement).style.color = 'var(--color-content-primary)';
        }
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLElement>) => {
        if (!active) {
          (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
          (e.currentTarget as HTMLElement).style.color = 'var(--color-content-secondary)';
        }
      }}
    >
      {icon}
      <span style={labelStyle} aria-hidden={!showLabel}>
        {label}
      </span>
      {hasTrailing && (
        <span
          aria-hidden={!showLabel}
          style={{
            overflow: 'hidden',
            display: 'inline-flex',
            alignItems: 'center',
            opacity: showLabel ? 1 : 0,
            transition:
              'opacity var(--transition-duration-normal) var(--transition-timing-ease-out)',
          }}
        >
          {trailing}
        </span>
      )}
    </Component>
  );
}

/** Sidebar footer (settings, collapse toggle, version) */
export interface SidebarFooterProps {
  children: ReactNode;
}

export function SidebarFooter({ children }: SidebarFooterProps) {
  const { collapsed, isMobile } = useSidebar();
  const railCentered = collapsed && !isMobile;
  const style: CSSProperties = {
    flexShrink: 0,
    padding: 'var(--space-2)',
    borderTop: '1px solid var(--color-border-subtle)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-0-5)',
    alignItems: railCentered ? 'center' : 'stretch',
  };
  return <div style={style}>{children}</div>;
}

/** Sidebar action button (for footer controls like theme toggle, collapse) */
export interface SidebarActionProps {
  icon: ReactNode;
  label?: string;
  onClick?: () => void;
}

export function SidebarAction({ icon, label, onClick }: SidebarActionProps) {
  const { collapsed, isMobile } = useSidebar();
  const showLabel = isMobile || !collapsed;

  const style: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: showLabel ? 'auto 1fr' : 'auto 0fr',
    alignItems: 'center',
    columnGap: showLabel ? 'var(--space-3)' : 0,
    padding: '10px var(--space-3)',
    borderRadius: 'var(--radius-lg)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--color-content-muted)',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: [
      'background-color var(--transition-duration-fast) var(--transition-timing-default)',
      'color var(--transition-duration-fast) var(--transition-timing-default)',
      'grid-template-columns var(--transition-duration-normal) var(--transition-timing-ease-out)',
      'column-gap var(--transition-duration-normal) var(--transition-timing-ease-out)',
    ].join(', '),
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    outline: 'none',
    width: '100%',
    textAlign: 'left',
  };

  const labelStyle: CSSProperties = {
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    opacity: showLabel ? 1 : 0,
    transform: showLabel ? 'translateX(0)' : 'translateX(-4px)',
    transition:
      'opacity var(--transition-duration-normal) var(--transition-timing-ease-out), transform var(--transition-duration-normal) var(--transition-timing-ease-out)',
  };

  return (
    <button
      style={style}
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--color-surface-overlay)';
        e.currentTarget.style.color = 'var(--color-content-secondary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
        e.currentTarget.style.color = 'var(--color-content-muted)';
      }}
    >
      {icon}
      {label ? (
        <span style={labelStyle} aria-hidden={!showLabel}>
          {label}
        </span>
      ) : null}
    </button>
  );
}
