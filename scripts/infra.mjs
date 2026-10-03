#!/usr/bin/env node
/**
 * `docker compose`, given the stack's Redis password from the `REDIS_URL` in
 * `.env` — the one place it lives (`scripts/stackCredentials.mjs`).
 *
 * Refuses before compose runs when the URL carries none, because compose
 * would start nothing useful: the Redis service refuses to start without one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { parseEnvFile } from './mcp-local-setup.mjs';
import {
  ADD_PASSWORD_COMMAND,
  COMPOSE_PASSWORD_KEY,
  REDIS_URL_KEY,
  composeEnv,
} from './stackCredentials.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readDotenv(repo = REPO) {
  const envPath = join(repo, '.env');
  return existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
}

/** Runs `docker compose <args>` from the checkout; its exit status. */
export function compose(args, dotenv = readDotenv()) {
  const env = composeEnv(process.env, dotenv);
  if (env[COMPOSE_PASSWORD_KEY] === '') {
    console.error(
      `\x1b[31m[infra]\x1b[0m ${REDIS_URL_KEY} in .env carries no password, and the stack's ` +
        `Redis requires one. Run \`${ADD_PASSWORD_COMMAND}\` once to add it.`,
    );
    return 1;
  }
  return (
    spawnSync('docker', ['compose', ...args], { cwd: REPO, env, stdio: 'inherit' }).status ?? 1
  );
}

const invoked =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) process.exit(compose(process.argv.slice(2)));
