#!/usr/bin/env node
/**
 * `docker compose`, given the stack's Redis password from this machine's
 * `stack.env` — the one place it lives (`scripts/stackEnv.mjs`), because every
 * checkout's compose drives the same Redis container, and one handing it
 * another password would recreate it under every other checkout.
 *
 * Refuses before compose runs when the machine has none yet, because compose
 * would start nothing useful: the Redis service refuses to start without one.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { composeEnv } from './stackCredentials.mjs';
import { readMachinePassword, stackEnvPath } from './stackEnv.mjs';
import { ADOPT_PASSWORD_COMMAND } from './stackRedis.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs `docker compose <args>` from the checkout; its exit status. */
export function compose(args) {
  const machineFile = stackEnvPath(process.env);
  const machinePassword = readMachinePassword(machineFile);
  if (machinePassword === undefined) {
    console.error(
      `\x1b[31m[infra]\x1b[0m this machine has no stack Redis password yet (${machineFile}), ` +
        `and the stack's Redis requires one. Run \`yarn start\` or \`${ADOPT_PASSWORD_COMMAND}\` ` +
        'once to write it.',
    );
    return 1;
  }
  const env = composeEnv(process.env, machinePassword);
  return (
    spawnSync('docker', ['compose', ...args], { cwd: REPO, env, stdio: 'inherit' }).status ?? 1
  );
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) process.exit(compose(process.argv.slice(2)));
