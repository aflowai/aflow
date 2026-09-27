'use client';

import { useCallback, useRef, useState } from 'react';
import {
  Button,
  Column,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Row,
  Spinner,
  Text,
  Tooltip,
  useBreakpoint,
} from '@aflow/design-system';
import type { MemoryQueryItem } from '../../hooks/use-memory-ops.js';
import { MemoryEntryRow } from './MemoryEntryRow.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchMode = 'list' | 'search' | 'grep';

export interface DirectoryPaneProps {
  entries: MemoryQueryItem[];
  isLoading: boolean;
  selectedPath: string | undefined;
  currentPath: string;
  searchMode: SearchMode;
  searchQuery: string;
  hasMore: boolean;
  onSelectEntry: (entry: MemoryQueryItem) => void;
  onSearchModeChange: (mode: SearchMode) => void;
  onSearchQueryChange: (q: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onCreateFile: () => void;
  onCreateDir: () => void;
  onDeleteEntry: (entry: MemoryQueryItem) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DirectoryPane({
  entries,
  isLoading,
  selectedPath,
  searchMode,
  searchQuery,
  hasMore,
  onSelectEntry,
  onSearchModeChange,
  onSearchQueryChange,
  onLoadMore,
  onRefresh,
  onCreateFile,
  onCreateDir,
  onDeleteEntry,
}: DirectoryPaneProps) {
  const { isMobile } = useBreakpoint();
  const isSearching = searchMode !== 'list';
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localQuery, setLocalQuery] = useState(searchQuery);

  const handleQueryChange = useCallback(
    (value: string) => {
      setLocalQuery(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => {
        onSearchQueryChange(value);
      }, 400);
    },
    [onSearchQueryChange],
  );

  const handleModeChange = useCallback(
    (mode: SearchMode) => {
      onSearchModeChange(mode);
      if (mode === 'list') {
        setLocalQuery('');
        onSearchQueryChange('');
      }
    },
    [onSearchModeChange, onSearchQueryChange],
  );

  return (
    <div
      style={{
        width: isMobile ? '100%' : 340,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        backgroundColor: 'var(--color-surface-0)',
        borderRadius: 'var(--radius-2xl)',
        padding: 'var(--space-md)',
        marginLeft: isMobile ? 0 : '12px',
        marginBottom: '12px',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          flexShrink: 0,
        }}
      >
        {/* Search + mode toggles */}
        <Row gap="1" align="center">
          <div style={{ flex: 1 }}>
            <Input
              type="search"
              placeholder={
                searchMode === 'grep'
                  ? 'Text to grep...'
                  : searchMode === 'search'
                    ? 'Semantic search...'
                    : 'Switch to search mode...'
              }
              value={localQuery}
              onChange={(e) => {
                handleQueryChange(e.target.value);
              }}
              onFocus={() => {
                if (searchMode === 'list' && localQuery.length > 0) {
                  handleModeChange('search');
                }
              }}
            />
          </div>
          <Tooltip content="Browse">
            <IconButton
              icon={<Icon name="list" size="sm" />}
              aria-label="List mode"
              variant={searchMode === 'list' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => {
                handleModeChange('list');
              }}
            />
          </Tooltip>
          <Tooltip content="Semantic search">
            <IconButton
              icon={<Icon name="magnifying-glass" size="sm" />}
              aria-label="Semantic search"
              variant={searchMode === 'search' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => {
                handleModeChange('search');
              }}
            />
          </Tooltip>
          <Tooltip content="Text grep">
            <IconButton
              icon={<Icon name="text-t" size="sm" />}
              aria-label="Grep mode"
              variant={searchMode === 'grep' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => {
                handleModeChange('grep');
              }}
            />
          </Tooltip>
        </Row>

        {/* Actions */}
        <Row gap="1" justify="end" align="center">
          <Tooltip content="Refresh">
            <IconButton
              icon={<Icon name="refresh" size="sm" />}
              aria-label="Refresh listing"
              variant="ghost"
              size="sm"
              onClick={onRefresh}
            />
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="plus" size="xs" />}
            onClick={onCreateFile}
          >
            File
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="folder-simple-plus" size="xs" />}
            onClick={onCreateDir}
          >
            Directory
          </Button>
        </Row>
      </div>

      {/* Entry list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading && entries.length === 0 ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: 'var(--space-8)',
            }}
          >
            <Spinner size="md" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<Icon name="folder-simple" size="xl" />}
            title={isSearching ? 'No results' : 'Empty directory'}
            description={
              isSearching
                ? 'Try a different query or search mode'
                : 'Create a file or directory to get started'
            }
          />
        ) : (
          <GroupedEntryList
            entries={entries}
            selectedPath={selectedPath}
            hasMore={hasMore}
            isLoading={isLoading}
            onSelectEntry={onSelectEntry}
            onDeleteEntry={onDeleteEntry}
            onLoadMore={onLoadMore}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isDir = (e: MemoryQueryItem) => e.entryType === 'directory' || e.docType === 'directory';

// ---------------------------------------------------------------------------
// Entry list — directories first, then files
// ---------------------------------------------------------------------------

function GroupedEntryList({
  entries,
  selectedPath,
  hasMore,
  isLoading,
  onSelectEntry,
  onDeleteEntry,
  onLoadMore,
}: {
  entries: MemoryQueryItem[];
  selectedPath: string | undefined;
  hasMore: boolean;
  isLoading: boolean;
  onSelectEntry: (entry: MemoryQueryItem) => void;
  onDeleteEntry: (entry: MemoryQueryItem) => void;
  onLoadMore: () => void;
}) {
  const dirs = entries.filter(isDir);
  const files = entries.filter((e) => !isDir(e));

  return (
    <Column gap="0">
      {dirs.length > 0 && (
        <>
          <SectionHeader label="Directories" count={dirs.length} />
          {dirs.map((entry) => (
            <MemoryEntryRow
              key={entry.id}
              entry={entry}
              isSelected={entry.path === selectedPath}
              onSelect={() => {
                onSelectEntry(entry);
              }}
              onDelete={() => {
                onDeleteEntry(entry);
              }}
            />
          ))}
        </>
      )}
      {files.length > 0 && (
        <>
          <SectionHeader label="Files" count={files.length} />
          {files.map((entry) => (
            <MemoryEntryRow
              key={entry.id}
              entry={entry}
              isSelected={entry.path === selectedPath}
              onSelect={() => {
                onSelectEntry(entry);
              }}
              onDelete={() => {
                onDeleteEntry(entry);
              }}
            />
          ))}
        </>
      )}
      {hasMore && (
        <div style={{ padding: 'var(--space-3)', textAlign: 'center' }}>
          <Button variant="ghost" size="sm" loading={isLoading} onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </Column>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        padding: 'var(--space-1) var(--space-3)',
        backgroundColor: 'var(--color-surface-1)',
        borderBottom: '1px solid var(--color-border-subtle)',
        position: 'sticky',
        top: 0,
        zIndex: 1,
      }}
    >
      <Row gap="2" align="center">
        <Text
          size="xs"
          variant="muted"
          style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          {label}
        </Text>
        <Text size="xs" variant="muted">
          {String(count)}
        </Text>
      </Row>
    </div>
  );
}
