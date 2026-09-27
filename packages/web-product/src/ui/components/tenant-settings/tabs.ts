import type { TabDef } from '../../TabNav.js';

/**
 * Each tab names the server surface it needs. The server publishes which
 * surfaces it composed, so a tab whose API is not registered in this edition
 * is not rendered — rather than rendered, clicked, and answered with a 404.
 */
export const SETTINGS_TABS: Array<TabDef & { surface?: string }> = [
  { href: '/settings/members', label: 'Members', surface: 'tenant-members' },
  { href: '/settings/invites', label: 'Invites', surface: 'invites' },
  // Space settings reach the membership surface to share a space.
  { href: '/settings/spaces', label: 'Spaces', surface: 'space-members' },
  { href: '/settings/api-keys', label: 'API Keys', surface: 'api-keys' },
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

/**
 * The first tab this edition actually serves.
 *
 * The index redirects here rather than to a fixed tab: the fixed one was
 * Members, which the local edition does not register, so opening Settings
 * landed on a page whose every call 404s.
 */
export function firstSettingsTab(surfaces: ReadonlySet<string>): string {
  const tab = SETTINGS_TABS.find((t) => t.surface === undefined || surfaces.has(t.surface));
  return tab?.href ?? '/settings/spaces';
}
