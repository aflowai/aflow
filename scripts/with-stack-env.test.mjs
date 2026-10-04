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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STACK_ENV_FILE,
  STACK_PASSWORD_KEY,
  generateRedisPassword,
  loadStackEnv,
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
  it('hands its child the shell’s values over .env, and REDIS_URL carrying the machine’s password', async () => {
    const { repo, hostDir } = checkout(
      'REDIS_URL=redis://localhost:6379\nFROM_DOTENV=dotenv\nSET_IN_BOTH=dotenv\n',
    );
    const env = await childEnv(repo, {
      PATH: process.env['PATH'],
      PHOENIX_HOST_DIR: hostDir,
      REDIS_URL: 'redis://localhost:6380',
      SET_IN_BOTH: 'shell',
    });
    expect(env['REDIS_URL']).toBe(`redis://:${MACHINE}@localhost:6380`);
    expect(env['SET_IN_BOTH']).toBe('shell');
    expect(env['FROM_DOTENV']).toBe('dotenv');
  });

  it('keeps a value the caller set empty, rather than refilling it from .env', async () => {
    const { repo, hostDir } = checkout('PHOENIX_EDITION=enterprise\nHOST=0.0.0.0\n');
    const env = await childEnv(repo, {
      PATH: process.env['PATH'],
      PHOENIX_HOST_DIR: hostDir,
      PHOENIX_EDITION: 'community-local',
      HOST: '',
    });
    expect(env['PHOENIX_EDITION']).toBe('community-local');
    expect(env['HOST']).toBe('');
  });

  it('hands a service the file the dev runner was given with --env, unchanged by the checkout’s .env', async () => {
    const { repo, hostDir } = checkout(
      'REDIS_URL=redis://localhost:6379\nDATABASE_URL=postgres://localhost:5433/checkout\n',
    );
    const runnerFile = join(scratch, 'runner.env');
    writeFileSync(
      runnerFile,
      'REDIS_URL=redis://127.0.0.1:6390/4\nDATABASE_URL=postgres://localhost:5433/runner\n',
    );
    const runner = { PATH: process.env['PATH'], PHOENIX_HOST_DIR: hostDir };
    const services = loadStackEnv(runnerFile, runner);
    const env = await childEnv(repo, services);
    expect(env['DATABASE_URL']).toBe('postgres://localhost:5433/runner');
    expect(env['REDIS_URL']).toBe(`redis://:${MACHINE}@127.0.0.1:6390/4`);
    expect(env['REDIS_URL']).toBe(services['REDIS_URL']);
  });
});

/** The command segments of a script, split where a shell runs one command after another. */
function segments(command) {
  return command.split(/&&|\|\||;|\|/).map((segment) =>
    segment
      .trim()
      .split(/\s+/)
      .map((token) => token.replace(/^(['"])(.*)\1$/, '$2')),
  );
}

/**
 * Each script that runs tsx on a file of this repository: the entry point,
 * repository-relative, and whether the loader runs it. The entry point is the
 * first argument after `tsx` naming a file that exists, so option values and
 * watch globs are passed over.
 */
function tsxEntryPoints(manifest) {
  const dir = dirname(join(REPO, manifest));
  const { scripts = {} } = JSON.parse(readFileSync(join(REPO, manifest), 'utf8'));
  return Object.entries(scripts).flatMap(([name, command]) =>
    segments(command).flatMap((tokens) => {
      const tsx = tokens.indexOf('tsx');
      if (tsx === -1) return [];
      const entry = tokens
        .slice(tsx + 1)
        .map((token) => resolve(dir, token))
        .find((path) => existsSync(path) && statSync(path).isFile());
      if (entry === undefined) return [];
      const loaded = tokens
        .slice(0, tsx)
        .some((token) => resolve(dir, token) === join(REPO, 'scripts', 'with-stack-env.mjs'));
      return [{ script: `${manifest}: ${name}`, entry: relative(REPO, entry), loaded }];
    }),
  );
}

/**
 * Why an entry point runs without the loader, or undefined when nothing does.
 * Each reason is a property of the entry point itself, never of a script name.
 */
function runsWithoutLoader(entry) {
  if (entry.startsWith(`apps${sep}aflow-executor-host${sep}`)) {
    return 'the host executor reads its Redis from the paired host.env, which a REDIS_URL in its environment shadows';
  }
  if (entry.startsWith(`packages${sep}`)) {
    return 'a package’s build step runs in the image builder, which carries no loader';
  }
  if (readFileSync(join(REPO, entry), 'utf8').includes('scripts/dev.mjs')) {
    return 'the dev runner composes its services’ environment itself, and hands the host executor the one it was given';
  }
  return undefined;
}

describe('every entry point', () => {
  const manifests = [
    'package.json',
    ...['apps', 'packages'].flatMap((root) =>
      readdirSync(join(REPO, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, 'package.json')),
    ),
  ].filter((manifest) => existsSync(join(REPO, manifest)));
  const entryPoints = manifests.flatMap(tsxEntryPoints);

  it('runs tsx on a file of this repository through the loader', () => {
    expect(entryPoints.length).toBeGreaterThan(0);
    const bypassing = entryPoints
      .filter(({ entry, loaded }) => !loaded && runsWithoutLoader(entry) === undefined)
      .map(({ script, entry }) => `${script} (${entry})`);
    expect(bypassing).toEqual([]);
  });

  it('reads an entry point by what the script runs, across workspaces, watch globs and option values', () => {
    const server = entryPoints.find(
      ({ entry }) => entry === join('apps', 'server', 'src', 'bootstrapLocal.ts'),
    );
    expect(server?.loaded).toBe(true);
    expect(
      segments(
        `NODE_OPTIONS='--conditions=ts-source' node scripts/with-stack-env.mjs tsx watch --include 'packages/*/src/**/*.ts' a.ts && npx tsx b.ts`,
      ).map((tokens) => tokens.at(-1)),
    ).toEqual(['a.ts', 'b.ts']);
  });
});
