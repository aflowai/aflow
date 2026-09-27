'use client';

import { Row, Text, Badge, Icon, IconButton, Tooltip } from '@aflow/design-system';
import type { MemoryQueryItem } from '../../hooks/use-memory-ops.js';
import type { IconName } from '@aflow/design-system';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docTypeIconName(docType: string): { name: IconName; weight?: 'fill' } {
  switch (docType) {
    case 'directory':
      return { name: 'folder-simple', weight: 'fill' };
    case 'markdown':
    case 'text':
    case 'prompt':
    case 'report':
      return { name: 'file-text' };
    case 'json':
    case 'ndjson':
    case 'schema':
      return { name: 'file-js' };
    case 'code':
    case 'html_app':
      return { name: 'file-code' };
    case 'image':
      return { name: 'image' };
    case 'video':
      return { name: 'film-strip' };
    default:
      return { name: 'file' };
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function entryName(entry: MemoryQueryItem): string {
  if (entry.name) return entry.name;
  const segments = entry.path.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last ?? entry.path;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface MemoryEntryRowProps {
  entry: MemoryQueryItem;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function MemoryEntryRow({ entry, isSelected, onSelect, onDelete }: MemoryEntryRowProps) {
  const docTypeIcon = docTypeIconName(entry.docType);
  const isDir = entry.entryType === 'directory' || entry.docType === 'directory';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: 'var(--space-2) var(--space-3)',
        cursor: 'pointer',
        backgroundColor: isSelected ? 'var(--color-surface-2)' : 'transparent',
        borderBottom: '1px solid var(--color-border-subtle)',
        userSelect: 'none',
        transition: 'background-color var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--color-surface-1)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      {/* Icon */}
      <span
        style={{
          color: isDir ? 'var(--color-accent-text)' : 'var(--color-text-muted)',
          flexShrink: 0,
          display: 'flex',
        }}
      >
        <Icon
          name={docTypeIcon.name}
          size="sm"
          {...(docTypeIcon.weight ? { weight: docTypeIcon.weight } : {})}
        />
      </span>

      {/* Name + meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="sm"
          style={{
            fontWeight: isDir ? 500 : undefined,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {entryName(entry)}
        </Text>
        {isDir && entry.childCount && (
          <Text size="xs" variant="muted">
            {String(entry.childCount.dirs)} dirs, {String(entry.childCount.docs)} docs
          </Text>
        )}
      </div>

      {/* Right side — size, score, delete */}
      <Row gap="2" style={{ flexShrink: 0, alignItems: 'center' }}>
        {!isDir && (
          <Text size="xs" variant="muted">
            {formatBytes(entry.sizeBytes)}
          </Text>
        )}
        {entry.hit && <Badge variant="info">{Math.round(entry.hit.score * 100)}%</Badge>}
        <Tooltip content="Delete">
          <IconButton
            icon={<Icon name="trash" size="xs" />}
            aria-label="Delete"
            variant="ghost"
            size="sm"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onDelete();
            }}
          />
        </Tooltip>
      </Row>
    </div>
  );
}
