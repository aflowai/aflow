'use client';

import { memo, type ComponentPropsWithoutRef, type CSSProperties } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock, JsonViewer, Table, Th, Td, Tr } from '@aflow/design-system';
import { parseCsvRow, MAX_CSV_ROWS } from '../lib/csv-utils.js';
import './markdown-renderer.css';

function CsvTable({ text }: { text: string }) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return <p>Empty dataset.</p>;
  const headers = parseCsvRow(lines[0] ?? '');
  const totalRows = lines.length - 1;
  const rows = lines.slice(1, MAX_CSV_ROWS + 1).map(parseCsvRow);

  return (
    <div style={{ overflow: 'auto', maxHeight: 400 }}>
      <Table>
        <thead>
          <Tr>
            {headers.map((h, i) => (
              <Th key={i}>{h}</Th>
            ))}
          </Tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <Tr key={ri}>
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
        <p
          style={{
            color: 'var(--color-content-tertiary)',
            fontSize: 'var(--font-size-xs)',
            textAlign: 'center',
          }}
        >
          Showing {MAX_CSV_ROWS} of {totalRows} rows
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared link override
// ---------------------------------------------------------------------------

const NEXT_PUBLIC_BASE_URL = process.env['NEXT_PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? '';

function isSameOrigin(href: string): boolean {
  if (!href) return false;
  if (href.startsWith('/') && !href.startsWith('//')) return true;
  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(href).origin;
  } catch {
    return false;
  }
  if (NEXT_PUBLIC_BASE_URL && href.startsWith(NEXT_PUBLIC_BASE_URL)) return true;
  if (typeof window !== 'undefined' && candidateOrigin === window.location.origin) {
    return true;
  }
  return false;
}

function toInternalPath(href: string): string {
  if (href.startsWith('/')) return href;
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

function LinkComponent({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href && isSameOrigin(href)) {
    // Drop `target` / `rel` — same-origin links should keep the user inside the SPA.
    const { target: _t, rel: _r, ...safeRest } = rest;
    void _t;
    void _r;
    return (
      <Link href={toInternalPath(href)} {...(safeRest as Record<string, unknown>)}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Code-block override factory
// ---------------------------------------------------------------------------

function makeCodeComponent(jsonTree: boolean) {
  return function CodeComponent({
    className,
    children,
    ...rest
  }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const text = (
      typeof children === 'object' && children !== null
        ? JSON.stringify(children)
        : String(children ?? '')
    ).replace(/\n$/, '');

    // Block code (inside <pre>) has a language- class or is multi-line
    if (match ?? text.includes('\n')) {
      const lang = match?.[1];

      // CSV code blocks → interactive table
      if (lang === 'csv') {
        return <CsvTable text={text} />;
      }

      // When jsonTree is enabled, try to parse JSON code blocks as interactive trees
      if (jsonTree) {
        if (lang === 'json' || lang === 'jsonc' || !lang) {
          try {
            const parsed = JSON.parse(text) as unknown;
            return <JsonViewer data={parsed} collapseDepth={2} maxHeight="240px" />;
          } catch {
            // Not valid JSON — fall through to CodeBlock
          }
        }
      }

      return (
        <CodeBlock {...(lang !== undefined ? { language: lang } : {})} copyable>
          {text}
        </CodeBlock>
      );
    }

    // Inline code — let CSS handle it
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  };
}

// ---------------------------------------------------------------------------
// Pre-built component sets (stable references for memo)
// ---------------------------------------------------------------------------

function PrePassthrough({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

const markdownComponents: ComponentPropsWithoutRef<typeof ReactMarkdown>['components'] = {
  pre: PrePassthrough,
  code: makeCodeComponent(false),
  a: LinkComponent,
};

const markdownComponentsJsonTree: ComponentPropsWithoutRef<typeof ReactMarkdown>['components'] = {
  pre: PrePassthrough,
  code: makeCodeComponent(true),
  a: LinkComponent,
};

/** Singleton plugin array — avoids re-creating on every render */
const remarkPlugins = [remarkGfm];

export interface MarkdownRendererProps {
  /** Markdown source text */
  content: string;
  /** Additional class name */
  className?: string;
  /** Inline style on the `.md-content` wrapper — e.g. `{ color: ... }` to override the default text color */
  style?: CSSProperties | undefined;
  /** Render JSON fenced code blocks as interactive JsonViewer trees */
  jsonTree?: boolean;
}

/**
 * MarkdownRenderer — renders markdown content with GFM support.
 *
 * Features:
 * - GitHub-flavored markdown (tables, strikethrough, task lists, autolinks)
 * - Fenced code blocks rendered via the design-system CodeBlock component
 * - Optional: JSON code blocks as interactive JsonViewer trees (jsonTree prop)
 * - Links open in new tab
 * - Styled with design tokens (scoped under .md-content)
 *
 * Memoized to avoid re-parsing unchanged content.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className = '',
  style,
  jsonTree = false,
}: MarkdownRendererProps) {
  const components = jsonTree ? markdownComponentsJsonTree : markdownComponents;

  return (
    <div className={`md-content ${className}`} style={style}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
