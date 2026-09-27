'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Row, Text } from '@aflow/design-system';

export interface TabDef {
  href: string;
  label: string;
  legacyHref?: string;
}

export function TabNav({ tabs }: { tabs: TabDef[] }) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement>(null);

  // Long tab strips (settings has 11–13 sections) scroll horizontally on
  // narrow viewports; keep the active tab visible without scrolling the page.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [pathname]);

  return (
    <div
      style={{
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        maxWidth: '100%',
      }}
    >
      <Row gap="0" style={{ width: 'max-content', minWidth: '100%' }}>
        {tabs.map((tab) => {
          const isActive = tab.legacyHref
            ? pathname.startsWith(tab.href) || pathname.startsWith(tab.legacyHref)
            : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              {...(isActive ? { ref: activeRef } : {})}
              style={{
                display: 'block',
                padding: 'var(--space-3) var(--space-4)',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                borderBottom: isActive
                  ? '2px solid var(--color-content-primary)'
                  : '2px solid transparent',
              }}
            >
              <Text
                size="sm"
                weight={isActive ? 'semibold' : 'normal'}
                style={{
                  color: isActive
                    ? 'var(--color-content-primary)'
                    : 'var(--color-content-secondary)',
                }}
              >
                {tab.label}
              </Text>
            </Link>
          );
        })}
      </Row>
    </div>
  );
}
