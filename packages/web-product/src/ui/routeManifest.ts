/**
 * Which screen serves which route, and in which editions.
 *
 * Next resolves routes from the filesystem, so a screen living in this package
 * cannot become a route by being exported — each application needs a file at the
 * right path. Those files are identical apart from the screen they name, and
 * writing them twice is two route trees to keep in step. They are generated from
 * this table instead (`yarn web:routes`), and a guard fails if the tree on disk
 * and the table disagree.
 *
 * **Editions are stated here, not inferred.** A route absent from an edition is
 * absent from its build rather than present and refused, which is the whole point
 * of the artifact boundary: an edition that composes fewer routes from an image
 * containing every route withholds nothing from a reader of that image.
 */
export type WebEdition = 'hosted' | 'local';

export interface RouteEntry {
  /** Path under `src/app/(dashboard)/`, exactly as Next resolves it. */
  route: string;
  /** Named export of the screen, re-exported as the route's default. */
  screen: string;
  /** Editions whose build carries this route. */
  editions: readonly WebEdition[];
  /**
   * Which framework file this becomes — a page, or the layout wrapping the
   * pages beneath it. Both are a default export to Next, so the entry file is
   * the same shape either way; only the filename differs, and that is what
   * decides whether the routes under it get their chrome.
   */
  kind?: 'page' | 'layout';
}

const BOTH: readonly WebEdition[] = ['hosted', 'local'];

export const ROUTE_MANIFEST: readonly RouteEntry[] = [
  { route: 's/[space]/settings/memory', screen: 'AgentMemoryPage', editions: BOTH },
  // `apps/aflow-executor-code` is cloud-owned, so a local build has no lane to
  // configure. The hosted application keeps the route because it serves both
  // editions and hides the tab in one of them.
  { route: 's/[space]/settings/code', screen: 'SpaceCodePolicyPage', editions: ['hosted'] },
  { route: 's/[space]/settings/write-policy', screen: 'SpaceWritePolicyPage', editions: BOTH },
  { route: 's/[space]/settings/compute', screen: 'SpaceComputePage', editions: BOTH },
  { route: 's/[space]/settings/rules', screen: 'SpaceRulesPage', editions: BOTH },
  { route: 's/[space]/settings/danger', screen: 'DangerZonePage', editions: BOTH },
  { route: 's/[space]/triggers', screen: 'TriggersPage', editions: BOTH },
  { route: 's/[space]/chat', screen: 'ChatPage', editions: BOTH },
  { route: 's/[space]/skills', screen: 'SkillsPage', editions: BOTH },
  { route: 's/[space]/integrations', screen: 'SpaceIntegrationsPage', editions: BOTH },
  { route: 's/[space]/memory', screen: 'SpaceMemoryPage', editions: BOTH },
  { route: 's/[space]/memory/[...path]', screen: 'SpaceMemoryPathPage', editions: BOTH },
  // Membership is a tenant relationship. A single-user appliance has no members
  // to manage, which is why the settings strip withholds the tab there; the
  // route follows, so the local build carries neither.
  { route: 's/[space]/settings/members', screen: 'SpaceMembersPage', editions: ['hosted'] },
  { route: 's/[space]/agents/new', screen: 'AgentNewPage', editions: BOTH },
  { route: 's/[space]/agents/[agentId]', screen: 'AgentDetailPage', editions: BOTH },
  { route: 's/[space]/agents/[agentId]/edit', screen: 'AgentEditPage', editions: BOTH },
  { route: 's/[space]/runs/[runId]', screen: 'RunRedirectPage', editions: BOTH },

  // Tenant-level surfaces. Which edition serves each one is not a judgement
  // here: the settings tab strip already names the server surface every tab
  // needs, and a surface only the hosted composition registers makes its route
  // hosted too — otherwise the tab is withheld and the route it would have
  // opened answers every call with a 404.
  { route: 'account', screen: 'AccountLayout', editions: BOTH, kind: 'layout' },
  { route: 'account', screen: 'AccountIndexPage', editions: BOTH },
  { route: 'account/profile', screen: 'AccountProfilePage', editions: BOTH },
  // Connected accounts are identity-provider links, and the local edition has
  // no provider — the account tab strip withholds the tab for the same reason.
  { route: 'account/connected-accounts', screen: 'ConnectedAccountsPage', editions: ['hosted'] },
  { route: 'settings', screen: 'TenantSettingsLayout', editions: BOTH, kind: 'layout' },
  { route: 'settings', screen: 'TenantSettingsIndex', editions: BOTH },
  { route: 'settings/api-keys', screen: 'TenantApiKeysPage', editions: BOTH },
  { route: 'settings/credentials', screen: 'TenantCredentialsPage', editions: BOTH },
  { route: 'settings/oauth-apps', screen: 'TenantOAuthAppsPage', editions: BOTH },
  { route: 'settings/compute', screen: 'TenantComputePolicyPage', editions: BOTH },
  { route: 'settings/models', screen: 'TenantModelsPage', editions: BOTH },
  { route: 'settings/access-control', screen: 'TenantAccessControlPage', editions: BOTH },
  { route: 'settings/agent-policies', screen: 'TenantAgentPoliciesPage', editions: BOTH },
  // `tenant-governance` and `space-members` are hosted compositions: an
  // appliance has no other members to govern.
  {
    route: 'settings/integrations-policy',
    screen: 'TenantIntegrationsPolicyPage',
    editions: ['hosted'],
  },
  { route: 'settings/store', screen: 'TenantStorePolicyPage', editions: ['hosted'] },
  { route: 'settings/spaces', screen: 'TenantSpacesPage', editions: ['hosted'] },
  { route: 'spaces', screen: 'SpacesIndexPage', editions: BOTH },
  { route: 'spaces/archived', screen: 'ArchivedSpacesPage', editions: BOTH },
  { route: 's/[space]/settings/credentials', screen: 'SpaceCredentialsPage', editions: BOTH },
  { route: 's/[space]/settings/general', screen: 'SpaceGeneralPage', editions: BOTH },
  { route: 's/[space]/settings/oauth-apps', screen: 'SpaceOAuthAppsPage', editions: BOTH },
  { route: 's/[space]/settings/agent', screen: 'CyberneticSettingsPage', editions: BOTH },
  // The settings chrome: the tab strip every settings screen renders inside.
  // Without it those routes render bare, which is what the local application did
  // while its pages were generated and this was not.
  { route: 's/[space]/settings', screen: 'SpaceSettingsLayout', editions: BOTH, kind: 'layout' },
  { route: 's/[space]/skills', screen: 'SkillsLayout', editions: BOTH, kind: 'layout' },
  { route: 's/[space]/skills/[slug]', screen: 'SkillSlugRedirect', editions: BOTH },
  { route: 's/[space]', screen: 'SpaceIndex', editions: BOTH },
  { route: 's/[space]/settings', screen: 'SettingsIndex', editions: BOTH },
  { route: 's/[space]/applets', screen: 'AppletsPage', editions: BOTH },
  { route: 's/[space]/applets/[instanceId]', screen: 'AppletInstancePage', editions: BOTH },
  { route: 's/[space]/catalog', screen: 'CatalogPage', editions: BOTH },
  { route: 's/[space]/store', screen: 'StorePage', editions: BOTH },
  { route: 's/[space]/store/[catalogId]', screen: 'StoreListingPage', editions: BOTH },
  {
    route: 's/[space]/integrations/simulations/[simulationId]',
    screen: 'SimulationInspectorPage',
    editions: BOTH,
  },
  { route: 's/[space]/agents', screen: 'FlowsPage', editions: BOTH },
  { route: 's/[space]/sessions', screen: 'RunsPage', editions: BOTH },
  { route: 's/[space]/sessions/[sessionId]', screen: 'RunDetailsPage', editions: BOTH },
  // Host pairing binds a machine to this instance. The hosted deployment has no
  // machine to pair, which is why the nav withholds it there; the route follows,
  // so the build does not carry a page every action on it would be refused.
  { route: 's/[space]/computer', screen: 'SpaceHostBindingsPage', editions: ['local'] },
];
