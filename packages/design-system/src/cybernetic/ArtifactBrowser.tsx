'use client';

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type CSSProperties,
} from 'react';

// ============================================================================
// Adapter types (pluggable per DL-22)
// ============================================================================

/** An item in the navigation list. */
export interface ArtifactItem {
  /** Unique identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** Whether this is a directory/group. */
  isDirectory: boolean;
  /** Item path (for breadcrumb navigation). */
  path: string;
  /** Optional icon name. */
  icon?: string;
  /** Optional metadata for display. */
  meta?: Record<string, unknown>;
}

/** Tab definition for the detail pane. */
export interface ArtifactTab {
  /** Tab key. */
  key: string;
  /** Tab label. */
  label: string;
}

/** Column definition for the navigation list. */
export interface ArtifactColumn {
  /** Column key (maps to item.meta). */
  key: string;
  /** Column header label. */
  label: string;
  /** Column width. */
  width?: number | string;
}

/**
 * Adapter interface that plugs into ArtifactBrowser.
 * Implement per artifact type (memory, skills, evals, etc.).
 */
export interface ArtifactBrowserAdapter {
  /** Human-readable label for this artifact type (e.g., "Memory", "Skills"). */
  label: string;

  /** List items at a given path, with optional search. */
  listItems(params: {
    path: string;
    mode: string;
    query: string;
    cursor?: string;
  }): Promise<{ items: ArtifactItem[]; nextCursor?: string }>;

  /** Fetch detail for a selected item. Returns opaque data for the preview renderer. */
  getDetail(item: ArtifactItem): Promise<unknown>;

  /** Search modes available (e.g., ['list', 'search', 'grep']). */
  searchModes: Array<{ key: string; label: string }>;

  /** Columns for the navigation list. */
  columns: ArtifactColumn[];

  /** Tabs for the detail pane. */
  detailTabs: ArtifactTab[];

  /** Render a navigation list row. */
  renderRow(item: ArtifactItem, isSelected: boolean): ReactNode;

  /** Render the preview content for the active detail tab. */
  renderPreview(detail: unknown, tabKey: string): ReactNode;

  /** Optional: render breadcrumb. */
  renderBreadcrumb?: (path: string, onNavigate: (path: string) => void) => ReactNode;

  /** Optional: render header actions (create, refresh, etc.). */
  renderActions?: (params: { path: string; onRefresh: () => void }) => ReactNode;
}

// ============================================================================
// ArtifactBrowser component
// ============================================================================

export interface ArtifactBrowserProps {
  /** The adapter providing data and rendering for this artifact type. */
  adapter: ArtifactBrowserAdapter;
  /** Initial path. */
  initialPath?: string;
  /** Navigation pane width. */
  navWidth?: number;
  /** Override height. */
  height?: string | number;
  className?: string;
  style?: CSSProperties;
}

export function ArtifactBrowser({
  adapter,
  initialPath = '/',
  navWidth = 340,
  height = '100%',
  className,
  style,
}: ArtifactBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [selectedItem, setSelectedItem] = useState<ArtifactItem | null>(null);
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [detail, setDetail] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [searchMode, setSearchMode] = useState(adapter.searchModes[0]?.key ?? 'list');
  const [searchQuery, setSearchQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState(adapter.detailTabs[0]?.key ?? '');
  const loadIdRef = useRef(0);

  // Load items when path, mode, or query changes
  const loadItems = useCallback(
    async (cursor?: string) => {
      const loadId = ++loadIdRef.current;
      setIsLoading(true);
      try {
        const params: { path: string; mode: string; query: string; cursor?: string } = {
          path: currentPath,
          mode: searchMode,
          query: searchQuery,
        };
        if (cursor) params.cursor = cursor;
        const result = await adapter.listItems(params);
        if (loadIdRef.current !== loadId) return; // stale
        if (cursor) {
          setItems((prev) => [...prev, ...result.items]);
        } else {
          setItems(result.items);
        }
        setNextCursor(result.nextCursor);
      } catch {
        // Silently fail — adapter should handle errors
      } finally {
        if (loadIdRef.current === loadId) setIsLoading(false);
      }
    },
    [adapter, currentPath, searchMode, searchQuery],
  );

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedItem || selectedItem.isDirectory) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setIsDetailLoading(true);
    adapter
      .getDetail(selectedItem)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        /* adapter handles errors */
      })
      .finally(() => {
        if (!cancelled) setIsDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adapter, selectedItem]);

  const handleSelectItem = useCallback(
    (item: ArtifactItem) => {
      if (item.isDirectory) {
        setCurrentPath(item.path);
        setSelectedItem(null);
        setDetail(null);
      } else {
        setSelectedItem(item);
        setActiveTab(adapter.detailTabs[0]?.key ?? '');
      }
    },
    [adapter.detailTabs],
  );

  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path);
    setSelectedItem(null);
    setDetail(null);
  }, []);

  const containerStyle: CSSProperties = {
    display: 'flex',
    height,
    background: 'var(--color-surface-canvas)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
    border: '1px solid var(--color-border-subtle)',
    ...style,
  };

  return (
    <div className={className} style={containerStyle}>
      {/* Navigation pane */}
      <div
        style={{
          width: navWidth,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--color-border-subtle)',
          overflow: 'hidden',
        }}
      >
        {/* Header: breadcrumb + actions */}
        <div
          style={{
            padding: 'var(--space-2) var(--space-3)',
            borderBottom: '1px solid var(--color-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          {adapter.renderBreadcrumb?.(currentPath, handleNavigate)}
          <div style={{ flex: 1 }} />
          {adapter.renderActions?.({ path: currentPath, onRefresh: () => void loadItems() })}
        </div>

        {/* Search */}
        <div
          style={{
            padding: 'var(--space-2) var(--space-3)',
            display: 'flex',
            gap: 'var(--space-1)',
          }}
        >
          {adapter.searchModes.map((mode) => (
            <button
              key={mode.key}
              onClick={() => {
                setSearchMode(mode.key);
              }}
              style={{
                padding: 'var(--space-0-5) var(--space-2)',
                fontSize: 'var(--font-size-xs)',
                fontFamily: 'var(--font-family-sans)',
                background:
                  searchMode === mode.key ? 'var(--color-interactive-muted)' : 'transparent',
                border: '1px solid',
                borderColor:
                  searchMode === mode.key ? 'var(--color-border-default)' : 'transparent',
                borderRadius: 'var(--radius-sm)',
                color:
                  searchMode === mode.key
                    ? 'var(--color-content-primary)'
                    : 'var(--color-content-muted)',
                cursor: 'pointer',
              }}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {searchMode !== 'list' && (
          <div style={{ padding: '0 var(--space-3) var(--space-2)' }}>
            <input
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
              }}
              placeholder="Search..."
              style={{
                width: '100%',
                padding: 'var(--space-1) var(--space-2)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-family-sans)',
                background: 'var(--color-surface-sunken)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--color-content-primary)',
                outline: 'none',
              }}
            />
          </div>
        )}

        {/* Item list */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {isLoading && items.length === 0 ? (
            <div
              style={{
                padding: 'var(--space-4)',
                textAlign: 'center',
                color: 'var(--color-content-muted)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              Loading...
            </div>
          ) : items.length === 0 ? (
            <div
              style={{
                padding: 'var(--space-4)',
                textAlign: 'center',
                color: 'var(--color-content-muted)',
                fontSize: 'var(--font-size-sm)',
              }}
            >
              No items
            </div>
          ) : (
            <>
              {items.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    handleSelectItem(item);
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  {adapter.renderRow(item, selectedItem?.id === item.id)}
                </div>
              ))}
              {nextCursor && (
                <button
                  onClick={() => void loadItems(nextCursor)}
                  disabled={isLoading}
                  style={{
                    width: '100%',
                    padding: 'var(--space-2)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-content-link)',
                    fontSize: 'var(--font-size-sm)',
                    cursor: 'pointer',
                  }}
                >
                  {isLoading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedItem ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-content-muted)',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            Select an item to view details
          </div>
        ) : (
          <>
            {/* Detail tabs */}
            {adapter.detailTabs.length > 1 && (
              <div
                style={{
                  display: 'flex',
                  borderBottom: '1px solid var(--color-border-subtle)',
                }}
              >
                {adapter.detailTabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => {
                      setActiveTab(tab.key);
                    }}
                    style={{
                      padding: 'var(--space-2) var(--space-3)',
                      background: 'none',
                      border: 'none',
                      borderBottom:
                        activeTab === tab.key
                          ? '2px solid var(--color-content-primary)'
                          : '2px solid transparent',
                      color:
                        activeTab === tab.key
                          ? 'var(--color-content-primary)'
                          : 'var(--color-content-muted)',
                      fontSize: 'var(--font-size-sm)',
                      fontFamily: 'var(--font-family-sans)',
                      cursor: 'pointer',
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}

            {/* Detail content */}
            <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-3)' }}>
              {isDetailLoading ? (
                <div
                  style={{
                    textAlign: 'center',
                    color: 'var(--color-content-muted)',
                    padding: 'var(--space-4)',
                  }}
                >
                  Loading...
                </div>
              ) : (
                adapter.renderPreview(detail, activeTab)
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
