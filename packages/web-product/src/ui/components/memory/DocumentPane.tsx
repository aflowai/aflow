'use client';

import { useState } from 'react';
import { useMemo } from 'react';
import {
  Badge,
  CodeBlock,
  Column,
  EmptyState,
  Icon,
  IconButton,
  JsonViewer,
  KeyValueTable,
  Row,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Table,
  Th,
  Td,
  Tr,
  Text,
  Tooltip,
} from '@aflow/design-system';
import { MarkdownRenderer } from '../markdown-renderer.js';
import { SafeSvg } from '../../SafeSvg.js';
import { parseCsvRow, MAX_CSV_ROWS } from '../../lib/csv-utils.js';
import type { MemoryQueryItem, MemoryGetOutput } from '../../hooks/use-memory-ops.js';
import { useMemoryLinks, type MemoryLinkedDoc } from '../../hooks/use-memory-links.js';
import { useSpaceFromRoute } from '../providers.js';
import { DocumentLinks } from './DocumentLinks.js';
import {
  detectSemanticType,
  renderSemanticCard,
  semanticTypeLabel,
} from '../semantic-card-renderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function embeddingBadgeVariant(status: string): 'succeeded' | 'failed' | 'info' | 'neutral' {
  switch (status) {
    case 'indexed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'info';
    default:
      return 'neutral';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function tryParseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isJsonFilename(pathOrName: string): boolean {
  return pathOrName.trim().toLowerCase().endsWith('.json');
}

/** Check if a memory entry contains SVG content (by MIME type or file extension). */
function isSvgContent(entry: MemoryQueryItem): boolean {
  const mime = entry.mimeType?.toLowerCase().split(';')[0]?.trim();
  if (mime === 'image/svg+xml') return true;
  const name = (entry.name ?? entry.path).toLowerCase();
  return name.endsWith('.svg');
}

/** Decode base64 text to UTF-8 string. Returns null on failure. */
function decodeBase64Text(b64: string): string | null {
  try {
    return atob(b64);
  } catch {
    return null;
  }
}

/** When API returns JSON as text (`data`), still show interactive JsonViewer when path/type says JSON. */
function shouldUseJsonTreeViewer(docType: string, entry: MemoryQueryItem): boolean {
  if (docType === 'ndjson') return false;
  if (isJsonFilename(entry.path) || isJsonFilename(entry.name ?? '')) return true;
  if (docType === 'json' || docType === 'schema') return true;
  const mime = entry.mimeType?.toLowerCase().split(';')[0]?.trim();
  if (mime === 'application/json') return true;
  return false;
}

/** Resolve semantic type for a memory document (stat metadata or shape detection). */
function resolveDocSemanticType(
  entry: MemoryQueryItem,
  detail: MemoryGetOutput | null,
): string | null {
  if (!detail) return null;
  const fromStat = detail.stat?.semanticType;
  if (fromStat) return fromStat;

  // Shape detection fallback for docs without explicit semanticType
  const jsonContent = detail.dataJson;
  const textContent = detail.data;
  const resolvedJson: unknown =
    jsonContent !== undefined && jsonContent !== null
      ? jsonContent
      : textContent && shouldUseJsonTreeViewer(entry.docType, entry)
        ? tryParseJsonText(textContent)
        : null;
  return resolvedJson != null ? detectSemanticType(resolvedJson) : null;
}

/** Text to copy for the document body (matches ContentViewer display). */
function getMemoryDocumentCopyText(
  detail: MemoryGetOutput | null,
  _docType: string,
): string | null {
  if (!detail) return null;
  const jsonContent = detail.dataJson;
  if (jsonContent !== undefined && jsonContent !== null) {
    try {
      return JSON.stringify(jsonContent, null, 2);
    } catch {
      return null;
    }
  }
  const textContent = detail.data;
  if (textContent) {
    return textContent;
  }
  return null;
}

function extensionFromMime(mime: string): string | undefined {
  const m = mime.split(';')[0]?.trim().toLowerCase();
  if (!m) return undefined;
  const table: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'text/html': '.html',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/markdown': '.md',
    'application/json': '.json',
    'application/octet-stream': '.bin',
  };
  return table[m];
}

function docTypeToFileExtension(docType: string, mimeType: string): string {
  switch (docType) {
    case 'markdown':
      return '.md';
    case 'text':
      return extensionFromMime(mimeType) ?? '.txt';
    case 'json':
      return '.json';
    case 'ndjson':
      return '.ndjson';
    case 'code':
      return extensionFromMime(mimeType) ?? '.txt';
    case 'prompt':
      return '.md';
    case 'report':
      return '.md';
    case 'dataset':
      return '.csv';
    case 'html_app':
      return '.html';
    case 'schema':
      return '.json';
    case 'image':
      return extensionFromMime(mimeType) ?? '.png';
    case 'audio':
      return extensionFromMime(mimeType) ?? '.bin';
    case 'video':
      return extensionFromMime(mimeType) ?? '.bin';
    case 'artifact':
      return extensionFromMime(mimeType) ?? '.bin';
    default:
      return extensionFromMime(mimeType) ?? '.txt';
  }
}

function buildDownloadFilename(entry: MemoryQueryItem): string {
  const raw = entry.name?.trim() || entry.path.split('/').filter(Boolean).pop() || 'document';
  const safe = raw.replace(/[/\\?%*:|"<>]/g, '_');
  const ext = docTypeToFileExtension(entry.docType, entry.mimeType);
  const hasExt = /\.[a-zA-Z0-9]{1,12}$/.test(safe);
  const base = hasExt ? safe.replace(/\.[a-zA-Z0-9]{1,12}$/, '') : safe;
  return `${base}${ext}`;
}

function buildDownloadBlob(detail: MemoryGetOutput, entry: MemoryQueryItem): Blob | null {
  const jsonContent = detail.dataJson;
  if (jsonContent !== undefined && jsonContent !== null) {
    try {
      const text = JSON.stringify(jsonContent, null, 2);
      return new Blob([text], { type: 'application/json;charset=utf-8' });
    } catch {
      return null;
    }
  }
  const textContent = detail.data;
  if (textContent) {
    const mime = entry.mimeType || 'text/plain';
    const type = mime.includes('charset') ? mime : `${mime};charset=utf-8`;
    return new Blob([textContent], { type });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DocumentPaneProps {
  entry: MemoryQueryItem | null;
  detail: MemoryGetOutput | null;
  isLoading: boolean;
  onDelete: () => void;
  onRefresh: () => void;
  /** Open another document reached through the link graph. */
  onOpenLinkedDoc: (doc: MemoryLinkedDoc) => void;
}

export function DocumentPane({
  entry,
  detail,
  isLoading,
  onDelete,
  onRefresh,
  onOpenLinkedDoc,
}: DocumentPaneProps) {
  const [contentCopied, setContentCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'rendered' | 'code'>('rendered');
  // Owned here rather than left to `defaultTab`: the loading spinner replaces
  //   the whole tab strip, so an uncontrolled tab resets on every document
  //   change — including the ones a link click causes.
  const [activeTab, setActiveTab] = useState('content');
  const routeSpace = useSpaceFromRoute();

  const isDir = entry === null || entry.entryType === 'directory' || entry.docType === 'directory';
  const linksQuery = useMemoryLinks(routeSpace?.id, entry && !isDir ? entry.id : null);
  const links = linksQuery.data;
  const linkTotal = links ? links.outgoingTotal + links.backlinkTotal : 0;
  const currentTab = isDir && activeTab !== 'info' ? 'info' : activeTab;

  if (!entry) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          marginTop: '-32px',
        }}
      >
        <EmptyState
          title="Select an entry"
          description="Choose a file or directory from the left panel to view its details."
        />
      </div>
    );
  }

  const contentCopyText = getMemoryDocumentCopyText(detail, entry.docType);
  const canDownload = !isDir && !isLoading && !!detail && !!contentCopyText;
  const resolvedSemanticType = resolveDocSemanticType(entry, detail);
  const hasSemanticCard = resolvedSemanticType != null;
  const isSvg = isSvgContent(entry);
  const hasAlternateView = hasSemanticCard || isSvg;

  const handleRefresh = () => {
    onRefresh();
    if (!isDir) void linksQuery.refetch();
  };

  const handleDownload = () => {
    if (!detail || !canDownload) return;
    const blob = buildDownloadBlob(detail, entry);
    if (!blob) return;
    const filename = buildDownloadFilename(entry);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyContent = async () => {
    if (!contentCopyText) return;
    try {
      await navigator.clipboard.writeText(contentCopyText);
      setContentCopied(true);
      setTimeout(() => {
        setContentCopied(false);
      }, 2000);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = contentCopyText;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setContentCopied(true);
      setTimeout(() => {
        setContentCopied(false);
      }, 2000);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        backgroundColor: 'var(--color-surface-0)',
        padding: 'var(--space-lg)',
        borderRadius: 'var(--radius-2xl)',
        marginRight: '12px',
        marginBottom: '12px',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--color-border-subtle)',
          flexShrink: 0,
        }}
      >
        <Row justify="between" align="start">
          <Column gap="1" style={{ minWidth: 0 }}>
            <Text
              variant="mono"
              size="sm"
              style={{
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.path}
            </Text>
            <Row gap="2">
              <Badge variant="neutral">{entry.docType}</Badge>
              {detail?.stat.embeddingStatus && (
                <Badge variant={embeddingBadgeVariant(detail.stat.embeddingStatus)}>
                  {detail.stat.embeddingStatus}
                </Badge>
              )}
              {detail?.stat.version && (
                <Text size="xs" variant="muted">
                  v{String(detail.stat.version)}
                </Text>
              )}
            </Row>
          </Column>
          <Row gap="1" style={{ flexShrink: 0 }}>
            <Tooltip content="Refresh">
              <IconButton
                icon={<Icon name="sync" size="sm" />}
                aria-label="Refresh"
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
              />
            </Tooltip>
            {!isDir && (
              <Tooltip content={canDownload ? 'Download' : 'No content to download'}>
                <IconButton
                  icon={<Icon name="download" size="sm" />}
                  aria-label="Download"
                  variant="ghost"
                  size="sm"
                  disabled={!canDownload}
                  onClick={handleDownload}
                />
              </Tooltip>
            )}
            <Tooltip content="Delete">
              <IconButton
                icon={<Icon name="trash" size="sm" />}
                aria-label="Delete"
                variant="ghost"
                size="sm"
                onClick={onDelete}
              />
            </Tooltip>
          </Row>
        </Row>
      </div>

      {/* Body */}
      {isLoading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner size="md" />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <Tabs value={currentTab} onChange={setActiveTab}>
            <TabList>
              {!isDir && <Tab id="content">Content</Tab>}
              {!isDir && <Tab id="links">{linkTotal > 0 ? `Links (${linkTotal})` : 'Links'}</Tab>}
              <Tab id="info">Info</Tab>
            </TabList>

            {!isDir && (
              <TabPanel
                id="content"
                style={{
                  padding: 'var(--space-4)',
                  backgroundColor: 'var(--color-surface-1)',
                  borderRadius: 'var(--radius-lg)',
                }}
              >
                <div style={{ position: 'relative' }}>
                  {contentCopyText || hasAlternateView ? (
                    <Row
                      gap="0"
                      style={{
                        position: 'absolute',
                        top: 'var(--space-1)',
                        right: 'var(--space-1)',
                        zIndex: 1,
                      }}
                    >
                      {hasAlternateView && (
                        <Tooltip
                          content={
                            viewMode === 'rendered'
                              ? isSvg
                                ? 'Show SVG source'
                                : 'Show raw JSON'
                              : isSvg
                                ? 'Show rendered SVG'
                                : `Show ${semanticTypeLabel(resolvedSemanticType!)} card`
                          }
                        >
                          <IconButton
                            icon={
                              <Icon
                                name={
                                  viewMode === 'rendered'
                                    ? 'code'
                                    : isSvg
                                      ? 'image'
                                      : 'squares-four'
                                }
                                size="xs"
                              />
                            }
                            aria-label={
                              viewMode === 'rendered'
                                ? isSvg
                                  ? 'Show SVG source'
                                  : 'Show raw JSON'
                                : isSvg
                                  ? 'Show rendered SVG'
                                  : `Show ${semanticTypeLabel(resolvedSemanticType!)} card`
                            }
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setViewMode((m) => (m === 'rendered' ? 'code' : 'rendered'));
                            }}
                          />
                        </Tooltip>
                      )}
                      {contentCopyText && (
                        <Tooltip content={contentCopied ? 'Copied' : 'Copy to clipboard'}>
                          <IconButton
                            icon={<Icon name={contentCopied ? 'check' : 'copy'} size="xs" />}
                            aria-label={contentCopied ? 'Copied' : 'Copy to clipboard'}
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              void handleCopyContent();
                            }}
                          />
                        </Tooltip>
                      )}
                    </Row>
                  ) : null}
                  <ContentViewer
                    entry={entry}
                    docType={entry.docType}
                    detail={detail}
                    inlineCopyable={!contentCopyText}
                    viewMode={viewMode}
                  />
                </div>
              </TabPanel>
            )}

            {!isDir && (
              <TabPanel id="links" style={{ padding: 'var(--space-4)' }}>
                <DocumentLinks
                  links={links}
                  isLoading={linksQuery.isLoading}
                  error={linksQuery.error?.message ?? null}
                  onOpenDoc={onOpenLinkedDoc}
                />
              </TabPanel>
            )}

            <TabPanel id="info" style={{ padding: 'var(--space-4)' }}>
              <StatViewer entry={entry} detail={detail} />
            </TabPanel>
          </Tabs>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV table viewer
// ---------------------------------------------------------------------------

function CsvViewer({ csv }: { csv: string }) {
  const { headers, rows, totalRows } = useMemo(() => {
    const lines = csv.split('\n').filter((l) => l.trim().length > 0);
    const headerLine = lines[0];
    if (headerLine === undefined) return { headers: [], rows: [], totalRows: 0 };
    const h = parseCsvRow(headerLine);
    const total = lines.length - 1;
    const dataLines = lines.slice(1, MAX_CSV_ROWS + 1);
    const r = dataLines.map(parseCsvRow);
    return { headers: h, rows: r, totalRows: total };
  }, [csv]);

  if (headers.length === 0) {
    return <Text variant="muted">Empty dataset.</Text>;
  }

  return (
    <div style={{ overflow: 'auto', maxHeight: 600 }}>
      <Table>
        <thead>
          <Tr>
            <Th
              style={{ color: 'var(--color-content-tertiary)', fontVariantNumeric: 'tabular-nums' }}
            >
              #
            </Th>
            {headers.map((h, i) => (
              <Th key={i}>{h}</Th>
            ))}
          </Tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <Tr key={ri}>
              <Td
                style={{
                  color: 'var(--color-content-tertiary)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {ri + 1}
              </Td>
              {row.map((cell, ci) => (
                <Td
                  key={ci}
                  style={{ fontFamily: 'var(--font-family-mono)', fontSize: 'var(--font-size-xs)' }}
                >
                  {cell}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
      {totalRows > MAX_CSV_ROWS && (
        <Text variant="muted" style={{ padding: '8px', textAlign: 'center' }}>
          Showing {MAX_CSV_ROWS} of {totalRows} rows
        </Text>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content viewer
// ---------------------------------------------------------------------------

function ContentViewer({
  entry,
  docType,
  detail,
  inlineCopyable = true,
  viewMode = 'rendered',
}: {
  entry: MemoryQueryItem;
  docType: string;
  detail: MemoryGetOutput | null;
  /** When false, JsonViewer/CodeBlock omit inline copy (e.g. outer pane copy control). */
  inlineCopyable?: boolean | undefined;
  /** View mode: 'rendered' for visual display, 'code' for raw source. */
  viewMode?: 'rendered' | 'code' | undefined;
}) {
  if (!detail) {
    return <Text variant="muted">No content loaded.</Text>;
  }

  if (detail.truncated) {
    // We still show what we have, but note the truncation
  }

  // Resolve JSON data from either dataJson or parsed text
  const jsonContent = detail.dataJson;
  const textContent = detail.data;
  const resolvedJson: unknown =
    jsonContent !== undefined && jsonContent !== null
      ? jsonContent
      : textContent && shouldUseJsonTreeViewer(docType, entry)
        ? tryParseJsonText(textContent)
        : null;

  // Semantic type: prefer explicit stat.semanticType, fall back to shape detection
  const statSemanticType = detail.stat?.semanticType ?? null;
  const detectedType =
    statSemanticType ?? (resolvedJson != null ? detectSemanticType(resolvedJson) : null);

  // JSON content with a specialized renderer
  if (resolvedJson != null && detectedType) {
    return viewMode === 'rendered' ? (
      renderSemanticCard(detectedType, resolvedJson)
    ) : (
      <JsonViewer data={resolvedJson} collapseDepth={3} copyable={inlineCopyable} />
    );
  }

  // Plain JSON content (no specialized renderer)
  if (resolvedJson != null) {
    return <JsonViewer data={resolvedJson} collapseDepth={3} copyable={inlineCopyable} />;
  }

  // SVG content — handle regardless of docType (could be image, text, code, etc.)
  if (textContent && isSvgContent(entry)) {
    // If docType is 'image', data is base64-encoded; otherwise it's raw SVG text
    const svgSource =
      docType === 'image' ? (decodeBase64Text(textContent) ?? textContent) : textContent;
    if (viewMode === 'code') {
      return <CodeBlock copyable={inlineCopyable}>{svgSource}</CodeBlock>;
    }
    return (
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <SafeSvg
          source={svgSource}
          style={{
            maxWidth: '100%',
            maxHeight: '70vh',
            overflow: 'hidden',
            borderRadius: 'var(--radius-md)',
          }}
        />
      </div>
    );
  }

  // Text content — schema uses `data`, legacy alias `content`
  if (textContent) {
    switch (docType) {
      case 'image': {
        const src = `data:${entry.mimeType || 'image/png'};base64,${textContent}`;
        return (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <img
              src={src}
              alt={entry.name ?? entry.path}
              style={{
                maxWidth: '100%',
                maxHeight: '70vh',
                objectFit: 'contain',
                borderRadius: 'var(--radius-md)',
              }}
            />
          </div>
        );
      }

      case 'audio': {
        const src = `data:${entry.mimeType || 'audio/mpeg'};base64,${textContent}`;
        return (
          <audio controls style={{ width: '100%' }}>
            <source src={src} type={entry.mimeType || 'audio/mpeg'} />
          </audio>
        );
      }

      case 'video': {
        const src = `data:${entry.mimeType || 'video/mp4'};base64,${textContent}`;
        return (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <video
              controls
              style={{
                maxWidth: '100%',
                maxHeight: '70vh',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <source src={src} type={entry.mimeType || 'video/mp4'} />
            </video>
          </div>
        );
      }

      case 'markdown':
      case 'prompt':
      case 'report':
        return <MarkdownRenderer content={textContent} />;

      case 'dataset':
        return <CsvViewer csv={textContent} />;

      case 'json':
      case 'ndjson':
      case 'schema':
      case 'code':
      case 'html_app':
        return <CodeBlock copyable={inlineCopyable}>{textContent}</CodeBlock>;

      default:
        if (isJsonFilename(entry.path) || isJsonFilename(entry.name ?? '')) {
          return <CodeBlock copyable={inlineCopyable}>{textContent}</CodeBlock>;
        }
        return (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'var(--font-family-mono)',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-text-primary)',
              margin: 0,
            }}
          >
            {textContent}
          </pre>
        );
    }
  }

  return <Text variant="muted">No content available for this entry.</Text>;
}

// ---------------------------------------------------------------------------
// Stat/info viewer
// ---------------------------------------------------------------------------

function StatViewer({ entry, detail }: { entry: MemoryQueryItem; detail: MemoryGetOutput | null }) {
  const stat = detail?.stat;

  const items: Array<{ key: string; value: React.ReactNode }> = [
    {
      key: 'Path',
      value: (
        <Text variant="mono" size="sm">
          {entry.path}
        </Text>
      ),
    },
    { key: 'Type', value: entry.docType },
    { key: 'MIME', value: entry.mimeType },
    { key: 'Size', value: formatBytes(entry.sizeBytes) },
    {
      key: 'Updated',
      value: formatDate(entry.updatedAt),
    },
  ];

  if (stat) {
    items.push(
      {
        key: 'ID',
        value: (
          <Text variant="mono" size="xs">
            {stat.id}
          </Text>
        ),
      },
      { key: 'Version', value: String(stat.version) },
      { key: 'Embedding', value: stat.embeddingStatus },
      { key: 'Created', value: formatDate(stat.createdAt) },
    );

    if (stat.contentHash) {
      items.push({
        key: 'Hash',
        value: (
          <Text variant="mono" size="xs">
            {stat.contentHash}
          </Text>
        ),
      });
    }

    if (stat.tags.length > 0) {
      items.push({
        key: 'Tags',
        value: (
          <Row gap="1" style={{ flexWrap: 'wrap' }}>
            {stat.tags.map((tag) => (
              <Badge key={tag} variant="neutral">
                {tag}
              </Badge>
            ))}
          </Row>
        ),
      });
    }
  }

  return (
    <Column gap="4">
      <KeyValueTable items={items} keyWidth="100px" />
    </Column>
  );
}
