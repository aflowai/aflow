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

interface MarkdownTreeNode {
  type: string;
  value?: string;
  children?: MarkdownTreeNode[];
}

function breakEveryLine(node: MarkdownTreeNode): void {
  if (node.children === undefined) return;
  node.children = node.children.flatMap((child): MarkdownTreeNode[] => {
    if (child.type !== 'text' || child.value?.includes('\n') !== true) {
      breakEveryLine(child);
      return [child];
    }
    return child.value
      .split('\n')
      .flatMap((line, i): MarkdownTreeNode[] => [
        ...(i > 0 ? [{ type: 'break' }] : []),
        ...(line.length > 0 ? [{ type: 'text', value: line }] : []),
      ]);
  });
}

/**
 * Turns each soft line break into a hard one, so text written one entry per
 * line, joined by a single newline, keeps its lines. Code keeps its own newlines.
 */
function remarkBreakEveryLine() {
  return breakEveryLine;
}

const lineBreakRemarkPlugins = [remarkGfm, remarkBreakEveryLine];

export interface MarkdownRendererProps {
  /** Markdown source text */
  content: string;
  /** Additional class name */
  className?: string;
  /** Inline style on the `.md-content` wrapper — e.g. `{ color: ... }` to override the default text color */
  style?: CSSProperties | undefined;
  /** Render JSON fenced code blocks as interactive JsonViewer trees */
  jsonTree?: boolean;
  /** Break the line at every newline, for text written one entry per line */
  lineBreaks?: boolean;
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
  lineBreaks = false,
}: MarkdownRendererProps) {
  const components = jsonTree ? markdownComponentsJsonTree : markdownComponents;

  return (
    <div className={`md-content ${className}`} style={style}>
      <ReactMarkdown
        remarkPlugins={lineBreaks ? lineBreakRemarkPlugins : remarkPlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** What a line of text keeps of markdown: emphasis, code and links. Blocks unwrap to their text. */
const INLINE_MARKDOWN_ELEMENTS = ['p', 'strong', 'em', 'del', 'code', 'a', 'br'];

function InlineCode({ children }: { children?: React.ReactNode }) {
  return <code>{children}</code>;
}

const inlineMarkdownComponents: ComponentPropsWithoutRef<typeof ReactMarkdown>['components'] = {
  p: PrePassthrough,
  code: InlineCode,
  a: LinkComponent,
};

export interface InlineMarkdownProps {
  /** Markdown source text, one line as a title holds it */
  content: string;
  className?: string;
  style?: CSSProperties | undefined;
}

/**
 * InlineMarkdown — renders markdown inside a line of text, such as a title.
 * It keeps emphasis, inline code and links, and unwraps every block to its
 * text, so a heading or a list in a title reads as words, not as markup.
 * It inherits the colour and line height of the text around it.
 */
export const InlineMarkdown = memo(function InlineMarkdown({
  content,
  className = '',
  style,
}: InlineMarkdownProps) {
  return (
    <span className={`md-content md-inline ${className}`} style={style}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        allowedElements={INLINE_MARKDOWN_ELEMENTS}
        unwrapDisallowed
        components={inlineMarkdownComponents}
      >
        {content}
      </ReactMarkdown>
    </span>
  );
});
