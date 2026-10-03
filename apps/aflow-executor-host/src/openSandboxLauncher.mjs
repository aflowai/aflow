/**
 * The launcher an `open` folder's coding agent and checks run under (Plan 315
 * D19): the sandbox adapter's own library, as its command line drives it, with
 * one answer changed — a host the policy's list does not name is admitted
 * rather than refused, unless it is one of the stack's own services on this
 * machine.
 *
 * The adapter's command line refuses every host off the list, and its schema
 * admits no entry meaning "every host", so the network an `open` posture opens
 * cannot be written into the policy file. Its library takes the answer as a
 * callback, and this is the one place that gives it. Everything else is the
 * adapter's: the filesystem policy, the proxies and their checks, and on macOS
 * the loopback the policy's `allowLocalBinding` opens, less the stack's ports.
 *
 * Plain JavaScript and the adapter alone, because the executor runs it with
 * `node` whether the executor itself runs compiled or from source.
 *
 * argv: -s <policy.json> -- <program> [args...]
 */
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';

const USAGE = 'usage: openSandboxLauncher.mjs -s <policy.json> -- <program> [args...]\n';

/** One word for the shell the adapter hands the command to, quoted so it stays one. */
function shellWord(word) {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The stack's own services, as the policy denies them on loopback
 * (`stackServices.ts`): every `localhost:<port>` entry in `deniedDomains`.
 */
export function stackServicePorts(deniedDomains) {
  return new Set(
    deniedDomains.flatMap((entry) => {
      const match = /^localhost:(\d+)$/.exec(entry);
      return match ? [Number(match[1])] : [];
    }),
  );
}

/** Loopback, the unspecified address, and every address this machine's interfaces hold. */
function addressesOfThisMachine(interfaceAddresses) {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addAddress('::', 'ipv6');
  for (const address of interfaceAddresses) {
    list.addAddress(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
  }
  return (address) => {
    const mapped = address.toLowerCase().startsWith('::ffff:')
      ? address.slice('::ffff:'.length)
      : address;
    const bare = isIP(mapped) === 4 ? mapped : address;
    return list.check(bare, isIP(bare) === 6 ? 'ipv6' : 'ipv4');
  };
}

function interfaceAddresses() {
  return Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address.split('%')[0]),
  );
}

/**
 * The answer for a host the policy does not name: admitted, unless it is a
 * stack service's port on this machine.
 *
 * The policy's entries name the loopback spellings, and the adapter
 * canonicalises a host before it compares them, but a stack service bound to
 * every address also answers on `127.0.0.2`, on the machine's own LAN address
 * and on any name that resolves to them. So the host is resolved as the dial
 * would resolve it, and refused if any answer is this machine; one that does
 * not resolve is refused too, since nothing then says where it goes.
 */
export function admitUnlessStackService(ports, { resolve, localAddresses }) {
  const onThisMachine = addressesOfThisMachine(localAddresses);
  return async ({ host, port }) => {
    if (!ports.has(port)) return true;
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    try {
      const answers = await resolve(bare);
      return !answers.some((answer) => onThisMachine(answer.address));
    } catch {
      return false;
    }
  };
}

/** The grant the adapter's macOS profile opens loopback with under `allowLocalBinding`. */
export const LOOPBACK_OUTBOUND_GRANT = '(allow network-outbound (remote ip "localhost:*"))';

/**
 * The adapter's wrapped command with the stack's ports refused in its macOS
 * profile.
 *
 * On macOS a connection to loopback never reaches the proxy: the profile admits
 * every localhost port, and no adapter option narrows it. The adapter's profile
 * is a single-quoted argument ahead of the command, so the refusals go straight
 * after that grant — Seatbelt takes the last rule that matches. The command is
 * the wrapped string's last argument and could hold the grant's text itself,
 * so the grant is looked for only ahead of it, and must be there exactly once:
 * anything else means the adapter's output changed shape, and the command does
 * not start.
 */
export function refuseStackServicesInProfile(wrapped, command, ports) {
  if (ports.size === 0) return wrapped;
  const quotedCommand = `'${command.replaceAll("'", `'"'"'`)}'`;
  const head = wrapped.endsWith(quotedCommand) ? wrapped.slice(0, -quotedCommand.length) : '';
  const at = head.indexOf(LOOPBACK_OUTBOUND_GRANT);
  if (at === -1 || head.indexOf(LOOPBACK_OUTBOUND_GRANT, at + 1) !== -1) {
    throw new Error(
      "the sandbox profile does not open loopback the way this launcher narrows it, so the stack's " +
        'own services could not be kept out of reach',
    );
  }
  const end = at + LOOPBACK_OUTBOUND_GRANT.length;
  const refusals = [...ports]
    .map((port) => `\n(deny network-outbound (remote ip "localhost:${String(port)}"))`)
    .join('');
  return `${head.slice(0, end)}${refusals}${head.slice(end)}${quotedCommand}`;
}

async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  if (args[0] !== '-s' || args[1] === undefined || separator !== 2 || args.length <= 3) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const policyPath = args[1];
  const argv = args.slice(3);

  let child;
  try {
    const config = SandboxRuntimeConfigSchema.parse(JSON.parse(readFileSync(policyPath, 'utf8')));
    const ports = stackServicePorts(config.network.deniedDomains);
    await SandboxManager.initialize(
      config,
      admitUnlessStackService(ports, {
        resolve: (host) => lookup(host, { all: true, verbatim: true }),
        localAddresses: interfaceAddresses(),
      }),
    );
    const command = argv.map(shellWord).join(' ');
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const guarded =
      process.platform === 'darwin'
        ? refuseStackServicesInProfile(wrapped, command, ports)
        : wrapped;
    child = spawn(guarded, { shell: true, stdio: 'inherit' });
  } catch (error) {
    process.stderr.write(
      `The open sandbox could not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  // The workload's own status reaches the executor through the file its wrapper
  // writes, so this exit only has to say whether the launcher got that far.
  child.on('exit', (code) => {
    SandboxManager.cleanupAfterCommand();
    process.exit(code ?? 1);
  });
  child.on('error', (error) => {
    process.stderr.write(`The open sandbox could not run the command: ${error.message}\n`);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}

// Imported by its tests for the answers above; run by the executor as a program.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
