/**
 * `yarn channel:slack <setup | start>`.
 *
 * `start` runs the app from its source under the `ts-source` condition, as the
 * host executor's own commands run, and without the stack's environment: the
 * app reads its Redis credential from its own file.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Stop, main as setup } from './setup.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command] = process.argv.slice(2);

if (command === 'setup') {
  setup().catch((/** @type {unknown} */ error) => {
    const message =
      error instanceof Stop
        ? error.message
        : `failed: ${error instanceof Error ? error.message : 'an unexpected error'}`;
    console.error(`\x1b[31m[channel:slack setup]\x1b[0m ${message}`);
    process.exit(1);
  });
} else if (command === 'start') {
  const child = spawn(
    process.execPath,
    ['--conditions=ts-source', '--import', 'tsx', join(APP_DIR, 'src', 'index.ts')],
    { stdio: 'inherit', cwd: APP_DIR },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 0));
  });
} else {
  console.error('Usage: yarn channel:slack setup | start');
  process.exit(1);
}
