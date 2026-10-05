/**
 * The loopback ports an operator declares for a harness's ephemeral browser
 * (Plan 320 D12), and the warning when one of them is this stack's own.
 *
 * The local web application presents the instance secret to whoever loads
 * it, so a harness whose browser reaches it can approve its own requests.
 * Declaring that port for a harness is allowed — it is the operator's machine,
 * and the harness's browser holds no sign-ins — but never without being told.
 */
import { describeStackPortOwner, stackOwnPorts } from '@aflow/lib';

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

/** One line when a declared port may be this stack's own, or nothing. */
export function stackPortWarning(
  harnessId: string,
  ports: readonly number[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const known = stackOwnPorts(env);
  const hits = [...new Set(ports)].flatMap((port) => {
    const owner = known.get(port);
    return owner === undefined ? [] : [`${String(port)} (${describeStackPortOwner(owner)})`];
  });
  if (hits.length === 0) return undefined;
  return (
    `Warning: ${hits.join(', ')} may be this stack itself — its web app presents the ` +
    `instance secret to whoever loads it, so \`${harnessId}\`'s browser could approve its own requests.`
  );
}
