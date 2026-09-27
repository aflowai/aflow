/**
 * Declared-host collection per integration artifact — the full outbound
 * surface the tenant allowlist judges: base/template hosts, egress additions,
 * OAuth token + authorization endpoints, MCP server URLs, and repo git hosts.
 */
import { issuerHosts, templateHostPattern } from '@aflow/platform-artifacts';

function urlHost(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

function pushUnique(target: string[], hosts: ReadonlyArray<string | null>): void {
  for (const host of hosts) {
    if (host !== null && host.length > 0 && !target.includes(host)) target.push(host);
  }
}

export interface ApiDefinitionHostSource {
  baseUrl?: string | undefined;
  baseUrlTemplate?: string | undefined;
  suggestedEgressPolicy?: { additionalHosts?: readonly string[] | undefined } | undefined;
}

export function collectApiDefinitionHosts(def: ApiDefinitionHostSource): string[] {
  const hosts: string[] = [];
  pushUnique(hosts, [urlHost(def.baseUrl)]);
  if (def.baseUrlTemplate !== undefined && def.baseUrlTemplate.length > 0) {
    pushUnique(hosts, [templateHostPattern(def.baseUrlTemplate)]);
  }
  pushUnique(hosts, def.suggestedEgressPolicy?.additionalHosts ?? []);
  return hosts;
}

/**
 * Hosts an auth profile causes the platform to contact — client-credentials
 * token endpoints, explicit authorization-code endpoints, and (for a curated
 * `issuerKey`) the issuer registry's authorization/token/discovery hosts.
 * Structural over the raw auth JSON so API and MCP profiles share it.
 */
export function collectAuthHosts(auth: Record<string, unknown> | null | undefined): string[] {
  if (!auth) return [];
  const hosts: string[] = [];
  pushUnique(hosts, [urlHost(auth['tokenEndpoint']), urlHost(auth['authorizationServer'])]);
  if (typeof auth['issuerKey'] === 'string') {
    pushUnique(hosts, issuerHosts(auth['issuerKey']));
  }
  return hosts;
}

export interface ApiBindingHostSource {
  auth?: Record<string, unknown> | null | undefined;
  egressPolicy?: { allowedHosts?: readonly string[] | undefined } | null | undefined;
}

export function collectApiBindingHosts(binding: ApiBindingHostSource): string[] {
  const hosts: string[] = [];
  pushUnique(hosts, binding.egressPolicy?.allowedHosts ?? []);
  pushUnique(hosts, collectAuthHosts(binding.auth));
  return hosts;
}

export function collectMcpServerHosts(def: { serverUrl: string }): string[] {
  const hosts: string[] = [];
  pushUnique(hosts, [urlHost(def.serverUrl)]);
  return hosts;
}

export function collectMcpBindingHosts(auth: Record<string, unknown> | null | undefined): string[] {
  return collectAuthHosts(auth);
}

/**
 * A repo designation declares exactly one outbound host: its git host. The lane's
 * other egress is fixed for the deployment rather than declared per designation,
 * so there is nothing else here for the tenant allowlist to judge.
 */
export function collectRepoDesignationHosts(designation: { gitHost: string }): string[] {
  const hosts: string[] = [];
  pushUnique(hosts, [designation.gitHost]);
  return hosts;
}
