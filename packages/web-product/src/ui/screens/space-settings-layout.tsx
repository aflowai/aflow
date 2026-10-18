'use client';

import { AppPageHeader } from '../components/app-page-header.js';
import { TabNav, type TabDef } from '../TabNav.js';
import { useSpace } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { useMemo } from 'react';
import { useEdition } from '../hooks/useEdition.js';
import { spaceSettingsTabPaths } from './spaceSettingsTabs.js';

export function SpaceSettingsLayout({ children }: { children: React.ReactNode }) {
  const { activeSpace } = useSpace();
  const edition = useEdition();
  const spaceSlug = activeSpace?.slug;

  const tabs: TabDef[] = useMemo(
    () =>
      spaceSettingsTabPaths(edition).map((tab) => ({
        label: tab.label,
        href: spaceRoute(spaceSlug, tab.path),
        legacyHref: `/spaces${tab.path}`,
      })),
    [spaceSlug, edition],
  );

  return (
    <>
      <AppPageHeader title="Space Settings" tabs={<TabNav tabs={tabs} />} />
      {children}
    </>
  );
}
