import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import type { SpaceToken } from '../tokens.js';

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Section title */
  title?: ReactNode;
  /** Section description */
  description?: ReactNode;
  /** Gap between header and body */
  gap?: SpaceToken;
  /** Padding */
  padding?: SpaceToken;
  children?: ReactNode;
}

export const Section = forwardRef<HTMLElement, SectionProps>(function Section(
  { title, description, gap = 'lg', padding, style, children, ...rest },
  ref,
) {
  const s: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: `var(--space-${gap})`,
    ...(padding != null ? { padding: `var(--space-${padding})` } : undefined),
    ...style,
  };

  return (
    <section ref={ref} style={s} {...rest}>
      {(title != null || description != null) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
          {title != null && (
            <h3
              style={{
                fontSize: 'var(--font-size-sm)',
                fontWeight: 'var(--font-weight-medium)',
                color: 'var(--color-content-secondary)',
                letterSpacing: 'var(--font-letter-spacing-wide)',
                textTransform: 'uppercase',
                margin: 0,
              }}
            >
              {title}
            </h3>
          )}
          {description != null && (
            <p
              style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--color-content-muted)',
                margin: 0,
              }}
            >
              {description}
            </p>
          )}
        </div>
      )}
      {children}
    </section>
  );
});
