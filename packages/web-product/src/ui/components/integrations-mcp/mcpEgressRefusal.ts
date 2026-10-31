/**
 * A refused MCP connect as the integration card and form say it (Plan 336 D6).
 *
 * The step error's `details` carry the refusal the MCP executor built from
 * `@aflow/network-safety`: its kind, the refused host, the range in words and
 * the remedy. The words come from `describeMcpEgressRefusal` in
 * `@aflow/schemas`, which the executor's message uses too.
 */
import {
  McpEgressRefusalDetailsSchema,
  describeMcpEgressRefusal,
  normalizePrivateNetworkHost,
  type McpEgressRefusalContext,
  type McpEgressRefusalDetails,
} from '@aflow/schemas';

export type { McpEgressRefusalDetails };

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

/**
 * The refusal in the words the MCP executor's step message uses, or `null` for
 * a refusal those words do not describe.
 */
export function describeMcpRefusal(
  refusal: McpEgressRefusalDetails,
  context: McpEgressRefusalContext,
): McpRefusalView | null {
  const text = describeMcpEgressRefusal(refusal, context);
  if (text === null) return null;
  const answersIt =
    refusal.kind === 'private-ip' && refusal.remedy === 'acknowledge_private_network';
  return { text, action: answersIt ? 'set_private_network' : null };
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
