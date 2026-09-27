'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { AppPageHeader } from '../components/app-page-header.js';
import { Row, Column, Text, Divider, Icon, useBreakpoint } from '@aflow/design-system';
import { useMemoryOps } from '../hooks/use-memory-ops.js';
import { useSpaceFromRoute } from '../components/providers.js';
import type { MemoryQueryItem, MemoryGetOutput } from '../hooks/use-memory-ops.js';
import type { MemoryLinkedDoc } from '../hooks/use-memory-links.js';
import {
  PathBreadcrumb,
  DirectoryPane,
  DocumentPane,
  CreateEntryDialog,
  DeleteConfirmDialog,
} from '../components/memory/index.js';
import type { SearchMode } from '../components/memory/index.js';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SpaceMemoryPage() {
  return <MemoryExplorer initialPath="/" />;
}

export function MemoryExplorer({
  initialPath = '/',
  initialDocPath,
}: {
  initialPath?: string;
  initialDocPath?: string | undefined;
}) {
  const routeSpace = useSpaceFromRoute();
  // Navigation
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [selectedEntry, setSelectedEntry] = useState<MemoryQueryItem | null>(null);

  // Directory listing
  const [entries, setEntries] = useState<MemoryQueryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [isListLoading, setIsListLoading] = useState(false);

  // Document detail
  const [docDetail, setDocDetail] = useState<MemoryGetOutput | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  /** Which document fetch is current; an older one that resolves late is dropped. */
  const detailRequestRef = useRef(0);

  // Search
  const [searchMode, setSearchMode] = useState<SearchMode>('list');
  const [searchQuery, setSearchQuery] = useState('');

  // Dialogs
  const [createDialog, setCreateDialog] = useState<'file' | 'dir' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryQueryItem | null>(null);

  // Ops — pass the route-derived spaceId so the X-Space-ID header on
  //   every request matches the URL, not the bridge's stale value.
  const { query, get, put, del, mkdir, error: opsError } = useMemoryOps(routeSpace?.id);

  // Track the latest load request to avoid stale updates
  const loadIdRef = useRef(0);
  const keepSelectionRef = useRef(false);

  // -------------------------------------------------------------------------
  // Load directory listing
  // -------------------------------------------------------------------------

  const loadDirectory = useCallback(
    async (cursor?: string) => {
      const loadId = ++loadIdRef.current;
      setIsListLoading(true);

      // REST API handles space scope via X-Space-ID header automatically.
      const config: Record<string, unknown> = {
        mode: searchMode,
        pathPrefix: currentPath,
        budget: { limit: 50 },
      };

      if (searchMode !== 'list' && searchQuery.trim()) {
        config['query'] = searchQuery.trim();
      }
      if (cursor) config['cursor'] = cursor;

      // For search/grep without a query, don't fire the request
      if (searchMode !== 'list' && !searchQuery.trim()) {
        setEntries([]);
        setNextCursor(undefined);
        setIsListLoading(false);
        return;
      }

      const result = await query(config);

      // Only apply if this is still the latest load
      if (loadId !== loadIdRef.current) return;

      if (result) {
        setEntries((prev) => (cursor ? [...prev, ...result.items] : result.items));
        setNextCursor(result.nextCursor ?? undefined);
      }
      setIsListLoading(false);
    },
    [currentPath, searchMode, searchQuery, query],
  );

  // Reload when navigation/scope/search OR the route-derived space
  //   resolves. The space dep is load-bearing: on a cold load the
  //   bridge syncs `activeSpaceId` after the first render, so the
  //   first `loadDirectory()` would otherwise fire under the wrong
  //   space and the listing stays empty until manual refresh.
  //
  //   `keepSelectionRef` marks the scope change as a navigation *to* a
  //   document, so the listing reloads around it without dropping the
  //   selection that caused it.
  useEffect(() => {
    if (keepSelectionRef.current) {
      keepSelectionRef.current = false;
    } else {
      setSelectedEntry(null);
      setDocDetail(null);
      detailRequestRef.current += 1;
    }
    if (!routeSpace?.id) return;
    void loadDirectory();
  }, [currentPath, searchMode, searchQuery, routeSpace?.id]); // loadDirectory is intentionally excluded

  // -------------------------------------------------------------------------

  const autoSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialDocPath) return;
    if (autoSelectedRef.current === initialDocPath) return;
    if (selectedEntry) return;
    const match = entries.find((e) => e.path === initialDocPath);
    if (match) {
      autoSelectedRef.current = initialDocPath;
      void selectEntryRef.current?.(match);
    }
  }, [initialDocPath, entries, selectedEntry]);

  // -------------------------------------------------------------------------
  // Select an entry
  // -------------------------------------------------------------------------

  const selectEntry = useCallback(
    async (entry: MemoryQueryItem) => {
      const isDir = entry.entryType === 'directory' || entry.docType === 'directory';

      if (isDir) {
        // Navigate into the directory
        const dirPath = entry.path.endsWith('/') ? entry.path : entry.path + '/';
        setCurrentPath(dirPath);
        return;
      }

      // Select document — fetch content. Two selections in flight resolve in
      // whatever order the network gives them, and the later selection is the
      // one the user is looking at: a slower earlier fetch would otherwise land
      // its content beside the newer entry's name and metadata.
      const request = (detailRequestRef.current += 1);
      setSelectedEntry(entry);
      setIsDetailLoading(true);

      const isBinary =
        entry.docType === 'image' || entry.docType === 'audio' || entry.docType === 'video';
      const config: Record<string, unknown> = {
        target: { id: entry.id },
        view: 'content',
        maxBytes: isBinary ? 10_485_760 : 1_048_576,
      };

      const detail = await get(config);
      if (detailRequestRef.current !== request) return;
      setDocDetail(detail);
      setIsDetailLoading(false);
    },
    [get],
  );

  // Capture latest `selectEntry` in a ref so the auto-select effect
  //   above can call it without re-running every render.
  const selectEntryRef = useRef(selectEntry);
  selectEntryRef.current = selectEntry;

  // -------------------------------------------------------------------------
  // Follow a link — the graph hands back the target's identity, so the
  //   document opens directly and the listing follows it to its directory.
  // -------------------------------------------------------------------------

  const openLinkedDoc = useCallback(
    (doc: MemoryLinkedDoc) => {
      const lastSlash = doc.path.lastIndexOf('/');
      const dir = lastSlash > 0 ? doc.path.slice(0, lastSlash + 1) : '/';

      if (currentPath !== dir || searchMode !== 'list' || searchQuery !== '') {
        keepSelectionRef.current = true;
        setSearchMode('list');
        setSearchQuery('');
        setCurrentPath(dir);
      }

      void selectEntry({
        entryType: 'document',
        id: doc.id,
        path: doc.path,
        name: doc.path.split('/').filter(Boolean).pop() ?? doc.path,
        docType: doc.docType,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        updatedAt: doc.updatedAt,
      });
    },
    [currentPath, searchMode, searchQuery, selectEntry],
  );

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    setSelectedEntry(null);
    setDocDetail(null);
    detailRequestRef.current += 1;
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const { isMobile } = useBreakpoint();
  const [showDocPane, setShowDocPane] = useState(false);

  // On mobile, when an entry is selected, show the doc pane
  const handleSelectEntry = useCallback(
    (entry: MemoryQueryItem) => {
      void selectEntry(entry);
      if (isMobile) setShowDocPane(true);
    },
    [selectEntry, isMobile],
  );

  return (
    <Column grow style={{ height: '100%', minHeight: 0 }}>
      <AppPageHeader
        title="Memory Explorer"
        subtitle={<PathBreadcrumb path={currentPath} onNavigate={navigateTo} />}
        actions={
          opsError ? (
            <Text size="xs" tone="danger" style={{ maxWidth: 300 }}>
              {opsError}
            </Text>
          ) : undefined
        }
      />

      {/* Split pane — side-by-side on desktop, tabbed on mobile */}
      {isMobile ? (
        <Column grow style={{ minHeight: 0, overflow: 'hidden', marginTop: '-24px' }}>
          {showDocPane && selectedEntry ? (
            <>
              <Row
                padding="md"
                gap="xs"
                align="center"
                style={{
                  borderBottom: '1px solid var(--color-border-subtle)',
                  flexShrink: 0,
                }}
              >
                <button
                  onClick={() => {
                    setShowDocPane(false);
                  }}
                  aria-label="Back to files"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 'var(--space-sm)',
                    color: 'var(--color-content-primary)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <Icon name="arrow-left" size={18} />
                </button>
                <Text size="sm" weight="medium" truncate>
                  {selectedEntry.path}
                </Text>
              </Row>
              <DocumentPane
                entry={selectedEntry}
                detail={docDetail}
                isLoading={isDetailLoading}
                onDelete={() => {
                  if (selectedEntry) setDeleteTarget(selectedEntry);
                }}
                onRefresh={() => {
                  if (selectedEntry) void selectEntry(selectedEntry);
                }}
                onOpenLinkedDoc={openLinkedDoc}
              />
            </>
          ) : (
            <DirectoryPane
              entries={entries}
              isLoading={isListLoading}
              selectedPath={selectedEntry?.path}
              currentPath={currentPath}
              searchMode={searchMode}
              searchQuery={searchQuery}
              hasMore={!!nextCursor}
              onSelectEntry={(entry) => {
                handleSelectEntry(entry);
              }}
              onSearchModeChange={setSearchMode}
              onSearchQueryChange={setSearchQuery}
              onLoadMore={() => void loadDirectory(nextCursor)}
              onRefresh={() => void loadDirectory()}
              onCreateFile={() => {
                setCreateDialog('file');
              }}
              onCreateDir={() => {
                setCreateDialog('dir');
              }}
              onDeleteEntry={setDeleteTarget}
            />
          )}
        </Column>
      ) : (
        <Row
          grow
          align="stretch"
          style={{ minHeight: 0, overflow: 'hidden', marginTop: '-32px', gap: 'var(--space-xs)' }}
        >
          <DirectoryPane
            entries={entries}
            isLoading={isListLoading}
            selectedPath={selectedEntry?.path}
            currentPath={currentPath}
            searchMode={searchMode}
            searchQuery={searchQuery}
            hasMore={!!nextCursor}
            onSelectEntry={(entry) => void selectEntry(entry)}
            onSearchModeChange={setSearchMode}
            onSearchQueryChange={setSearchQuery}
            onLoadMore={() => void loadDirectory(nextCursor)}
            onRefresh={() => void loadDirectory()}
            onCreateFile={() => {
              setCreateDialog('file');
            }}
            onCreateDir={() => {
              setCreateDialog('dir');
            }}
            onDeleteEntry={setDeleteTarget}
          />

          <Divider orientation="vertical" subtle />

          <DocumentPane
            entry={selectedEntry}
            detail={docDetail}
            isLoading={isDetailLoading}
            onDelete={() => {
              if (selectedEntry) setDeleteTarget(selectedEntry);
            }}
            onRefresh={() => {
              if (selectedEntry) void selectEntry(selectedEntry);
            }}
            onOpenLinkedDoc={openLinkedDoc}
          />
        </Row>
      )}

      {/* Dialogs */}
      {createDialog !== null && (
        <CreateEntryDialog
          open
          mode={createDialog}
          currentPath={currentPath}
          onPut={put}
          onMkdir={mkdir}
          onClose={() => {
            setCreateDialog(null);
          }}
          onSuccess={() => {
            setCreateDialog(null);
            void loadDirectory();
          }}
        />
      )}

      {deleteTarget !== null && (
        <DeleteConfirmDialog
          open
          entry={deleteTarget}
          onDelete={del}
          onClose={() => {
            setDeleteTarget(null);
          }}
          onSuccess={() => {
            setDeleteTarget(null);
            if (selectedEntry?.path === deleteTarget.path) {
              setSelectedEntry(null);
              setDocDetail(null);
              detailRequestRef.current += 1;
            }
            void loadDirectory();
          }}
        />
      )}
    </Column>
  );
}
