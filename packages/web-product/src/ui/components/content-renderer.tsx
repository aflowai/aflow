'use client';

import { memo, useState, useCallback } from 'react';
import type { SurfaceSnapshot, SurfaceMutation } from '@aflow/schemas';
import { JsonViewer, CodeBlock, Text, Column, Row, Spinner } from '@aflow/design-system';
import { MarkdownRenderer } from './markdown-renderer.js';
import { MediaRenderer } from './media-renderer.js';
import type { MediaItem } from '@aflow/run-view';
import { DataTable, analyzeTabularData } from './data-table.js';
import { fetchPayload } from '../lib/fetch-payload.js';
import { useApi } from './providers.js';
import { looksLikeMarkdown, tryParseJson } from '../lib/content-detection.js';
import { ArtifactRenderer } from './artifact-renderer.js';
import { IllustrationRenderer } from './illustration-renderer.js';
import { SurfaceRenderer, type SurfaceRendererProps } from './surface-renderer/index.js';
import { useSurfaceAction } from './surface-action-context.js';
import { detectSemanticType, renderSemanticCard } from './semantic-card-renderer.js';

export interface ContentRendererProps {
  /** Plain text content (always present) */
  content: string;
  /** Structured data for JSON/object rendering */
  richContent?: unknown;
  /** Media items (images/videos) */
  mediaItems?: MediaItem[] | undefined;
  /** Semantic type hint from state variable definition */
  semanticType?: string | undefined;
  /** The step this content came from, when a card can read more about it. */
  stepExecutionId?: string | undefined;
  /** Payload ref for lazy-loading full content (when preview is truncated) */
  payloadRef?: string | undefined;
  /** Overrides the default text color for markdown/plain-text rendering (e.g. a muted empty-state) */
  textColor?: string;
}

/**
 * Render structured JSON data with smart shape detection.
 *
 * Priority: eval/guardrail cards → DataTable → JsonViewer fallback.
 * Shared by `case 'json'`, `case 'table'`, richContent path, and auto-detect path.
 */
function renderStructuredData(
  data: unknown,
  opts?: { label?: string; maxHeight?: string; stepExecutionId?: string | undefined },
): React.ReactNode {
  // 1. Shape-based semantic type detection → specialized cards
  const detected = detectSemanticType(data);
  if (detected) {
    const card = renderSemanticCard(detected, data, { stepExecutionId: opts?.stepExecutionId });
    if (card) return card;
  }

  // 2a. Surface snapshot detection (has snapshot.surfaceId + snapshot.rootIds)
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (obj['snapshot'] && typeof obj['snapshot'] === 'object') {
      const snap = obj['snapshot'] as Record<string, unknown>;
      if (typeof snap['surfaceId'] === 'string' && Array.isArray(snap['rootIds'])) {
        return (
          <SurfaceRenderer
            snapshot={snap as unknown as SurfaceSnapshot}
            mutations={
              Array.isArray(obj['mutations']) ? (obj['mutations'] as SurfaceMutation[]) : undefined
            }
            showLoading={false}
          />
        );
      }
    }
  }

  // 2. UI artifact / illustration detection
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;

    // 2a. Illustration detection (has svg + kind === 'illustration')
    if (typeof obj['svg'] === 'string' && obj['rendererMetadata'] != null) {
      const meta = obj['rendererMetadata'] as Record<string, unknown>;
      if (meta['kind'] === 'illustration') {
        return (
          <IllustrationRenderer
            svg={obj['svg']}
            metadata={{
              artifactId: meta['artifactId'] as string | undefined,
              versionId: meta['versionId'] as string | undefined,
              draftId: meta['draftId'] as string | undefined,
              kind: meta['kind'] as string | undefined,
              name: meta['name'] as string | undefined,
              catalogVersion: meta['catalogVersion'] as string | undefined,
            }}
          />
        );
      }
    }

    // 2b. HTML artifact detection (has html + rendererMetadata)
    if (typeof obj['html'] === 'string' && obj['rendererMetadata'] != null) {
      const meta = obj['rendererMetadata'] as Record<string, unknown>;
      return (
        <ArtifactRenderer
          html={obj['html']}
          source={typeof obj['source'] === 'string' ? obj['source'] : undefined}
          data={
            typeof obj['previewData'] === 'object' && obj['previewData'] !== null
              ? (obj['previewData'] as Record<string, unknown>)
              : typeof obj['data'] === 'object' && obj['data'] !== null
                ? (obj['data'] as Record<string, unknown>)
                : typeof obj['sampleData'] === 'object' && obj['sampleData'] !== null
                  ? (obj['sampleData'] as Record<string, unknown>)
                  : undefined
          }
          dataSchema={
            typeof obj['dataSchema'] === 'object' && obj['dataSchema'] !== null
              ? (obj['dataSchema'] as Record<string, unknown>)
              : undefined
          }
          diagnostics={
            Array.isArray(obj['diagnostics'])
              ? (obj['diagnostics'] as Array<{
                  severity: string;
                  code: string;
                  message: string;
                  line?: number;
                }>)
              : undefined
          }
          metadata={{
            artifactId: meta['artifactId'] as string | undefined,
            versionId: meta['versionId'] as string | undefined,
            draftId: meta['draftId'] as string | undefined,
            kind: meta['kind'] as string | undefined,
            name: meta['name'] as string | undefined,
            catalogVersion: meta['catalogVersion'] as string | undefined,
          }}
        />
      );
    }
  }

  // 3. Table detection
  const tabular = analyzeTabularData(data);
  if (tabular) return <DataTable data={tabular} />;

  // 3. JsonViewer fallback
  const label = opts?.label;
  return (
    <Column gap="2">
      {label && label !== 'Output' && <Text>{label}</Text>}
      <JsonViewer data={data} collapseDepth={3} maxHeight={opts?.maxHeight ?? '400px'} />
    </Column>
  );
}

/**
 * ExpandablePayload — shows a truncated preview with a button to load the full content.
 * Used when the output was too large to inline and only a preview is available.
 */
function ExpandablePayload({
  preview,
  payloadRef,
}: {
  preview: { text?: string; richData?: unknown };
  payloadRef: string;
}) {
  const { apiUrl, headers } = useApi();
  const [fullData, setFullData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (expanded) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPayload(apiUrl, headers, payloadRef);
      setFullData(data);
      setExpanded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, headers, payloadRef, expanded]);

  // Once expanded, show the full data with a collapse button
  if (expanded && fullData != null) {
    return (
      <Column gap="1">
        {renderStructuredData(fullData, { maxHeight: '500px' })}
        <Row>
          <button
            onClick={() => {
              setExpanded(false);
            }}
            style={{
              background: 'none',
              border: '1px solid var(--color-border-default)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: '12px',
              color: 'var(--color-text-muted)',
            }}
          >
            Collapse
          </button>
        </Row>
      </Column>
    );
  }

  // Show the preview with a "Show full output" button
  return (
    <Column gap="2">
      {preview.richData ? (
        <JsonViewer data={preview.richData} collapseDepth={2} maxHeight="200px" />
      ) : preview.text && preview.text !== 'Output' && preview.text !== 'Output available' ? (
        <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
          {preview.text}
        </Text>
      ) : null}
      <Row gap="2" align="center">
        <button
          onClick={() => {
            void load();
          }}
          disabled={loading}
          style={{
            background: 'none',
            border: '1px solid var(--color-border-default)',
            borderRadius: 'var(--radius-sm)',
            padding: '2px 8px',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: '12px',
            color: 'var(--color-text-muted)',
          }}
        >
          {loading ? (
            <Row gap="1" align="center">
              <Spinner size="sm" />
              <span>Loading...</span>
            </Row>
          ) : (
            'Show full output'
          )}
        </button>
        {error && (
          <Text size="xs" style={{ color: 'var(--color-danger-default)' }}>
            {error}
          </Text>
        )}
      </Row>
    </Column>
  );
}

/**
 * ContentRenderer — renders message content with smart type detection.
 *
 * Rendering priority:
 * 1. Media items (images/videos) → MediaRenderer
 * 2. Explicit semanticType → use the matching renderer
 * 3. richContent (objects/JSON) → renderStructuredData (eval cards → table → JsonViewer)
 * 4. Text that looks like JSON → parsed and rendered via renderStructuredData
 * 5. Text that looks like markdown → MarkdownRenderer
 * 6. Plain text → rendered with pre-wrap
 *
 * When payloadRef is present, shows a "Show full output" button for lazy-loading.
 */
export const ContentRenderer = memo(function ContentRenderer({
  content,
  richContent,
  mediaItems,
  semanticType,
  payloadRef,
  textColor,
  stepExecutionId,
}: ContentRendererProps) {
  const textStyle = textColor ? { color: textColor } : undefined;

  // 1. Media items — always take highest priority
  if (mediaItems && mediaItems.length > 0) {
    const showText = content !== 'Generated media' && content !== 'Output';
    return (
      <Column gap="2">
        {showText && <MarkdownRenderer content={content} style={textStyle} />}
        <MediaRenderer items={mediaItems} />
      </Column>
    );
  }

  // 1b. Explicit semantic type hint — check before payloadRef so specialized
  // renderers are used even when a payloadRef is present.
  if (semanticType) {
    switch (semanticType) {
      case 'markdown':
        return <MarkdownRenderer content={content} style={textStyle} />;

      case 'code':
        return <CodeBlock copyable>{content}</CodeBlock>;

      case 'table': {
        const tableData = richContent ?? tryParseJson(content);
        if (tableData) {
          // For explicit table type, try table first, then fall through to structured
          const tabular = analyzeTabularData(tableData);
          if (tabular) return <DataTable data={tabular} />;
          // Not tabular — fall through to renderStructuredData (eval cards / JsonViewer)
          return renderStructuredData(tableData, { label: content, stepExecutionId });
        }
        break;
      }

      case 'json': {
        const jsonData = richContent ?? tryParseJson(content);
        if (jsonData) {
          return renderStructuredData(jsonData, { label: content, stepExecutionId });
        }
        // Fall through to text rendering
        break;
      }

      case 'text':
        // Explicit text — render as markdown if it contains formatting
        if (looksLikeMarkdown(content)) {
          return <MarkdownRenderer content={content} style={textStyle} />;
        }
        return <PlainText content={content} style={textStyle} />;

      case 'surface':
      case 'streamable_surface': {
        const surfaceData = richContent as Record<string, unknown> | undefined;
        if (surfaceData) {
          const mutations = surfaceData['mutations'] as Array<Record<string, unknown>> | undefined;
          const snapshot = surfaceData['snapshot'] as Record<string, unknown> | undefined;
          return (
            <SurfaceRendererWithActions
              mutations={mutations as SurfaceMutation[] | undefined}
              snapshot={snapshot as SurfaceSnapshot | undefined}
              showLoading={semanticType === 'streamable_surface'}
            />
          );
        }
        break;
      }

      case 'illustration': {
        const illustData = richContent as Record<string, unknown> | undefined;
        if (illustData && typeof illustData['svg'] === 'string') {
          return (
            <IllustrationRenderer
              svg={illustData['svg']}
              metadata={{
                artifactId: illustData['artifactId'] as string | undefined,
                draftId: illustData['draftId'] as string | undefined,
                kind: 'illustration',
                name: illustData['name'] as string | undefined,
              }}
            />
          );
        }
        break;
      }
      case 'ui_artifact': {
        const artifactData = richContent as Record<string, unknown> | undefined;
        if (artifactData && typeof artifactData['html'] === 'string') {
          return (
            <ArtifactRenderer
              html={artifactData['html']}
              source={
                typeof artifactData['source'] === 'string' ? artifactData['source'] : undefined
              }
              data={(artifactData['data'] as Record<string, unknown>) ?? {}}
              metadata={{
                artifactId: artifactData['artifactId'] as string | undefined,
                versionId: artifactData['versionId'] as string | undefined,
                draftId: artifactData['draftId'] as string | undefined,
                kind: artifactData['kind'] as string | undefined,
                name: artifactData['name'] as string | undefined,
                catalogVersion: artifactData['catalogVersion'] as string | undefined,
              }}
            />
          );
        }
        break;
      }

      default: {
        // Try shared semantic card renderer for data-backed semantic types
        if (richContent) {
          const card = renderSemanticCard(semanticType, richContent, { stepExecutionId });
          if (card) return card;
        }
        break;
      }
    }
  }

  // 3. Rich content (structured object data) → renderStructuredData
  if (richContent) {
    const rendered = renderStructuredData(richContent, { stepExecutionId });
    if (content !== 'Output') {
      return (
        <Column gap="2">
          <MarkdownRenderer content={content} style={textStyle} />
          {rendered}
        </Column>
      );
    }
    return rendered;
  }

  // 3b. Payload ref with preview — fallback for content that didn't match
  // any specialized renderer above (semanticType, richContent shape detection).
  if (payloadRef) {
    return (
      <ExpandablePayload
        preview={{ text: content, richData: richContent }}
        payloadRef={payloadRef}
      />
    );
  }

  // 4. Try detecting JSON in text content
  const parsed = tryParseJson(content);
  if (parsed !== null) {
    return renderStructuredData(parsed, { stepExecutionId });
  }

  // 5. Markdown detection — render as markdown if formatting is detected
  if (looksLikeMarkdown(content)) {
    return <MarkdownRenderer content={content} style={textStyle} />;
  }

  // 6. Plain text fallback
  return <PlainText content={content} style={textStyle} />;
});

/** SurfaceRenderer with action context wired */
function SurfaceRendererWithActions(props: SurfaceRendererProps) {
  const actionCtx = useSurfaceAction();
  return <SurfaceRenderer {...props} onAction={actionCtx?.onSurfaceAction} />;
}

/** Simple pre-wrapped text for content with no special formatting */
function PlainText({
  content,
  style,
}: {
  content: string;
  style?: React.CSSProperties | undefined;
}) {
  return (
    <Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, ...style }}>
      {content}
    </Text>
  );
}
