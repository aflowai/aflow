import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  children?: ReactNode;
}

/**
 * Styled HTML table with good defaults: full width, collapsed borders,
 * consistent cell padding, and themed header/row styling.
 *
 * Wrapped in a horizontal scroll container so wide tables scroll in place
 * instead of stretching the page sideways on narrow viewports.
 *
 * Composes with standard <thead>, <tbody>, <Th>, <Td>, and <Tr>.
 */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--font-size-xs)',
    ...style,
  };

  const scrollWrapperStyle: React.CSSProperties = {
    width: '100%',
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
  };

  return (
    <div style={scrollWrapperStyle}>
      <table ref={ref} style={s} {...rest}>
        {children}
      </table>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Th — table header cell
// ---------------------------------------------------------------------------

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
}

export const Th = forwardRef<HTMLTableCellElement, ThProps>(function Th(
  { style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    textAlign: 'left',
    padding: '6px 8px',
    fontWeight: 'var(--font-weight-medium)' as unknown as number,
    color: 'var(--color-content-secondary)',
    fontSize: 'var(--font-size-xs)',
    whiteSpace: 'nowrap',
    ...style,
  };

  return (
    <th ref={ref} style={s} {...rest}>
      {children}
    </th>
  );
});

// ---------------------------------------------------------------------------
// Td — table data cell
// ---------------------------------------------------------------------------

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
}

export const Td = forwardRef<HTMLTableCellElement, TdProps>(function Td(
  { style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    padding: '6px 8px',
    verticalAlign: 'top',
    ...style,
  };

  return (
    <td ref={ref} style={s} {...rest}>
      {children}
    </td>
  );
});

// ---------------------------------------------------------------------------
// Tr — table row with bottom border by default
// ---------------------------------------------------------------------------

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Dim the row (e.g. for de-emphasized/internal items) */
  muted?: boolean | undefined;
  children?: ReactNode;
}

export const Tr = forwardRef<HTMLTableRowElement, TrProps>(function Tr(
  { muted = false, style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    borderBottom: '1px solid var(--color-border-subtle)',
    ...(muted ? { opacity: 0.5 } : undefined),
    ...style,
  };

  return (
    <tr ref={ref} style={s} {...rest}>
      {children}
    </tr>
  );
});
