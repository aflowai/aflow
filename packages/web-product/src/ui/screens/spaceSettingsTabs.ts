import type { Edition } from '../hooks/useEdition.js';

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
  // A space-scoped OAuth client belongs to the hosted product, where one
  // tenant's spaces each bring their own so a provider's consent screen names
  // the organisation that asked. An appliance has one owner and one tenant, and
  // registers its clients once at instance Settings → OAuth Apps; a second,
  // space-scoped copy of the same registry only splits the operator's own
  // credentials in two. The edition decides it: the route is registered in both,
  // so there is no withheld surface to ask about.
  { path: '/settings/oauth-apps', label: 'OAuth Apps', enterpriseOnly: true },
  { path: '/settings/danger', label: 'Danger zone' },
];

export interface SpaceSettingsTab {
  path: string;
  label: string;
}

/**
 * The space-settings tabs this edition serves, in order.
 *
 * Its own module and a plain fold so the withholding is testable: the layout it
 * belongs to pulls the provider stack in behind it, and the web test
 * environment is node-only.
 */
export function spaceSettingsTabPaths(
  edition: Pick<Edition, 'id' | 'surfaces'>,
  showMemory: boolean,
): SpaceSettingsTab[] {
  const paths = [...TAB_PATHS];
  if (showMemory) {
    const rulesIdx = paths.findIndex((t) => t.path === '/settings/rules');
    paths.splice(rulesIdx + 1, 0, { path: '/settings/memory', label: 'Memory' });
  }
  return paths
    .filter((tab) => tab.surface === undefined || edition.surfaces.has(tab.surface))
    .filter((tab) => tab.enterpriseOnly !== true || edition.id === 'enterprise')
    .map((tab) => ({ path: tab.path, label: tab.label }));
}
