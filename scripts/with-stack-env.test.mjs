/**
 * The one loader every root entry point reads the stack's environment through
 * (Plan 315 D20), and the guard that keeps every entry point on it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEV_ENV_OVERRIDES_KEY,
  STACK_ENV_FILE,
  STACK_PASSWORD_KEY,
  generateRedisPassword,
} from './stackEnv.mjs';
import { spawnWithStackEnv } from './with-stack-env.mjs';

const REPO = join(import.meta.dirname, '..');
const MACHINE = generateRedisPassword();
const PRINT_ENV = 'process.stdout.write(JSON.stringify(process.env))';

let scratch;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A checkout whose `.env` is `dotenv`, and a host directory holding the machine's password. */
function checkout(dotenv) {
  scratch = mkdtempSync(join(tmpdir(), 'with-stack-env-'));
  const repo = join(scratch, 'repo');
  const hostDir = join(scratch, 'host');
  mkdirSync(repo);
  mkdirSync(hostDir);
  writeFileSync(join(repo, '.env'), dotenv);
  writeFileSync(join(hostDir, STACK_ENV_FILE), `${STACK_PASSWORD_KEY}=${MACHINE}\n`);
  return { repo, hostDir };
}

/** The environment a child of the loader starts with. */
function childEnv(repo, processEnv) {
  const child = spawnWithStackEnv(process.execPath, ['-e', PRINT_ENV], {
    repo,
    processEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    out += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(JSON.parse(out));
      else reject(new Error(`the child exited with ${String(code)}`));
    });
  });
}

describe('the stack loader', () => {
  it('hands its child REDIS_URL carrying the machine’s password, .env over the shell', async () => {
    const { repo, hostDir } = checkout('REDIS_URL=redis://localhost:6379\nFROM_DOTENV=dotenv\n');
    const env = await childEnv(repo, {
      PATH: process.env['PATH'],
      PHOENIX_HOST_DIR: hostDir,
      REDIS_URL: 'redis://localhost:6380',
      FROM_SHELL: 'shell',
    });
    expect(env['REDIS_URL']).toBe(`redis://:${MACHINE}@localhost:6379`);
    expect(env['FROM_DOTENV']).toBe('dotenv');
    expect(env['FROM_SHELL']).toBe('shell');
  });

  it('keeps the values the dev runner’s caller must win with over .env', async () => {
    const { repo, hostDir } = checkout('PHOENIX_EDITION=enterprise\nHOST=0.0.0.0\n');
    const env = await childEnv(repo, {
      PATH: process.env['PATH'],
      PHOENIX_HOST_DIR: hostDir,
      [DEV_ENV_OVERRIDES_KEY]: JSON.stringify({ PHOENIX_EDITION: 'community-local', HOST: '' }),
    });
    expect(env['PHOENIX_EDITION']).toBe('community-local');
    expect(env['HOST']).toBe('');
    expect(env['REDIS_URL']).toBe(`redis://:${MACHINE}@localhost:6379`);
  });
});

describe('every entry point', () => {
  const manifests = [
    'package.json',
    ...['apps', 'packages'].flatMap((root) =>
      readdirSync(join(REPO, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, 'package.json')),
    ),
  ].filter((manifest) => existsSync(join(REPO, manifest)));

  it('reads the stack’s environment through the loader, never `dotenv -e .env`', () => {
    const bypassing = manifests.flatMap((manifest) => {
      const { scripts = {} } = JSON.parse(readFileSync(join(REPO, manifest), 'utf8'));
      return Object.entries(scripts)
        .filter(([, command]) => /\bdotenv\s+-e\s+\.env\b/.test(command))
        .map(([name]) => `${manifest}: ${name}`);
    });
    expect(bypassing).toEqual([]);
  });
});
