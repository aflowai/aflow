'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Column, Text, Spinner, Icon } from '@aflow/design-system';
import { useApi } from './providers.js';
import { acquireDocBytes, docBytesUrl } from '../hooks/media-bytes-broker.js';
import type { MediaItem } from '@aflow/run-view';

/**
 * One object URL per document, shared by every card that shows it and released
 * when the last of them unmounts.
 */
function useDocMedia(docId: string) {
  const { apiUrl, headers } = useApi();
  const [state, setState] = useState<{
    src: string | null;
    loading: boolean;
    error: string | null;
  }>({ src: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ src: null, loading: true, error: null });
    const held = acquireDocBytes(apiUrl, headers(), docId);
    held.objectUrl
      .then((src) => {
        if (!cancelled) setState({ src, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          src: null,
          loading: false,
          error: e instanceof Error ? e.message : 'Failed to load',
        });
      });
    return () => {
      cancelled = true;
      held.release();
    };
  }, [apiUrl, headers, docId]);

  return state;
}

/**
 * Where a clip is played from. The element loads the route itself, so the
 * document's size stops deciding what a card costs to show: `preload="metadata"`
 * asks for a header block and a seek asks for the span it lands on. Buffering
 * the whole asset into a Blob first would make the route's range handling
 * unreachable from the browser and pin every clip a session rendered.
 */
function useDocStreamUrl(docId: string): string | null {
  const { apiUrl, spaceId } = useApi();
  return useMemo(
    () => (spaceId === null ? null : docBytesUrl(apiUrl, spaceId, docId)),
    [apiUrl, spaceId, docId],
  );
}

// ============================================================================
// Image Renderer
// ============================================================================

function ImageRenderer({ item, index }: { item: MediaItem; index: number }) {
  const [hovered, setHovered] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const { src, loading, error } = useDocMedia(item.docId);

  const handleDownload = useCallback(() => {
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `generated-image-${index + 1}.${item.mimeType.split('/')[1] ?? 'png'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [src, index, item.mimeType]);

  // Close fullscreen on Escape
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

  if (loading) {
    return (
      <div style={{ ...styles['placeholder'], flexDirection: 'column', gap: 'var(--space-2)' }}>
        <Spinner size="sm" />
        <Text variant="muted" size="sm">
          Loading image…
        </Text>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles['placeholder']}>
        <Text variant="muted" size="sm">
          {error}
        </Text>
      </div>
    );
  }

  if (!src) {
    return (
      <div style={styles['placeholder']}>
        <Text variant="muted" size="sm">
          Image data unavailable
        </Text>
      </div>
    );
  }

  return (
    <>
      <div
        style={styles['mediaContainer']}
        onMouseEnter={() => {
          setHovered(true);
        }}
        onMouseLeave={() => {
          setHovered(false);
        }}
      >
        <div style={{ position: 'relative' }}>
          <div style={styles['imageWrapper']}>
            <img
              src={src}
              alt={item.revisedPrompt ?? `Generated image ${index + 1}`}
              style={styles['image']}
              loading="lazy"
            />
          </div>
          {/* Overlay actions — visible on hover */}
          <div
            style={{
              ...styles['actionOverlay'],
              opacity: hovered ? 1 : 0.4,
            }}
          >
            <button
              type="button"
              style={styles['actionBtn']}
              onClick={() => {
                setFullscreen(true);
              }}
              title="Full screen"
              aria-label="View full screen"
            >
              <Icon name="expand" size="sm" />
            </button>
            <button
              type="button"
              style={styles['actionBtn']}
              onClick={handleDownload}
              title="Download"
              aria-label="Download image"
            >
              <Icon name="download" size="sm" />
            </button>
          </div>
        </div>
        {item.revisedPrompt && (
          <Text variant="muted" size="xs" style={styles['prompt']}>
            {item.revisedPrompt}
          </Text>
        )}
      </div>

      {/* Fullscreen overlay */}
      {fullscreen && (
        <div
          style={styles['fullscreenOverlay']}
          onClick={() => {
            setFullscreen(false);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
              setFullscreen(false);
            }
          }}
        >
          <img
            src={src}
            alt={item.revisedPrompt ?? `Generated image ${index + 1}`}
            style={styles['fullscreenImage']}
            onClick={(e) => {
              e.stopPropagation();
            }}
          />
        </div>
      )}
    </>
  );
}

// ============================================================================
// Video Renderer
// ============================================================================

function VideoRenderer({ item, index }: { item: MediaItem; index: number }) {
  const [hovered, setHovered] = useState(false);
  const src = useDocStreamUrl(item.docId);

  const handleDownload = useCallback(() => {
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `generated-video-${index + 1}.${item.mimeType.split('/')[1] ?? 'mp4'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [src, index, item.mimeType]);

  // The element fetches on its own, so there is no load to wait on here — only
  // the case where no space is active yet and the document cannot be addressed.
  if (!src) {
    return (
      <div style={styles['placeholder']}>
        <Text variant="muted" size="sm">
          Video data unavailable
        </Text>
      </div>
    );
  }

  return (
    <div
      style={styles['mediaContainer']}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
    >
      <div style={{ position: 'relative' }}>
        <div style={styles['videoWrapper']}>
          <video src={src} controls preload="metadata" style={styles['video']} playsInline />
        </div>
        {/* Download action — visible on hover */}
        <div
          style={{
            ...styles['actionOverlay'],
            opacity: hovered ? 1 : 0.4,
          }}
        >
          <button
            type="button"
            style={styles['actionBtn']}
            onClick={handleDownload}
            title="Download"
            aria-label="Download video"
          >
            <Icon name="download" size="sm" />
          </button>
        </div>
      </div>
      {item.revisedPrompt && (
        <Text variant="muted" size="xs" style={styles['prompt']}>
          {item.revisedPrompt}
        </Text>
      )}
    </div>
  );
}

// ============================================================================
// Main MediaRenderer Component
// ============================================================================

interface MediaRendererProps {
  /** Array of media items to render */
  items: MediaItem[];
  /** Optional label */
  label?: string;
}

/** Renders a collection of generated media items (images and videos). */
export function MediaRenderer({ items, label }: MediaRendererProps) {
  if (items.length === 0) return null;

  return (
    <Column gap="3">
      {label && (
        <Text variant="muted" size="sm" weight="medium">
          {label}
        </Text>
      )}
      <div style={items.length > 1 ? styles['grid'] : undefined}>
        {items.map((item, i) =>
          item.kind === 'video' ? (
            <VideoRenderer key={`video-${String(i)}`} item={item} index={i} />
          ) : (
            <ImageRenderer key={`image-${String(i)}`} item={item} index={i} />
          ),
        )}
      </div>
    </Column>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  mediaContainer: {
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--color-border-subtle)',
    overflow: 'hidden',
    backgroundColor: 'var(--color-surface-0)',
  },
  imageWrapper: {
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-surface-0)',
    maxHeight: '500px',
  },
  image: {
    maxWidth: '100%',
    height: 'auto',
    objectFit: 'contain',
    display: 'block',
  },
  videoWrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  video: {
    maxWidth: '100%',
    maxHeight: '500px',
    display: 'block',
  },
  prompt: {
    padding: 'var(--space-2) var(--space-3)',
    borderTop: '1px solid var(--color-border-subtle)',
    fontStyle: 'italic',
  },
  placeholder: {
    padding: 'var(--space-4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-surface-1)',
    borderRadius: 'var(--radius-lg)',
    border: '1px dashed var(--color-border-subtle)',
    minHeight: '100px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: 'var(--space-3)',
  },
  actionOverlay: {
    position: 'absolute',
    top: 'var(--space-2)',
    right: 'var(--space-2)',
    display: 'flex',
    gap: 'var(--space-1)',
    transition: 'opacity 0.15s ease',
    pointerEvents: 'auto',
  },
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    borderRadius: 'var(--radius-md)',
    border: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    color: '#fff',
    cursor: 'pointer',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    padding: 0,
  },
  fullscreenOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    cursor: 'zoom-out',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  },
  fullscreenImage: {
    maxWidth: '95vw',
    maxHeight: '95vh',
    objectFit: 'contain',
    cursor: 'default',
    borderRadius: 'var(--radius-md)',
  },
};
