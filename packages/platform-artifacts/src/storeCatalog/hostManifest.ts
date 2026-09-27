import { getOAuthIssuer, type ConnectorCatalogEntry, type SkillBundle } from '@aflow/schemas';

type BundledApiDraft = SkillBundle['apiDefinitions'][number]['definition'];

function urlHost(url: string): string {
  return new URL(url).hostname;
}

/**
 * A baseUrlTemplate host is only knowable up to its placeholder labels
 * (`{domain}.atlassian.net`), so the manifest entry widens every label up to
 * and including the last placeholder into a single wildcard.
 *
 * Distinct from `deriveHostFromBaseUrlTemplate` in @aflow/schemas: manifest
 * patterns must be `*.suffix`-shaped (the host-pattern grammar admits only a
 * leading wildcard), while egress seeding substitutes `*` in place per
 * placeholder. Do not unify them.
 */
export function templateHostPattern(template: string): string {
  const authority = template.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? '';
  const host = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  const labels = host.split('.');
  let lastPlaceholder = -1;
  for (const [index, label] of labels.entries()) {
    if (label.includes('{')) lastPlaceholder = index;
  }
  if (lastPlaceholder === -1) return host;
  return `*.${labels.slice(lastPlaceholder + 1).join('.')}`;
}

function apiDraftHosts(definition: BundledApiDraft): string[] {
  const hosts: string[] = [];
  if (definition.baseUrl !== undefined) hosts.push(urlHost(definition.baseUrl));
  if (definition.baseUrlTemplate !== undefined) {
    hosts.push(templateHostPattern(definition.baseUrlTemplate));
  }
  hosts.push(...(definition.suggestedEgressPolicy?.additionalHosts ?? []));
  return hosts;
}

export function issuerHosts(issuerKey: string): string[] {
  const issuer = getOAuthIssuer(issuerKey);
  if (!issuer) return [];
  const hosts =
    'discoveryUrl' in issuer.endpoints
      ? [urlHost(issuer.endpoints.discoveryUrl), ...issuer.endpoints.endpointHosts]
      : [urlHost(issuer.endpoints.authorizationServer), urlHost(issuer.endpoints.tokenEndpoint)];
  return [...new Set(hosts)];
}

function sortedUnique(hosts: readonly string[]): string[] {
  return [...new Set(hosts)].sort();
}

export interface DerivedHostManifest {
  apiHosts: string[];
  oauthHosts: string[];
  mcpHosts: string[];
}

export function deriveApiConnectorHostManifest(entry: ConnectorCatalogEntry): DerivedHostManifest {
  const apiHosts: string[] = [];
  if (entry.definition.baseUrl !== undefined) apiHosts.push(urlHost(entry.definition.baseUrl));
  if (entry.definition.baseUrlTemplate !== undefined) {
    apiHosts.push(templateHostPattern(entry.definition.baseUrlTemplate));
  }
  apiHosts.push(...(entry.definition.suggestedEgressPolicy?.additionalHosts ?? []));
  return {
    apiHosts: sortedUnique(apiHosts),
    oauthHosts: sortedUnique(entry.oauthIssuerKey ? issuerHosts(entry.oauthIssuerKey) : []),
    mcpHosts: [],
  };
}

export function deriveBundleHostManifest(bundle: SkillBundle): DerivedHostManifest {
  const apiHosts: string[] = [];
  const oauthHosts: string[] = [];
  for (const bundled of bundle.apiDefinitions) {
    apiHosts.push(...apiDraftHosts(bundled.definition));
  }
  for (const template of bundle.apiBindingTemplates) {
    apiHosts.push(...template.egressPolicy.allowedHosts);
    if (template.authShape.type === 'oauth2_client_credentials') {
      oauthHosts.push(urlHost(template.authShape.tokenEndpoint));
    }
  }
  const mcpHosts = bundle.mcpDefinitions.map((bundled) => urlHost(bundled.definition.serverUrl));
  for (const template of bundle.mcpBindingTemplates) {
    if (template.authShape.type === 'oauth2_client_credentials') {
      oauthHosts.push(urlHost(template.authShape.tokenEndpoint));
    }
  }
  return {
    apiHosts: sortedUnique(apiHosts),
    oauthHosts: sortedUnique(oauthHosts),
    mcpHosts: sortedUnique(mcpHosts),
  };
}
