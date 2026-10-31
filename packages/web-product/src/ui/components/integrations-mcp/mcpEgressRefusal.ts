/**
 * A refused MCP connect as the integration card and form say it (Plan 336 D6).
 *
 * The step error's `details` carry the refusal the MCP executor built from
 * `@aflow/network-safety`: its kind, the refused host, the range in words and
 * the remedy. This reads the kind and the remedy, never the range label, so
 * whether an address is reachable stays that package's decision.
 */
import {
  McpEgressRefusalDetailsSchema,
  normalizePrivateNetworkHost,
  type McpEgressRefusalDetails,
} from '@aflow/schemas';

export type { McpEgressRefusalDetails };

/** The action that answers `acknowledge_private_network`. */
export const SET_PRIVATE_NETWORK_LABEL = 'Set as private network';

export interface McpBindingTestResult {
  ok: boolean;
  message?: string;
  errorCode?: string;
  /** Set when the connect was refused on its address, protocol or name. */
  refusal?: McpEgressRefusalDetails;
}

/** What a `?wait` start of `mcp.binding.test` returned. */
export interface McpBindingTestWaitBody {
  status: string;
  error?: { code?: string; message?: string; details?: unknown };
}

export function testResultFromWaitBody(body: McpBindingTestWaitBody): McpBindingTestResult {
  if (body.status === 'SUCCEEDED') return { ok: true };
  const refusal = McpEgressRefusalDetailsSchema.safeParse(body.error?.details);
  return {
    ok: false,
    ...(body.error?.message ? { message: body.error.message } : {}),
    ...(body.error?.code ? { errorCode: body.error.code } : {}),
    ...(refusal.success ? { refusal: refusal.data } : {}),
  };
}

export interface McpRefusalView {
  /** The refusal in words: the range, and what the operator can do. */
  text: string;
  /** Offered only where setting the host as a private network host answers it. */
  action: 'set_private_network' | null;
}

function withArticle(words: string): string {
  return `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`;
}

/**
 * The refusal in words, or `null` for a refusal this does not describe — the
 * tenant allowlist says its own reason in the message.
 */
export function describeMcpRefusal(refusal: McpEgressRefusalDetails): McpRefusalView | null {
  const host = refusal.target ?? 'The server';
  const range = refusal.range ?? refusal.rangeLabel;
  const onRange = range !== undefined ? ` is on ${withArticle(range)}` : ' is on a refused address';
  switch (refusal.kind) {
    case 'unresolvable':
      return {
        text: `This machine cannot resolve ${host}. The VPN or its DNS may not reach the service from here.`,
        action: null,
      };
    case 'invalid-protocol':
      return {
        text: `${host} is reached over https only. Change the server URL to https. No setting lifts the https rule.`,
        action: null,
      };
    case 'private-ip':
      if (refusal.remedy === 'acknowledge_private_network') {
        return {
          text: `${host}${onRange}. Set it as a private network host to let this server reach it over https.`,
          action: 'set_private_network',
        };
      }
      if (refusal.remedy === 'deployment_must_list_host') {
        return {
          text: `${host}${onRange}. It is set as a private network host, but this deployment does not list it. Whoever runs the deployment adds it to MCP_PRIVATE_NETWORK_HOSTS.`,
          action: null,
        };
      }
      return { text: `${host}${onRange}. No setting reaches it.`, action: null };
    case 'allowlist-host':
    case 'invalid-url':
      return null;
  }
}

/** The host of a server URL, normalized as the acknowledgment stores it, or `null`. */
export function serverUrlHost(serverUrl: string): string | null {
  try {
    const host = normalizePrivateNetworkHost(new URL(serverUrl).hostname);
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * The hosts the form starts from: those already set, then the refused host,
 * each once. With nothing set yet, the server URL host is added too.
 */
export function proposedPrivateNetworkHosts(
  current: readonly string[],
  refusedHost: string | undefined,
  serverUrl: string,
): string[] {
  const candidates = [
    ...current,
    refusedHost,
    current.length === 0 ? (serverUrlHost(serverUrl) ?? undefined) : undefined,
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const host = normalizePrivateNetworkHost(candidate);
    if (host !== '') seen.add(host);
  }
  return [...seen];
}

/** One host per line or comma, trimmed, empty entries dropped. */
export function parseHostList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
