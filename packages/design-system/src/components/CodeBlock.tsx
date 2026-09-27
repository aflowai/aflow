'use client';

import React, { useState } from 'react';

export interface CodeBlockProps {
  /** Code content */
  children: string;
  /** Language label */
  language?: string;
  /** Custom title */
  title?: string;
  /** Show copy button */
  copyable?: boolean;
  /** Maximum height before scrolling */
  maxHeight?: string;
  /** Additional class name */
  className?: string;
}

/** 14×14 copy icon (Phosphor-style) */
const CopyIcon = (
  <svg width="14" height="14" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M184 64H40a8 8 0 0 0-8 8v144a8 8 0 0 0 8 8h144a8 8 0 0 0 8-8V72a8 8 0 0 0-8-8Zm-8 144H48V80h128Z"
      fill="currentColor"
    />
    <path d="M224 24H72v16h144v144h16V32a8 8 0 0 0-8-8Z" fill="currentColor" />
  </svg>
);

/** 14×14 check icon */
const CheckIcon = (
  <svg width="14" height="14" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="m229.66 77.66-128 128a8 8 0 0 1-11.32 0l-56-56a8 8 0 0 1 11.32-11.32L96 188.69 218.34 66.34a8 8 0 0 1 11.32 11.32Z"
      fill="currentColor"
    />
  </svg>
);

export function CodeBlock({
  children,
  language,
  title,
  copyable = true,
  maxHeight,
  className = '',
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = children;
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

  const label = title ?? language ?? '';
  const hasLabel = label.length > 0;

  const copyButton = copyable ? (
    <button
      type="button"
      className="ds-code-block__copy"
      onClick={() => {
        void handleCopy();
      }}
      aria-label={copied ? 'Copied!' : 'Copy code'}
    >
      {copied ? CheckIcon : CopyIcon}
    </button>
  ) : null;

  return (
    <div className={`ds-code-block ${className}`}>
      {hasLabel && (
        <div className="ds-code-block__header">
          <span className="ds-code-block__label">{label}</span>
          {copyButton}
        </div>
      )}
      <div
        className="ds-code-block__content"
        style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}
      >
        <pre>
          <code>{children}</code>
        </pre>
      </div>
      {/* No label → float copy icon over top-right corner, visible on hover */}
      {!hasLabel && copyButton}
    </div>
  );
}
