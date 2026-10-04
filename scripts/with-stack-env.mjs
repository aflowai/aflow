#!/usr/bin/env node
/**
 * Runs a command in the stack's environment: the checkout's `.env` under what
 * the caller set, and `REDIS_URL` carrying this machine's Redis password
 * (`scripts/stackEnv.mjs`, Plan 315 D20).
 *
 * Every script that runs tsx on an entry point of this repository runs it
 * under this, so a service started on its own authenticates as one the dev
 * runner starts; `with-stack-env.test.mjs` names the entry points that do not,
 * and why.
 *
 *   node scripts/with-stack-env.mjs <command> [args…]
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadStackEnv } from './stackEnv.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: node scripts/with-stack-env.mjs <command> [args…]';

/** What a supervisor or terminal may send this process, passed on to the command it runs. */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH'];

/** Starts `command` in checkout `options.repo`'s stack environment, by default this one. */
export function spawnWithStackEnv(command, args, options = {}) {
  return spawn(command, args, {
    stdio: options.stdio ?? 'inherit',
    env: loadStackEnv(join(options.repo ?? REPO, '.env'), options.processEnv ?? process.env),
  });
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  const child = spawnWithStackEnv(command, args);
  const forward = (/** @type {NodeJS.Signals} */ signal) => {
    child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  child.on('error', (error) => {
    console.error(`[with-stack-env] ${command}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal === null) process.exit(code ?? 1);
    // Ended by a signal, this process ends by the same one, so whoever started
    // it reads the command's own ending rather than an exit code standing in.
    for (const forwarded of FORWARDED_SIGNALS) process.off(forwarded, forward);
    process.kill(process.pid, signal);
  });
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) main();
