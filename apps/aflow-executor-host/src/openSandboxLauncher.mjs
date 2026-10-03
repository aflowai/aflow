/**
 * The launcher an `open` folder's coding agent and checks run under (Plan 315
 * D19): the sandbox adapter's own library, as its command line drives it, with
 * one answer changed — a host the policy's list does not name is admitted
 * rather than refused.
 *
 * The adapter's command line refuses every host off the list, and its schema
 * admits no entry meaning "every host", so the network an `open` posture opens
 * cannot be written into the policy file. Its library takes the answer as a
 * callback, and this is the one place that gives it. Everything else is the
 * adapter's: the filesystem policy, the proxies and their checks, and on macOS
 * the loopback the policy's `allowLocalBinding` opens.
 *
 * Plain JavaScript and the adapter alone, because the executor runs it with
 * `node` whether the executor itself runs compiled or from source.
 *
 * argv: -s <policy.json> -- <program> [args...]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';

const USAGE = 'usage: openSandboxLauncher.mjs -s <policy.json> -- <program> [args...]\n';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (args[0] !== '-s' || args[1] === undefined || separator !== 2 || args.length <= 3) {
  process.stderr.write(USAGE);
  process.exit(2);
}
const policyPath = args[1];
const argv = args.slice(3);

/** One word for the shell the adapter hands the command to, quoted so it stays one. */
function shellWord(word) {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Every host the policy does not name is admitted; the policy's own denials still stand. */
const admitEveryHost = () => Promise.resolve(true);

let child;
try {
  const config = SandboxRuntimeConfigSchema.parse(JSON.parse(readFileSync(policyPath, 'utf8')));
  await SandboxManager.initialize(config, admitEveryHost);
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
