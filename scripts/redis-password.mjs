#!/usr/bin/env node
/**
 * Gives the development stack's Redis a password, for a `.env` written before
 * it had one: a generated password into `REDIS_URL`, then Redis restarted with
 * it. The data is in a volume and stays. Idempotent — a URL that already
 * carries a password keeps it, and Redis is restarted with that one.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { compose, readDotenv } from './infra.mjs';
import { REDIS_URL_KEY, envWithRedisPassword, generateRedisPassword } from './stackCredentials.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(REPO, '.env');
const say = (message) => {
  console.log(`\x1b[36m[redis:password]\x1b[0m ${message}`);
};

if (!existsSync(envPath)) {
  say('no .env here; `yarn start` creates one with a generated password.');
  process.exit(1);
}

const updated = envWithRedisPassword(readFileSync(envPath, 'utf8'), generateRedisPassword());
if (updated === undefined) {
  say(`${REDIS_URL_KEY} in .env already carries a password; restarting Redis with it.`);
} else {
  writeFileSync(envPath, updated);
  say(`wrote a generated password into ${REDIS_URL_KEY} in .env.`);
}

// `up` recreates the container when its environment changed, and leaves one
// already started with this password alone.
if (compose(['up', '-d', 'redis'], readDotenv(REPO)) !== 0) process.exit(1);
say(
  'Redis now requires it. Restart the stack (`yarn start`) so every service reads the new ' +
    `${REDIS_URL_KEY}; a paired machine keeps its own credential in ~/.aflow/host.env.`,
);
