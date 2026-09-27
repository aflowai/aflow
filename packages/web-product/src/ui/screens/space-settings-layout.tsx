'use client';

import { AppPageHeader } from '../components/app-page-header.js';
import { TabNav, type TabDef } from '../TabNav.js';
import { isSoloSpace, useSpace } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { useMemo } from 'react';
import { useEdition } from '../hooks/useEdition.js';

// A tab naming a surface is shown only where the server composed it — the
// page behind it is served by that surface and 404s without it.
const TAB_PATHS: Array<{
  path: string;
  label: string;
  surface?: string;
  /** Shown only where the capability behind it can run at all. */
  enterpriseOnly?: boolean;
}> = [
  { path: '/settings/general', label: 'General' },
  { path: '/settings/agent', label: 'Agent' },
  { path: '/settings/rules', label: 'Rules' },
  // Memory is inserted here only for solo (owner-only) spaces — see below.
  { path: '/settings/compute', label: 'Compute' },
  // The lane is cloud-owned and absent from the local artifact, so a local
  // instance has nothing to run a code step on. Offering the tab there lets an
  // operator configure a lane and meet its refusal one run later. The edition
  // decides it, not a surface: no route is withheld to ask about.
  { path: '/settings/code', label: 'Coding Lane', enterpriseOnly: true },
  { path: '/settings/write-policy', label: 'Write Policy' },
  { path: '/settings/members', label: 'Members', surface: 'space-members' },
  { path: '/settings/credentials', label: 'Credentials' },
  { path: '/settings/oauth-apps', label: 'OAuth Apps' },
  { path: '/settings/danger', label: 'Danger zone' },
];

export function SpaceSettingsLayout({ children }: { children: React.ReactNode }) {
  const { activeSpace } = useSpace();
  const edition = useEdition();
  const spaceSlug = activeSpace?.slug;
  // The agent-memory register only functions in a solo space, so the tab
  // appears only there rather than everywhere with a disabled warning.
  const showMemory = activeSpace ? isSoloSpace(activeSpace) : false;

  const tabs: TabDef[] = useMemo(() => {
    const paths = [...TAB_PATHS];
    if (showMemory) {
      const rulesIdx = paths.findIndex((t) => t.path === '/settings/rules');
      paths.splice(rulesIdx + 1, 0, { path: '/settings/memory', label: 'Memory' });
    }
    return paths
      .filter((tab) => tab.surface === undefined || edition.surfaces.has(tab.surface))
      .filter((tab) => tab.enterpriseOnly !== true || edition.id === 'enterprise')
      .map((tab) => ({
        label: tab.label,
        href: spaceRoute(spaceSlug, tab.path),
        legacyHref: `/spaces${tab.path}`,
      }));
  }, [spaceSlug, showMemory, edition.id, edition.isLoading, edition.surfaces]);

  return (
    <>
      <AppPageHeader title="Space Settings" tabs={<TabNav tabs={tabs} />} />
      {children}
    </>
  );
}
