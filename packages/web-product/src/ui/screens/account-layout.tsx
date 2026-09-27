'use client';

import { AppPageHeader } from '../components/app-page-header.js';
import { TabNav } from '../TabNav.js';
import type { TabDef } from '../TabNav.js';
import { useEdition } from '../hooks/useEdition.js';

export function AccountLayout({ children }: { children: React.ReactNode }) {
  const edition = useEdition();

  // Connected accounts are identity-provider links. The local edition has no
  // identity provider, so the page has nothing to show and no way to add one.
  const tabs: TabDef[] = [
    { href: '/account/profile', label: 'Profile' },
    // Only where an identity provider is known to exist. An unknown edition
    // does not get the benefit of the doubt: the tab would render, be clicked,
    // and land on a page the local edition has nothing to fill.
    ...(edition.id === 'enterprise'
      ? [{ href: '/account/connected-accounts', label: 'Connected accounts' }]
      : []),
  ];

  return (
    <>
      <AppPageHeader title="Account" showSpace={false} tabs={<TabNav tabs={tabs} />} />
      {children}
    </>
  );
}
