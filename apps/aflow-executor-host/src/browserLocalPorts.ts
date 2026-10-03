/**
 * The loopback ports an operator declares for a harness's ephemeral browser
 * (Plan 320 D12), and the warning when one of them is the appliance's own.
 *
 * The appliance's web application presents the instance secret to whoever
 * loads it, so a harness whose browser reaches it can approve its own
 * requests. Declaring that port is allowed — it is the operator's machine —
 * but never without being told.
 */
import { STACK_API_PORT_DEFAULT, STACK_WEB_PORT_DEFAULT } from './stackServices.js';

/**
 * Where the appliance answers, as far as this machine can tell. The host
 * keeps no record of it, so this is the stack's defaults and the API address
 * `aflow connect` reads from the environment when one is set.
 */
export function appliancePorts(env: NodeJS.ProcessEnv): Map<number, string> {
  const ports = new Map<number, string>([
    [STACK_API_PORT_DEFAULT, "the appliance's API port by default"],
    [STACK_WEB_PORT_DEFAULT, "the appliance's web port by default"],
  ]);
  const api = env['AFLOW_API_URL']?.trim();
  if (api !== undefined && api !== '' && URL.canParse(api)) {
    const url = new URL(api);
    const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    ports.set(port, "the appliance's API port, as AFLOW_API_URL names it");
  }
  return ports;
}

/** The ports given, or the first word that is not one. */
export function parseLocalPorts(
  words: readonly string[],
): { ok: true; ports: number[] } | { ok: false; word: string } {
  const ports: number[] = [];
  for (const word of words) {
    const port = /^\d{1,5}$/.test(word) ? Number(word) : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { ok: false, word };
    ports.push(port);
  }
  return { ok: true, ports };
}

/** One line when a declared port may be the appliance's, or nothing. */
export function appliancePortWarning(
  harnessId: string,
  ports: readonly number[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  const known = appliancePorts(env);
  const hits = [...new Set(ports)]
    .filter((port) => known.has(port))
    .map((port) => `${String(port)} (${known.get(port) ?? ''})`);
  if (hits.length === 0) return undefined;
  return (
    `Warning: ${hits.join(', ')} may be the appliance itself — its web app presents the ` +
    `instance secret to whoever loads it, so \`${harnessId}\`'s browser could approve its own requests.`
  );
}
