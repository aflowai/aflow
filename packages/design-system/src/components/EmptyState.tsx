/**
 * EmptyState — Centered placeholder when there's no content to display.
 * All styling inline via tokens.
 */
import type { ReactNode, CSSProperties } from 'react';

export interface EmptyStateProps {
  /** Icon to display */
  icon?: ReactNode;
  /** Primary message */
  title: string;
  /** Secondary description */
  description?: string;
  /**
   * Rich description (e.g. markdown). When set, replaces the string `description`.
   */
  descriptionContent?: ReactNode;
  /** Action button or link */
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  descriptionContent,
  action,
}: EmptyStateProps) {
  const wrapperStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--space-16) var(--space-6)',
    textAlign: 'center',
    gap: 'var(--space-3)',
  };

  const iconStyle: CSSProperties = {
    color: 'var(--color-border-strong)',
    marginBottom: 'var(--space-1)',
  };

  const titleStyle: CSSProperties = {
    fontSize: 'var(--font-size-lg)',
    fontFamily: 'var(--font-family-title)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'var(--color-text-secondary)',
    margin: 0,
  };

  const descStyle: CSSProperties = {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--color-text-muted)',
    maxWidth: 360,
    lineHeight: 'var(--font-line-height-relaxed)',
  };

  const richDescStyle: CSSProperties = {
    ...descStyle,
    textAlign: 'left',
    width: '100%',
  };

  return (
    <div style={wrapperStyle}>
      {icon && <div style={iconStyle}>{icon}</div>}
      <p style={titleStyle}>{title}</p>
      {descriptionContent != null ? (
        <div style={richDescStyle}>{descriptionContent}</div>
      ) : description ? (
        <p style={descStyle}>{description}</p>
      ) : null}
      {action && <div style={{ marginTop: 'var(--space-2)' }}>{action}</div>}
    </div>
  );
}
