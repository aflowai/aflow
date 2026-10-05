#!/usr/bin/env node
/**
 * One command from a fresh clone to a running development stack.
 *
 * `scripts/dev-local.ts` already brings up the datastores, applies migrations,
 * provisions the instance and starts the edition's services — this adds only the
 * preconditions it assumes and cannot recover from, each of which otherwise
 * surfaces minutes later as an error naming something other than the cause —
 * and, once the stack is healthy, the MCP server's key when it has none, and a
 * line whenever no orchestrator is consuming.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { apiUrlOf, authFileOf, envNamingAuthFile } from './mcp-local-setup.mjs';
import {
  INITIAL_ORCHESTRATOR_WATCH,
  ORCHESTRATOR_POLL_MS,
  nextOrchestratorReport,
  readOrchestratorHealth,
} from './orchestratorHealth.mjs';
import {
  composeProjectOf,
  credentialReadiness,
  mcpTokenState,
  pairedHostEnvPath,
} from './stackCredentials.mjs';
import {
  REDIS_URL_KEY,
  ensureMachinePassword,
  isMachineRedisUrl,
  parseEnvFile,
  stackEnv,
  stackEnvPath,
} from './stackEnv.mjs';
import { probeRedis } from './stackRedis.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const say = (message) => {
  console.log(`\x1b[36m[start]\x1b[0m ${message}`);
};
const warn = (message) => {
  console.warn(`\x1b[33m[start]\x1b[0m ${message}`);
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

// ── The machine's Redis password ──────────────────────────────────────────────
// One for every checkout, because they all share one Redis container.
const machineFile = stackEnvPath(process.env);
const machine = ensureMachinePassword(machineFile);
if (machine.created) say(`wrote this machine's Redis password to ${machineFile}`);

// ── The MCP server's credential ───────────────────────────────────────────────
// Minted by `yarn mcp:setup` once the API is healthy (below), with the session
// token a client presents for it. The line naming the file goes into `.env`
// now: the MCP server reads it once, at its start, and reads the file itself per
// session — so the key reaches the next session without a restart.
const envFile = join(REPO, '.env');
const envValues = stackEnv(process.env, parseEnvFile(readFileSync(envFile, 'utf-8')));
const mcpAuthFile = authFileOf(envValues, REPO);
const mcpToken = mcpTokenState(
  existsSync(mcpAuthFile) ? readFileSync(mcpAuthFile, 'utf-8') : undefined,
);
const mcpCredentialMissing = mcpToken !== 'present';
if (mcpCredentialMissing) {
  const named = envNamingAuthFile(readFileSync(envFile, 'utf-8'));
  if (named !== undefined) writeFileSync(envFile, named);
}

// ── Each service's credential ─────────────────────────────────────────────────
// Before anything starts: a Redis started, or still running, without its
// password would serve the write approvals the push gate reads to anything on
// this machine.
const dotenv = parseEnvFile(readFileSync(envFile, 'utf-8'));
const redisUrl = stackEnv(process.env, dotenv, { machinePassword: machine.password })[
  REDIS_URL_KEY
];
const readiness = credentialReadiness({
  checkoutRedisUrl: stackEnv(process.env, dotenv)[REDIS_URL_KEY],
  checkoutRedisSource: process.env[REDIS_URL_KEY] === undefined ? '.env' : 'the shell',
  machinePassword: machine.password,
  machineFile,
  redisUrl,
  redis: await probeRedis(redisUrl, isMachineRedisUrl(redisUrl) ? machine.password : undefined),
  mcpToken,
  mcpAuthFile: relative(REPO, mcpAuthFile) || mcpAuthFile,
  hostEnvPath: pairedHostEnvPath(),
  composeProject: composeProjectOf(process.env, dotenv),
});
say('credentials:');
for (const line of readiness.lines) say(`  ${line}`);
if (readiness.failure !== undefined) fail(readiness.failure.message, readiness.failure.remedy);

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

// ── Once the stack is healthy: the MCP server's key, and the orchestrator ─────
// The key is allowed to fail: the stack is no less up without it, and the line
// says how to finish by hand. The orchestrator is watched for as long as the
// stack runs (`orchestratorHealth.mjs`).
const BY_HAND = 'run `yarn mcp:setup` once the stack is up to give the MCP server its key';
// A first run migrates and provisions before the API listens.
const HEALTHY_WITHIN_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiHealthy(api) {
  try {
    const response = await fetch(`${api}/health`, { signal: AbortSignal.timeout(3_000) });
    return response.ok && (await response.json()).status === 'ok';
  } catch {
    return false;
  }
}

/** Whether the API became healthy before the deadline, and the stack is still up. */
async function whenApiHealthy(api) {
  const deadline = Date.now() + HEALTHY_WITHIN_MS;
  while (!(await apiHealthy(api))) {
    if (stopping) return false;
    if (Date.now() > deadline) {
      say(
        `the API at ${api} was not healthy in time` + (mcpCredentialMissing ? `; ${BY_HAND}` : ''),
      );
      return false;
    }
    await sleep(3_000);
  }
  return !stopping;
}

function setUpMcp() {
  say('the stack is healthy; giving the MCP server its key (yarn mcp:setup)');
  // No stdin: a question asked here would sit among the stack's log lines.
  const setup = spawn('yarn', ['mcp:setup'], {
    cwd: REPO,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  setup.on('error', () => {
    say(`could not run yarn mcp:setup; ${BY_HAND}`);
  });
  setup.on('exit', (code) => {
    if (code !== 0 && !stopping) say(`yarn mcp:setup did not finish; ${BY_HAND}`);
  });
}

async function watchOrchestrator(api) {
  let watch = INITIAL_ORCHESTRATOR_WATCH;
  while (!stopping) {
    const report = nextOrchestratorReport(watch, await readOrchestratorHealth(api));
    watch = report.watch;
    if (report.line?.level === 'warn') warn(report.line.text);
    else if (report.line !== undefined) say(report.line.text);
    await sleep(ORCHESTRATOR_POLL_MS);
  }
}

const api = apiUrlOf(envValues);
void whenApiHealthy(api).then(async (healthy) => {
  if (!healthy) return;
  if (mcpCredentialMissing) setUpMcp();
  await watchOrchestrator(api);
});
