'use client';

/**
 * ArtifactRenderer — sandboxed iframe host for generated UI artifacts.
 *
 * The artifact renders clean — just the iframe, no surrounding chrome.
 * A subtle code toggle icon floats in the corner. All metadata, controls,
 * and the editable source editor live inside the code panel.
 */
import { useRef, useEffect, useState, useCallback, memo } from 'react';
import {
  Column,
  Text,
  Row,
  Badge,
  Spinner,
  Button,
  Icon,
  IconButton,
  Spacer,
} from '@aflow/design-system';
import {
  PHOENIX_APPLET_MEDIA_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE,
  PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
  type PhoenixAppletMediaResultMessage,
} from '@aflow/schemas';
import { useTheme } from '../providers/theme.js';

// ============================================================================
// Types
// ============================================================================

type DebugTab = 'code' | 'data' | 'diagnostics';

export interface ArtifactFrameApi {
  /** Post a message into the artifact iframe (no-op before mount). */
  postMessage(message: unknown): void;
}

/** Height the iframe occupies before the artifact inside reports its own. */
export const ARTIFACT_MIN_HEIGHT = 100;

export interface ArtifactRendererProps {
  /** Standalone HTML to render inside the iframe. */
  html: string;
  /** Original source code (pre-compilation) for the code view. */
  source?: string | undefined;
  /** Runtime data to inject into the artifact. */
  data?: Record<string, unknown> | undefined;
  /** Data schema from generation (JSON Schema). */
  dataSchema?: Record<string, unknown> | undefined;
  /** Validation diagnostics from generation. */
  diagnostics?:
    | Array<{ severity: string; code: string; message: string; line?: number | undefined }>
    | undefined;
  /** Artifact metadata for display. */
  metadata?: {
    artifactId?: string | undefined;
    versionId?: string | undefined;
    draftId?: string | undefined;
    kind?: string | undefined;
    name?: string | undefined;
    catalogVersion?: string | undefined;
  };
  /** Minimum height of the iframe. */
  minHeight?: number | undefined;
  /** Maximum height of the iframe. */
  maxHeight?: number | undefined;
  /** Called when the artifact reports an error. */
  onError?: (error: { message: string; filename?: string; line?: number }) => void;
  /** Called when the artifact reports a surface action event. */
  onAction?: (event: Record<string, unknown>) => void;
  /**
   * Called with a media request from the artifact. A surface that supplies no
   * handler serves no media: the frame is told so rather than left waiting.
   */
  onMediaRequest?: (event: Record<string, unknown>) => void;
  /** Called when the artifact drops its copy of an asset's bytes. */
  onMediaRelease?: (event: Record<string, unknown>) => void;
  /** Called each time the artifact signals ready (once per iframe load). */
  onReady?: () => void;
  /** Receives a postMessage handle bound to the artifact iframe. */
  frameApiRef?: React.RefObject<ArtifactFrameApi | null> | undefined;
}

interface IframeMessage {
  type: string;
  [key: string]: unknown;
}

// ============================================================================
// Component
// ============================================================================

export const ArtifactRenderer = memo(function ArtifactRenderer({
  html,
  source,
  data,
  dataSchema,
  diagnostics: propDiagnostics,
  metadata,
  minHeight = ARTIFACT_MIN_HEIGHT,
  maxHeight = 800,
  onError,
  onAction,
  onMediaRequest,
  onMediaRelease,
  onReady,
  frameApiRef,
}: ArtifactRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [debugTab, setDebugTab] = useState<DebugTab>('code');
  const [editedSource, setEditedSource] = useState(source ?? '');
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [activeHtml, setActiveHtml] = useState(html);
  const [sourceModified, setSourceModified] = useState(false);
  const { resolvedTheme } = useTheme();

  // Sync editedSource when source prop changes (new artifact)
  useEffect(() => {
    if (source) {
      setEditedSource(source);
      setSourceModified(false);
      setCompileError(null);
    }
  }, [source]);

  // Sync activeHtml when html prop changes
  useEffect(() => {
    setActiveHtml(html);
  }, [html]);

  // Listen for messages from the iframe
  const handleMessage = useCallback(
    (event: MessageEvent<IframeMessage>) => {
      // A null ref must refuse, not admit: with the listener attached and the
      // iframe unmounted, `ref && …` would accept messages from ANY window.
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const msg = event.data;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'phoenix:ready':
          setLoading(false);
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              { type: 'phoenix:theme', theme: resolvedTheme },
              '*',
            );
            if (data) {
              iframeRef.current.contentWindow.postMessage(
                { type: 'phoenix:data', payload: data },
                '*',
              );
            }
          }
          onReady?.();
          break;

        case 'phoenix:resize': {
          const newHeight = msg['height'] as number;
          if (typeof newHeight === 'number' && newHeight > 0) {
            setHeight(Math.min(Math.max(newHeight, minHeight), maxHeight));
          }
          break;
        }

        case 'phoenix:error': {
          const errMsg = msg['message'] as string;
          setError(errMsg);
          onError?.({
            message: errMsg,
            ...(msg['filename'] !== undefined ? { filename: msg['filename'] as string } : {}),
            ...(msg['line'] !== undefined ? { line: msg['line'] as number } : {}),
          });
          break;
        }

        case 'phoenix:action': {
          onAction?.(msg as Record<string, unknown>);
          break;
        }

        case PHOENIX_APPLET_MEDIA_MESSAGE_TYPE: {
          if (onMediaRequest) {
            onMediaRequest(msg as Record<string, unknown>);
            break;
          }
          const requestId = msg['requestId'];
          if (typeof requestId !== 'string') break;
          const refusal: PhoenixAppletMediaResultMessage = {
            type: PHOENIX_APPLET_MEDIA_RESULT_MESSAGE_TYPE,
            requestId,
            status: 'refused',
            reason: 'unsupported',
            message: 'This surface serves no media.',
          };
          iframeRef.current?.contentWindow?.postMessage(refusal, '*');
          break;
        }

        case PHOENIX_APPLET_MEDIA_RELEASE_MESSAGE_TYPE: {
          onMediaRelease?.(msg as Record<string, unknown>);
          break;
        }
      }
    },
    [
      data,
      resolvedTheme,
      minHeight,
      maxHeight,
      onError,
      onAction,
      onMediaRequest,
      onMediaRelease,
      onReady,
    ],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handleMessage]);

  useEffect(() => {
    if (!frameApiRef) return undefined;
    frameApiRef.current = {
      postMessage: (message) => {
        iframeRef.current?.contentWindow?.postMessage(message, '*');
      },
    };
    return () => {
      frameApiRef.current = null;
    };
  }, [frameApiRef]);

  useEffect(() => {
    if (data && iframeRef.current?.contentWindow && !loading) {
      iframeRef.current.contentWindow.postMessage({ type: 'phoenix:data', payload: data }, '*');
    }
  }, [data, loading]);

  useEffect(() => {
    if (iframeRef.current?.contentWindow && !loading) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'phoenix:theme', theme: resolvedTheme },
        '*',
      );
    }
  }, [resolvedTheme, loading]);

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    if (iframeRef.current) {
      iframeRef.current.srcdoc = activeHtml;
    }
  }, [activeHtml]);

  const handleRerender = useCallback(async () => {
    setCompiling(true);
    setCompileError(null);
    setError(null);
    try {
      const res = await fetch('/api/ui/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: editedSource,
          kind: metadata?.kind ?? 'react_tsx',
        }),
      });
      const result = (await res.json()) as {
        html?: string | undefined;
        error?: string | undefined;
        diagnostics?: Array<{ message: string; line?: number }>;
      };

      if (!res.ok || !result.html) {
        const errMsg = result.diagnostics
          ? result.diagnostics.map((d) => `Line ${String(d.line ?? '?')}: ${d.message}`).join('\n')
          : (result.error ?? 'Compilation failed');
        setCompileError(errMsg);
        return;
      }

      setActiveHtml(result.html);
      setSourceModified(false);
      setLoading(true);
      setShowCode(false);
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompiling(false);
    }
  }, [editedSource, metadata?.kind]);

  const handleSourceChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditedSource(e.target.value);
    setSourceModified(true);
    setCompileError(null);
  }, []);

  const handleReset = useCallback(() => {
    if (source) {
      setEditedSource(source);
      setSourceModified(false);
      setCompileError(null);
    }
  }, [source]);

  if (showCode) {
    const tabs: Array<{ id: DebugTab; label: string; show: boolean }> = [
      { id: 'code', label: 'Code', show: true },
      { id: 'data', label: 'Data', show: !!(data || dataSchema) },
      {
        id: 'diagnostics',
        label: 'Diagnostics',
        show: !!(propDiagnostics && propDiagnostics.length > 0),
      },
    ];
    const visibleTabs = tabs.filter((t) => t.show);

    return (
      <div
        style={{
          border: '1px solid var(--color-border-default)',
          borderRadius: '8px',
          overflow: 'hidden',
        }}
      >
        {/* Debug panel header */}
        <Row
          gap="sm"
          align="center"
          paddingX="md"
          paddingY="xs"
          style={{
            borderBottom: '1px solid var(--color-border-subtle)',
            background: 'var(--color-surface-sunken)',
          }}
        >
          <Text size="sm" weight="medium">
            {metadata?.name ?? 'Source'}
          </Text>
          {metadata?.kind && (
            <Badge variant="info">
              {metadata.kind === 'react_tsx'
                ? 'React'
                : metadata.kind === 'applet'
                  ? 'Applet'
                  : metadata.kind === 'illustration'
                    ? 'SVG'
                    : 'HTML'}
            </Badge>
          )}
          {metadata?.draftId && <Badge variant="warning">Draft</Badge>}
          {metadata?.catalogVersion && (
            <Text size="xs" color="muted">
              v{metadata.catalogVersion}
            </Text>
          )}
          <Spacer />
          {debugTab === 'code' && sourceModified && metadata?.kind !== 'applet' && (
            <Button variant="ghost" size="sm" onClick={handleReset} disabled={compiling}>
              Reset
            </Button>
          )}
          {debugTab === 'code' && metadata?.kind !== 'applet' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleRerender()}
              disabled={compiling}
            >
              {compiling ? 'Compiling...' : 'Re-render'}
            </Button>
          )}
          <IconButton
            icon={<Icon name="eye" size="sm" />}
            size="sm"
            variant="secondary"
            aria-label="Show preview"
            onClick={() => {
              setShowCode(false);
            }}
          />
        </Row>

        {/* Tab bar — only show if more than one tab */}
        {visibleTabs.length > 1 && (
          <Row
            gap="none"
            style={{
              borderBottom: '1px solid var(--color-border-subtle)',
              background: 'var(--color-surface-sunken)',
            }}
          >
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  setDebugTab(tab.id);
                }}
                style={{
                  padding: '6px 16px',
                  fontSize: '13px',
                  fontWeight: debugTab === tab.id ? 600 : 400,
                  color:
                    debugTab === tab.id
                      ? 'var(--color-content-primary)'
                      : 'var(--color-content-muted)',
                  background: 'transparent',
                  border: 'none',
                  borderBottom:
                    debugTab === tab.id
                      ? '2px solid var(--color-interactive-default)'
                      : '2px solid transparent',
                  cursor: 'pointer',
                }}
              >
                {tab.label}
                {tab.id === 'diagnostics' && propDiagnostics && (
                  <span style={{ marginLeft: '4px', fontSize: '11px', opacity: 0.7 }}>
                    ({String(propDiagnostics.length)})
                  </span>
                )}
              </button>
            ))}
          </Row>
        )}

        {/* Code tab */}
        {debugTab === 'code' && (
          <>
            <textarea
              value={editedSource}
              onChange={handleSourceChange}
              spellCheck={false}
              style={{
                width: '100%',
                minHeight: '300px',
                maxHeight: `${String(maxHeight)}px`,
                padding: '16px',
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                fontSize: '13px',
                lineHeight: '1.6',
                tabSize: 2,
                border: 'none',
                outline: 'none',
                resize: 'vertical',
                background: 'var(--color-surface-sunken, #1e1e2e)',
                color: 'var(--color-content-primary, #cdd6f4)',
                display: 'block',
              }}
            />
            {compileError && (
              <div
                style={{
                  padding: '8px 16px',
                  background: 'var(--color-danger-bg, #fee2e2)',
                  borderTop: '1px solid var(--color-danger-default, #ef4444)',
                  fontSize: '13px',
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  whiteSpace: 'pre-wrap',
                  color: 'var(--color-danger-fg, #991b1b)',
                }}
              >
                {compileError}
              </div>
            )}
          </>
        )}

        {/* Data tab — shows preview data then data schema */}
        {debugTab === 'data' && (
          <div
            style={{
              padding: '16px',
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              fontSize: '13px',
              lineHeight: '1.6',
              background: 'var(--color-surface-sunken, #1e1e2e)',
              color: 'var(--color-content-primary, #cdd6f4)',
              overflow: 'auto',
              maxHeight: `${String(maxHeight)}px`,
            }}
          >
            {data && (
              <>
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: '8px',
                    fontSize: '12px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    opacity: 0.6,
                  }}
                >
                  Preview Data
                </div>
                <pre style={{ margin: '0 0 16px', whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(data, null, 2)}
                </pre>
              </>
            )}
            {dataSchema && (
              <>
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: '8px',
                    fontSize: '12px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    opacity: 0.6,
                  }}
                >
                  Data Schema
                </div>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(dataSchema, null, 2)}
                </pre>
              </>
            )}
            {!data && !dataSchema && (
              <Text size="sm" color="muted">
                No data or schema available
              </Text>
            )}
          </div>
        )}

        {/* Diagnostics tab */}
        {debugTab === 'diagnostics' && propDiagnostics && (
          <div
            style={{
              padding: '16px',
              maxHeight: `${String(maxHeight)}px`,
              overflow: 'auto',
            }}
          >
            {propDiagnostics.length === 0 ? (
              <Text size="sm" color="muted">
                No diagnostics
              </Text>
            ) : (
              <Column gap="xs">
                {propDiagnostics.map((d, i) => (
                  <Row key={i} gap="sm" align="start" style={{ padding: '4px 0' }}>
                    <Badge
                      variant={
                        d.severity === 'error'
                          ? 'danger'
                          : d.severity === 'warning'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {d.severity}
                    </Badge>
                    <Column gap="none" style={{ flex: '1 1 0%', minWidth: 0 }}>
                      <Text size="sm" style={{ fontFamily: 'ui-monospace, monospace' }}>
                        {d.code}
                        {d.line != null && (
                          <span style={{ opacity: 0.6 }}> (line {String(d.line)})</span>
                        )}
                      </Text>
                      <Text size="sm" color="muted">
                        {d.message}
                      </Text>
                    </Column>
                  </Row>
                ))}
              </Column>
            )}
          </div>
        )}
      </div>
    );
  }

  // Preview mode — clean iframe with subtle code toggle
  return (
    <div style={{ position: 'relative' }}>
      {/* Subtle code toggle — top-right corner */}
      {source && (
        <div
          style={{
            position: 'absolute',
            top: '6px',
            right: '6px',
            zIndex: 1,
            opacity: 0.4,
            transition: 'opacity 150ms',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.4';
          }}
        >
          <IconButton
            icon={<Icon name="code" size="sm" />}
            size="sm"
            variant="ghost"
            aria-label="Show source code"
            onClick={() => {
              setShowCode(true);
            }}
            style={{
              background: 'var(--color-surface-raised, rgba(255,255,255,0.8))',
              backdropFilter: 'blur(4px)',
              borderRadius: '6px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            }}
          />
        </div>
      )}

      {/* Loading */}
      {loading && (
        <Row gap="sm" align="center" padding="md">
          <Spinner size="sm" />
          <Text size="sm" color="muted">
            Loading artifact...
          </Text>
        </Row>
      )}

      {/* Runtime error */}
      {error && (
        <Column gap="sm" padding="md" style={{ background: 'var(--color-danger-bg)' }}>
          <Text size="sm" weight="medium" style={{ color: 'var(--color-danger-fg)' }}>
            Artifact Error
          </Text>
          <Text size="sm">{error}</Text>
          <Button variant="ghost" size="sm" onClick={handleRetry}>
            Retry
          </Button>
        </Column>
      )}

      {/* Sandboxed iframe — the artifact itself */}
      <iframe
        ref={iframeRef}
        srcDoc={activeHtml}
        sandbox={metadata?.kind === 'applet' ? 'allow-scripts allow-forms' : 'allow-scripts'}
        style={{
          width: '100%',
          height: `${String(height)}px`,
          border: 'none',
          display: loading ? 'none' : 'block',
        }}
        title={metadata?.name ?? 'UI Artifact'}
      />
    </div>
  );
});
