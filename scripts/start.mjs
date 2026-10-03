#!/usr/bin/env node
/**
 * One command from a fresh clone to a running development stack.
 *
 * `scripts/dev-local.ts` already brings up the datastores, applies migrations,
 * provisions the instance and starts the edition's services — this adds only the
 * preconditions it assumes and cannot recover from, each of which otherwise
 * surfaces minutes later as an error naming something other than the cause —
 * and, once the stack is healthy, the MCP server's key when it has none.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { apiUrlOf, authFileOf, envNamingAuthFile, parseEnvFile } from './mcp-local-setup.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const say = (message) => {
  console.log(`\x1b[36m[start]\x1b[0m ${message}`);
};
const fail = (message, remedy) => {
  console.error(`\x1b[31m[start]\x1b[0m ${message}`);
  if (remedy !== undefined) console.error(`        ${remedy}`);
  process.exit(1);
};

// ── Node ─────────────────────────────────────────────────────────────────────
const wanted = readFileSync(join(REPO, '.nvmrc'), 'utf-8').trim().replace(/^v/, '');
if (process.versions.node.split('.')[0] !== wanted.split('.')[0]) {
  fail(
    `Node ${wanted} is required; this is ${process.versions.node}.`,
    `With nvm: nvm use ${wanted}`,
  );
}

// ── Docker, which the datastores and the code sandbox run in ──────────────────
if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  fail('Docker is not running.', 'Start Docker Desktop, then run this again.');
}

// ── The environment file ──────────────────────────────────────────────────────
if (!existsSync(join(REPO, '.env'))) {
  copyFileSync(join(REPO, '.env.example'), join(REPO, '.env'));
  say('created .env from .env.example');
  say('  nothing to edit — a model provider key is entered in the app');
}

// ── The MCP server's credential ───────────────────────────────────────────────
// Minted by `yarn mcp:setup` once the API is healthy (below). The line naming
// the file goes into `.env` now: the MCP server reads it once, at its start, and
// reads the file itself per session — so the key reaches the next session
// without a restart.
const envFile = join(REPO, '.env');
const envValues = { ...process.env, ...parseEnvFile(readFileSync(envFile, 'utf-8')) };
const mcpCredentialMissing = !existsSync(authFileOf(envValues, REPO));
if (mcpCredentialMissing) {
  const named = envNamingAuthFile(readFileSync(envFile, 'utf-8'));
  if (named !== undefined) writeFileSync(envFile, named);
}

// ── Build output the web application reads ────────────────────────────────────
// Its bundler resolves the `import` condition, so it reads compiled packages even
// in development. Absent, it fails as a module that cannot be found rather than a
// build that has not run, which is the least helpful shape that failure has.
const SENTINELS = ['packages/web-product/dist/nextSecurity.cjs', 'packages/schemas/dist/index.js'];
if (SENTINELS.some((file) => !existsSync(join(REPO, file)))) {
  say('building packages once — about two minutes, and only on a fresh clone');
  if (spawnSync('yarn', ['build'], { cwd: REPO, stdio: 'inherit' }).status !== 0) {
    fail('yarn build failed.');
  }
}

// ── Everything else is already this script's job ──────────────────────────────
say('handing over to dev:local — datastores, migrations, instance, services');
// In a process group of its own, which a stop sent here is forwarded to whole.
// Yarn sits between this process and the runner and passes neither SIGINT nor
// SIGHUP on — it swallows the first and dies at once on the second — so a signal
// to this process alone (an IDE's stop button, `kill -INT`) would otherwise stop
// nothing, and a closed terminal would leave the runner and every service up.
// Its own group rather than this one: signalling ours would also reach whatever
// started this process — the IDE, or `tee` on the far side of a pipe.
const dev = spawn('yarn', ['dev:local'], { cwd: REPO, stdio: 'inherit', detached: true });

// This process stays until the runner has finished its shutdown. Left to the
// default disposition, a stop ends it at once, the shell prints its prompt, and
// the runner's last lines land after that prompt with nothing following them —
// which reads as a hang. Forwarded once: the runner ignores a repeated signal.
let stopping = false;
function signalGroup(signal) {
  try {
    process.kill(-dev.pid, signal);
  } catch {
    // Already gone; its exit below still ends this process.
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    signalGroup(signal);
  });
}

// Ctrl-Z and `fg` reach only this process's group, so without these the stack
// would keep running and writing to the terminal behind a suspended job. The
// runner's group is orphaned, where the kernel discards a SIGTSTP that meets its
// default action, and every service sits in a group of its own besides — so it
// is the runner's handler that suspends the stack: it stops each service's group
// and then itself, and resumes them on SIGCONT. A handler here replaces
// SIGTSTP's default stop, which SIGSTOP then performs.
process.on('SIGTSTP', () => {
  signalGroup('SIGTSTP');
  process.kill(process.pid, 'SIGSTOP');
});
process.on('SIGCONT', () => {
  signalGroup('SIGCONT');
});

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Well past the runner's own grace period and port sweep.
const STOP_DEADLINE_MS = 30_000;

dev.on('error', (error) => {
  fail(`could not run yarn dev:local: ${error.message}`);
});
dev.on('exit', (code, signal) => {
  const status = code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0));
  if (!stopping) process.exit(status);
  // Yarn's exit is not the runner's: on SIGHUP yarn dies at once while the
  // runner under it is still stopping, and only the emptied group says it is done.
  const deadline = Date.now() + STOP_DEADLINE_MS;
  setInterval(() => {
    if (groupAlive(dev.pid) && Date.now() < deadline) return;
    process.exit(status);
  }, 100);
});

// ── Once the stack is healthy: the MCP server's key ───────────────────────────
// Allowed to fail: the stack is no less up without it, and the line says how to
// finish by hand.
const BY_HAND = 'run `yarn mcp:setup` once the stack is up to give the MCP server its key';
// A first run migrates and provisions before the API listens.
const HEALTHY_WITHIN_MS = 10 * 60_000;

async function apiHealthy(api) {
  try {
    const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(3_000) });
    return response.ok && (await response.json()).status === 'ok';
  } catch {
    return false;
  }
}

async function setUpMcpWhenHealthy(api) {
  const deadline = Date.now() + HEALTHY_WITHIN_MS;
  while (!(await apiHealthy(api))) {
    if (stopping) return;
    if (Date.now() > deadline) {
      say(`the API at ${api} was not healthy in time; ${BY_HAND}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (stopping) return;
  say('the stack is healthy; giving the MCP server its key (yarn mcp:setup)');
  const setup = spawn('yarn', ['mcp:setup'], { cwd: REPO, stdio: 'inherit' });
  setup.on('error', () => {
    say(`could not run yarn mcp:setup; ${BY_HAND}`);
  });
  setup.on('exit', (code) => {
    if (code !== 0 && !stopping) say(`yarn mcp:setup did not finish; ${BY_HAND}`);
  });
}

if (mcpCredentialMissing) void setUpMcpWhenHealthy(apiUrlOf(envValues));
