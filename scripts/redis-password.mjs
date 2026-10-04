#!/usr/bin/env node
/**
 * Puts this checkout and the machine's Redis on the machine's password: writes
 * `stack.env` if this is the first command on the machine to need it, takes a
 * password of the checkout's own out of `REDIS_URL` in `.env` so the loader
 * lays the machine's in, and starts Redis with that password. The data is in a
 * volume and stays. Idempotent — run again, it changes nothing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { compose } from './infra.mjs';
import { envAdoptingMachinePassword } from './stackCredentials.mjs';
import { REDIS_URL_KEY, ensureMachinePassword, stackEnvPath } from './stackEnv.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(REPO, '.env');
const say = (message) => {
  console.log(`\x1b[36m[redis:password]\x1b[0m ${message}`);
};

const machineFile = stackEnvPath(process.env);
say(
  ensureMachinePassword(machineFile).created
    ? `wrote this machine's Redis password to ${machineFile}; every checkout reads it there.`
    : `this machine's Redis password is in ${machineFile}.`,
);

const adopted = existsSync(envPath)
  ? envAdoptingMachinePassword(readFileSync(envPath, 'utf8'))
  : undefined;
if (adopted !== undefined) {
  writeFileSync(envPath, adopted);
  say(`took this checkout's own password out of ${REDIS_URL_KEY} in .env; it uses the machine's.`);
}

// `up` recreates the container when its environment changed, and leaves one
// already started with this password alone — so it disturbs no other checkout.
if (compose(['up', '-d', 'redis']) !== 0) process.exit(1);
say(
  "Redis requires the machine's password. Restart the stack (`yarn start`) so every service " +
    `connects with it; a paired machine keeps its own credential in ~/.aflow/host.env.`,
);
