'use client';

import { useState, type CSSProperties } from 'react';
import { Icon } from '../icons/Icon.js';
import { IconButton } from '../primitives/Button.js';

export interface JsonViewerProps {
  /** JSON data to display */
  data: unknown;
  /** Initial collapsed state */
  collapsed?: boolean;
  /** Collapse depth (nodes deeper than this are collapsed by default) */
  collapseDepth?: number;
  /** Maximum height before scrolling */
  maxHeight?: string;
  /** Show copy-to-clipboard control (pretty-printed JSON) */
  copyable?: boolean;
  /** Additional class name */
  className?: string;
}

function jsonStringForCopy(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Unable to copy: value is not JSON-serializable]';
  }
}

export function JsonViewer({
  data,
  collapsed = true,
  collapseDepth = 2,
  maxHeight,
  copyable = true,
  className = '',
}: JsonViewerProps) {
  const [copied, setCopied] = useState(false);

  const containerStyle: CSSProperties = {
    ...(copyable ? { position: 'relative' as const } : {}),
    fontFamily: 'var(--font-family-mono)',
    fontSize: 'var(--font-size-xs)',
    backgroundColor: 'var(--color-surface-1)',
    borderRadius: 'var(--radius-md)',
    padding: copyable
      ? 'var(--space-2) calc(var(--space-2) + 2.25rem) var(--space-2) var(--space-2)'
      : 'var(--space-2)',
    overflow: 'auto',
    ...(maxHeight ? { maxHeight } : {}),
  };

  const handleCopy = async () => {
    const text = jsonStringForCopy(data);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    }
  };

  return (
    <div className={className} style={containerStyle}>
      {copyable ? (
        <IconButton
          icon={<Icon name={copied ? 'check' : 'copy'} size="xs" />}
          aria-label={copied ? 'Copied' : 'Copy JSON'}
          variant="ghost"
          size="sm"
          style={{
            position: 'absolute',
            top: 'var(--space-1)',
            right: 'var(--space-1)',
            zIndex: 1,
          }}
          onClick={() => {
            void handleCopy();
          }}
        />
      ) : null}
      <JsonNode data={data} depth={0} initialCollapsed={collapsed} collapseDepth={collapseDepth} />
    </div>
  );
}

interface JsonNodeProps {
  data: unknown;
  depth: number;
  initialCollapsed: boolean;
  collapseDepth: number;
  keyName?: string;
}

function JsonNode({ data, depth, initialCollapsed, collapseDepth, keyName }: JsonNodeProps) {
  const shouldStartCollapsed = initialCollapsed || depth >= collapseDepth;
  const [isCollapsed, setIsCollapsed] = useState(shouldStartCollapsed);

  const indent = depth * 16;

  if (data === null) {
    return (
      <div style={{ marginLeft: indent }}>
        {keyName && <JsonKey name={keyName} />}
        <span style={{ color: 'var(--color-text-muted)' }}>null</span>
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div style={{ marginLeft: indent }}>
        {keyName && <JsonKey name={keyName} />}
        <span style={{ color: 'var(--color-text-muted)' }}>undefined</span>
      </div>
    );
  }

  if (typeof data === 'boolean') {
    return (
      <div style={{ marginLeft: indent }}>
        {keyName && <JsonKey name={keyName} />}
        <span style={{ color: 'var(--color-interactive-default)' }}>{String(data)}</span>
      </div>
    );
  }

  if (typeof data === 'number') {
    return (
      <div style={{ marginLeft: indent }}>
        {keyName && <JsonKey name={keyName} />}
        <span style={{ color: 'var(--color-status-succeeded)' }}>{data}</span>
      </div>
    );
  }

  if (typeof data === 'string') {
    return (
      <div style={{ marginLeft: indent }}>
        {keyName && <JsonKey name={keyName} />}
        <span style={{ color: 'var(--color-warning-default)' }}>"{data}"</span>
      </div>
    );
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return (
        <div style={{ marginLeft: indent }}>
          {keyName && <JsonKey name={keyName} />}
          <span>[]</span>
        </div>
      );
    }

    return (
      <div style={{ marginLeft: indent }}>
        <button
          type="button"
          onClick={() => {
            setIsCollapsed(!isCollapsed);
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            marginRight: 'var(--space-1)',
            color: 'var(--color-text-muted)',
          }}
        >
          {isCollapsed ? '▶' : '▼'}
        </button>
        {keyName && <JsonKey name={keyName} />}
        <span>[</span>
        {isCollapsed ? (
          <span style={{ color: 'var(--color-text-muted)' }}> {data.length} items ]</span>
        ) : (
          <>
            {(data as unknown[]).map((item, index) => (
              <JsonNode
                key={index}
                data={item}
                depth={depth + 1}
                initialCollapsed={initialCollapsed}
                collapseDepth={collapseDepth}
              />
            ))}
            <div style={{ marginLeft: indent }}>]</div>
          </>
        )}
      </div>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);

    if (entries.length === 0) {
      return (
        <div style={{ marginLeft: indent }}>
          {keyName && <JsonKey name={keyName} />}
          <span>{'{}'}</span>
        </div>
      );
    }

    return (
      <div style={{ marginLeft: indent }}>
        <button
          type="button"
          onClick={() => {
            setIsCollapsed(!isCollapsed);
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            marginRight: 'var(--space-1)',
            color: 'var(--color-text-muted)',
          }}
        >
          {isCollapsed ? '▶' : '▼'}
        </button>
        {keyName && <JsonKey name={keyName} />}
        <span>{'{'}</span>
        {isCollapsed ? (
          <span style={{ color: 'var(--color-text-muted)' }}>
            {' '}
            {entries.length} keys {'}'}
          </span>
        ) : (
          <>
            {entries.map(([key, value]) => (
              <JsonNode
                key={key}
                data={value}
                depth={depth + 1}
                initialCollapsed={initialCollapsed}
                collapseDepth={collapseDepth}
                keyName={key}
              />
            ))}
            <div style={{ marginLeft: indent }}>{'}'}</div>
          </>
        )}
      </div>
    );
  }

  return (
    <span>
      {typeof data === 'object' && data !== null
        ? JSON.stringify(data)
        : String((data ?? '') as string | number | boolean)}
    </span>
  );
}

function JsonKey({ name }: { name: string }) {
  return <span style={{ color: 'var(--color-text-secondary)' }}>"{name}": </span>;
}
