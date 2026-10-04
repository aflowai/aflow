/**
 * The launcher an `open` folder's coding agent and checks run under (Plan 315
 * D19): the sandbox adapter's own library, as its command line drives it, with
 * one answer changed — a host the policy's list does not name is admitted
 * rather than refused, unless it is this machine.
 *
 * That is Claude Code's own sandbox with every domain allowed: the network
 * open, and the machine's loopback closed. The adapter's command line refuses
 * every host off the list, and its schema admits no entry meaning "every host",
 * so the network an `open` posture opens cannot be written into the policy
 * file. Its library takes the answer as a callback, and this is the one place
 * that gives it. Everything else is the adapter's: the filesystem policy, the
 * proxies and their checks, and the loopback the job has — the namespace's own
 * on Linux, none on macOS.
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
 * The answer for a host the policy does not name: admitted, unless it is this
 * machine, on any port.
 *
 * The proxy dials from outside the sandbox, so a host it admits on this
 * machine is the machine's loopback whatever the job's own is. A listener bound
 * to every address answers on `127.0.0.2`, on the machine's own LAN address and
 * on any name that resolves to them, so the host is resolved as the dial would
 * resolve it and refused if any answer is this machine; one that does not
 * resolve is refused too, since nothing then says where it goes.
 */
export function admitUnlessThisMachine({ resolve, localAddresses }) {
  const onThisMachine = addressesOfThisMachine(localAddresses);
  return async ({ host }) => {
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    try {
      const answers = await resolve(bare);
      return !answers.some((answer) => onThisMachine(answer.address));
    } catch {
      return false;
    }
  };
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
    await SandboxManager.initialize(
      config,
      admitUnlessThisMachine({
        resolve: (host) => lookup(host, { all: true, verbatim: true }),
        localAddresses: interfaceAddresses(),
      }),
    );
    const wrapped = await SandboxManager.wrapWithSandbox(argv.map(shellWord).join(' '));
    child = spawn(wrapped, { shell: true, stdio: 'inherit' });
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
