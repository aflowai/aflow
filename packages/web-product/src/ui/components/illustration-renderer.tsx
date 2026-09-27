'use client';

/**
 * IllustrationRenderer — inline SVG renderer for illustration artifacts.
 *
 * Renders SVG inline (not in an iframe) so it inherits page typography and
 * theme; `SafeSvg` is what makes that safe.
 */
import { useState, useCallback, memo, useRef } from 'react';
import { Column, Row, Text, Badge, Button, Icon, IconButton, Spacer } from '@aflow/design-system';
import { SafeSvg } from '../SafeSvg.js';

// ============================================================================
// Types
// ============================================================================

export interface IllustrationRendererProps {
  /** Raw SVG string — the illustration source. */
  svg: string;
  /** Optional metadata for the header display. */
  metadata?: {
    artifactId?: string | undefined;
    versionId?: string | undefined;
    draftId?: string | undefined;
    kind?: string | undefined;
    name?: string | undefined;
    catalogVersion?: string | undefined;
  };
  /** Maximum display width. Defaults to 480. */
  maxWidth?: number;
  /** Maximum display height. Defaults to 480. */
  maxHeight?: number;
}

// ============================================================================
// Component
// ============================================================================

export const IllustrationRenderer = memo(function IllustrationRenderer({
  svg,
  metadata,
  maxWidth = 480,
  maxHeight = 480,
}: IllustrationRendererProps) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(svg);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard API not available
    }
  }, [svg]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${metadata?.name ?? 'illustration'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [svg, metadata?.name]);

  return (
    <Column
      gap="none"
      style={{
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        background: 'var(--color-surface-default)',
      }}
    >
      {/* SVG display */}
      <div
        ref={containerRef}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          maxWidth,
          maxHeight,
          margin: '0 auto',
          width: '100%',
          position: 'relative',
        }}
      >
        <SafeSvg
          source={svg}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.2s ease',
          }}
        />

        {/* Floating action buttons */}
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            gap: 4,
            opacity: 0.4,
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = '0.4';
          }}
        >
          <IconButton
            icon={<Icon name={showSource ? 'eye' : 'code'} size="sm" />}
            size="sm"
            variant="ghost"
            aria-label={showSource ? 'Show preview' : 'Show source'}
            onClick={() => {
              setShowSource((s) => !s);
            }}
          />
        </div>
      </div>

      {/* Source panel */}
      {showSource && (
        <Column
          gap="sm"
          style={{
            borderTop: '1px solid var(--color-border-subtle)',
            background: 'var(--color-surface-sunken)',
          }}
        >
          {/* Header */}
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
              {metadata?.name ?? 'Illustration'}
            </Text>
            <Badge variant="info">SVG</Badge>
            {metadata?.draftId && <Badge variant="warning">Draft</Badge>}
            <Spacer />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void handleCopy();
              }}
            >
              {copied ? 'Copied!' : 'Copy SVG'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDownload}>
              Download
            </Button>
            <IconButton
              icon={<Icon name="eye" size="sm" />}
              size="sm"
              variant="secondary"
              aria-label="Show preview"
              onClick={() => {
                setShowSource(false);
              }}
            />
          </Row>

          {/* Source code */}
          <div
            style={{
              padding: '12px 16px',
              maxHeight: 300,
              overflow: 'auto',
            }}
          >
            <pre
              style={{
                margin: 0,
                fontSize: 12,
                fontFamily: 'var(--font-mono, monospace)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: 'var(--color-text-secondary)',
              }}
            >
              {svg}
            </pre>
          </div>
        </Column>
      )}
    </Column>
  );
});
