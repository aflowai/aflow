import type { TabDef } from '../../TabNav.js';
import type { Edition } from '../../hooks/useEdition.js';

/**
 * Each tab names the server surface it needs. The server publishes which
 * surfaces it composed, so a tab whose API is not registered in this edition
 * is not rendered — rather than rendered, clicked, and answered with a 404.
 */
export const SETTINGS_TABS: Array<
  TabDef & {
    surface?: string;
    /** Shown only in the local edition, and only to the install's owner. */
    localOwnerOnly?: boolean;
  }
> = [
  { href: '/settings/members', label: 'Members', surface: 'tenant-members' },
  { href: '/settings/invites', label: 'Invites', surface: 'invites' },
  // Space settings reach the membership surface to share a space.
  { href: '/settings/spaces', label: 'Spaces', surface: 'space-members' },
  { href: '/settings/api-keys', label: 'API Keys', surface: 'api-keys' },
  // A profile is how the local edition names who is at the keyboard (Plan 335).
  // The route is registered in both editions and refused in the hosted one,
  // which admits people through its sign-in, so the edition decides the tab and
  // a surface name cannot. Only the owner manages profiles. Placed after API
  // Keys, so Settings still opens on API Keys locally.
  { href: '/settings/profiles', label: 'Profiles', localOwnerOnly: true },
  { href: '/settings/credentials', label: 'Credentials', surface: 'credentials' },
  { href: '/settings/oauth-apps', label: 'OAuth Apps' },
  { href: '/settings/compute', label: 'Compute' },
  // Reading the allowlist is core — the chat model picker needs it — but
  // this page writes it, and that is governance.
  // Instance settings, not governance over other people. Choosing which models
  // this instance's agents may use is the operator configuring their own
  // machine; grouping it with tenant governance withheld it from the edition
  // where the operator IS the tenant, leaving them on the platform default with
  // no way to change it.
  { href: '/settings/models', label: 'Models', surface: 'tenant-settings' },
  {
    href: '/settings/integrations-policy',
    label: 'Integrations Policy',
    surface: 'tenant-governance',
  },
  { href: '/settings/store', label: 'Store', surface: 'tenant-governance' },
  {
    href: '/settings/access-control',
    label: 'Access Control',
    surface: 'admin-capability-profiles',
  },
  {
    href: '/settings/capability-governance',
    label: 'Capability Governance',
    surface: 'admin-capability-governance',
  },
  { href: '/settings/audit', label: 'Audit', surface: 'audit' },
];

/** What decides which settings tabs a viewer sees. */
export interface SettingsTabViewer {
  edition: Pick<Edition, 'id' | 'surfaces'>;
  /** Whether the viewer owns the install. */
  isOwner: boolean;
}

/**
 * The settings tabs this viewer is served, in order.
 *
 * A plain fold so the withholding is testable: the layout pulls the provider
 * stack in behind it, and the web test environment is node-only.
 */
export function visibleSettingsTabs(viewer: SettingsTabViewer): TabDef[] {
  return SETTINGS_TABS.filter(
    (tab) => tab.surface === undefined || viewer.edition.surfaces.has(tab.surface),
  )
    .filter(
      (tab) =>
        tab.localOwnerOnly !== true || (viewer.edition.id === 'community-local' && viewer.isOwner),
    )
    .map(({ href, label }) => ({ href, label }));
}

/**
 * The first tab this viewer is served.
 *
 * The index redirects here rather than to a fixed tab: the fixed one was
 * Members, which the local edition does not register, so opening Settings
 * landed on a page whose every call 404s.
 */
export function firstSettingsTab(viewer: SettingsTabViewer): string {
  return visibleSettingsTabs(viewer)[0]?.href ?? '/settings/spaces';
}
