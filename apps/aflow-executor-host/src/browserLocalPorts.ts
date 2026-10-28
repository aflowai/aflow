/**
 * The loopback ports an operator declares for a harness's ephemeral browser
 * (Plan 320 D12), and the refusal of one that is this stack's own (D19, F47).
 *
 * The local web application presents the instance secret to whoever loads
 * it, so a harness whose browser reaches it can approve its own requests, and
 * it serves this stack's code rather than the change the harness is making. A
 * run's preview reaches its browser on a port of the run's own, so no harness
 * has a reason to be given one of this stack's: it is refused here, as a
 * profile's is, and at the connection whatever the file says.
 */
import { describeStackPortOwner, stackOwnPorts } from '@aflow/lib';
import { browserStackPortReason } from '@aflow/schemas';

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

/** The refusal of declaring this stack's own ports for a harness's browser, or nothing. */
export function harnessStackPortRefusal(
  harnessId: string,
  ports: readonly number[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const known = stackOwnPorts(env);
  const reasons = [...new Set(ports)].flatMap((port) => {
    const owner = known.get(port);
    return owner === undefined ? [] : [browserStackPortReason(port, describeStackPortOwner(owner))];
  });
  if (reasons.length === 0) return undefined;
  const said = reasons.join('; ');
  return (
    `${said.charAt(0).toUpperCase()}${said.slice(1)}, so \`${harnessId}\`'s browser is not ` +
    'given it, and nothing was changed. A run that asks for `preview: true` has its own ' +
    "preview opened to its browser; no harness needs this stack's ports."
  );
}
