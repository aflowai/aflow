'use client';

import { Row, Text, Icon } from '@aflow/design-system';

export interface PathBreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
}

export function PathBreadcrumb({ path, onNavigate }: PathBreadcrumbProps) {
  const segments = path.split('/').filter(Boolean);
  const crumbs = segments.map((seg, i) => ({
    label: seg,
    path: '/' + segments.slice(0, i + 1).join('/') + '/',
  }));

  const crumbStyle = (isActive: boolean): React.CSSProperties => ({
    background: 'none',
    border: 'none',
    cursor: isActive ? 'default' : 'pointer',
    padding: '2px 4px',
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
  });

  return (
    <Row gap="1" align="center" wrap>
      <button
        onClick={() => {
          onNavigate('/');
        }}
        style={crumbStyle(path === '/')}
        aria-label="Root directory"
      >
        <Icon name="home" size="sm" weight={path === '/' ? 'fill' : 'regular'} />
      </button>
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <Row key={crumb.path} gap="1" align="center">
            <Icon name="caret-right" size="xs" style={{ color: 'var(--color-text-muted)' }} />
            <button
              onClick={() => {
                onNavigate(crumb.path);
              }}
              style={crumbStyle(isLast)}
            >
              <Text size="sm" variant={isLast ? undefined : 'muted'}>
                {crumb.label}
              </Text>
            </button>
          </Row>
        );
      })}
    </Row>
  );
}
