'use client';

import {
  useState,
  createContext,
  useContext,
  useCallback,
  type ReactNode,
  type HTMLAttributes,
} from 'react';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (id: string) => void;
}

const TabsContext = createContext<TabsContextValue>({
  activeTab: '',
  setActiveTab: () => {
    /* noop */
  },
});

// ---------------------------------------------------------------------------
// Tabs (root)
// ---------------------------------------------------------------------------

export interface TabsProps {
  children: ReactNode;
  defaultTab?: string;
  value?: string;
  onChange?: (tabId: string) => void;
}

export function Tabs({ children, defaultTab = '', value, onChange }: TabsProps) {
  const [internalTab, setInternalTab] = useState(defaultTab);
  const activeTab = value ?? internalTab;

  const setActiveTab = useCallback(
    (id: string) => {
      if (onChange) onChange(id);
      else setInternalTab(id);
    },
    [onChange],
  );

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>{children}</TabsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// TabList
// ---------------------------------------------------------------------------

export interface TabListProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function TabList({ children, className = '', style, ...props }: TabListProps) {
  return (
    <div
      className={`ds-tab-list ${className}`.trim()}
      role="tablist"
      style={{
        display: 'flex',
        gap: 'var(--space-1)',
        borderBottom: '1px solid var(--color-border-subtle)',
        paddingInline: 'var(--space-2)',
        overflowX: 'auto',
        overflowY: 'hidden',
        flexShrink: 0,
        scrollbarWidth: 'none',
        marginBottom: 'var(--space-2)',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab (button)
// ---------------------------------------------------------------------------

export interface TabProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'id'> {
  id: string;
  children: ReactNode;
  disabled?: boolean;
  /** How many items the tab's panel holds, rendered as a trailing count. */
  count?: number;
}

export function Tab({ id, children, disabled, count, className = '', style, ...props }: TabProps) {
  const { activeTab, setActiveTab } = useContext(TabsContext);
  const isActive = activeTab === id;

  return (
    <button
      role="tab"
      aria-selected={isActive}
      aria-controls={`tabpanel-${id}`}
      disabled={disabled}
      className={`ds-tab ${isActive ? 'ds-tab--active' : ''} ${className}`.trim()}
      style={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 'var(--space-2) var(--space-3)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: isActive ? 600 : 400,
        color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
        borderBottom: isActive ? '2px solid var(--color-content-primary)' : '2px solid transparent',
        marginBottom: '-1px',
        transition: 'color 150ms, border-color 150ms',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        ...style,
      }}
      onClick={() => {
        if (!disabled) setActiveTab(id);
      }}
      {...props}
    >
      {children}
      {count !== undefined && (
        <span
          className="ds-tab-count"
          style={{
            fontSize: 'var(--font-size-xs)',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 400,
            color: 'var(--color-text-muted)',
            background: 'var(--color-surface-2)',
            borderRadius: 'var(--radius-full)',
            padding: '0 var(--space-2)',
            lineHeight: 1.6,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TabPanel
// ---------------------------------------------------------------------------

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  children: ReactNode;
}

export function TabPanel({ id, children, className = '', style, ...props }: TabPanelProps) {
  const { activeTab } = useContext(TabsContext);

  if (activeTab !== id) return null;

  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      className={`ds-tab-panel ${className}`.trim()}
      style={{
        padding: 'var(--space-3)',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
