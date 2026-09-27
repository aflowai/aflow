#!/usr/bin/env node

/**
 * Dev runner: orchestrates multiple services with prefixed logs and clean shutdown.
 * Infra runs in Docker; apps run on host for fast iteration and debugging.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import process from 'node:process';

import { findRunningStack, profileConflicts, stackConflictMessage } from './devStackLock.mjs';

/** When true, child exit must not remove entries until shutdown finishes (see shutdown + port sweep). */
let devRunnerShuttingDown = false;

// Service registry: maps service names to yarn commands + optional env overrides.
// All app services use `tsx watch` for automatic restart on file changes.
/**
 * Which composition root the dev server runs. `dev:local` sets the edition, so
 * both stacks come off this one table; a checkout carrying no hosted root has
 * only the core one to run.
 */
function serverDevScript() {
  if (process.env.PHOENIX_EDITION === 'community-local') return 'server:dev';
  const { scripts = {} } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  return 'server:dev:hosted' in scripts ? 'server:dev:hosted' : 'server:dev';
}

const SERVICE_REGISTRY = {
  server: { cmd: `yarn ${serverDevScript()}`, ports: [3000] },
  orchestrator: { cmd: 'yarn orchestrator:dev' },
  'executor-mock': { cmd: 'yarn executor:mock' },
  'executor-mock-partial': {
    cmd: 'yarn executor:mock',
    env: { MOCK_STEP_TYPES: 'flowControl,platform' },
  },
  'executor-ai': { cmd: 'yarn executor:ai' },
  'executor-api': { cmd: 'yarn executor:api' },
  'executor-user': { cmd: 'yarn executor:user' },
  'executor-memory': { cmd: 'yarn executor:memory' },
  'executor-ui': { cmd: 'yarn executor:ui' },
  'executor-mcp': { cmd: 'yarn executor:mcp' },
  'executor-compute': { cmd: 'yarn executor:compute' },
  'executor-code': { cmd: 'yarn executor:code' },
  // The paired daemon for the operator's own machine. It reads its Redis from
  // the env `pair` wrote next to the host policy, so which stack it joins is
  // that file's decision; the profile only starts it. `dotenv: false` keeps the
  // shared `.env` and the runner's overrides out of its environment, because an
  // ambient REDIS_URL wins over the paired one and points it at another
  // instance. Unpaired, or with a daemon already running, it is dropped from
  // the profile with a hint rather than duplicated or crash-looped.
  'executor-host': { cmd: 'yarn executor:host', dotenv: false },
  voice: { cmd: 'yarn voice:dev' },
  web: { cmd: 'yarn web:dev', ports: [3001] },
  // The local edition's own application, on the port the hosted one uses in its
  // own profiles — one stack at a time, and the browser should not have to know
  // which edition it is talking to.
  'web-local': { cmd: 'WEB_DEV_PORT=3001 yarn workspace @aflow/web-local dev', ports: [3001] },
  // The product package, rebuilt as it changes.
  //
  // Every other workspace reaches `@aflow/*` through the `ts-source` condition
  // and needs no build in development. A Next application does not: its bundler
  // resolves the `import` condition, so both web applications read `dist` and an
  // edit to the package is invisible until something rebuilds it. Without this
  // the failure is a missing export naming a symbol the source plainly has.
  'web-product': { cmd: 'yarn workspace @aflow/web-product dev' },
  mcp: { cmd: 'yarn mcp:dev', ports: [3100] },
  'packages-watch': { cmd: 'yarn packages:watch' },
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Why a service cannot start here, or null.
 *
 * The public core carries no hosted web application and no coding lane, and the
 * cut drops the root scripts that named them — so a profile written for the
 * monorepo names services this edition has no way to run. Reported and skipped
 * rather than left to fail as an opaque "command not found" several lines into
 * the output of nine other processes.
 */
function whyUnavailable(name) {
  const cmd = SERVICE_REGISTRY[name]?.cmd;
  if (cmd === undefined) return 'no such service';

  // A service command is either a root script or a direct workspace command, and a
  // root script is itself usually a workspace command — so the workspace has to be
  // checked through that indirection, not only on the text here. `yarn web:dev`
  // survives the cut while `@aflow/web` does not, which is exactly that case.
  const bare = cmd.replace(/^(?:[A-Z_]+=\S+\s+)+/, '');
  const rootScript = /^yarn ([a-z][a-z0-9:_-]*)\b/.exec(bare);
  let resolved = cmd;
  if (rootScript !== null && rootScript[1] !== 'workspace') {
    const script = ROOT_SCRIPTS[rootScript[1]];
    if (script === undefined) return `this edition has no \`yarn ${rootScript[1]}\` script`;
    resolved = script;
  }

  const workspace = /yarn workspace (@aflow\/[a-z0-9-]+)/.exec(resolved);
  if (workspace !== null && !WORKSPACES.has(workspace[1])) {
    return `this edition does not carry ${workspace[1]}`;
  }
  return null;
}

const ROOT_SCRIPTS = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).scripts;

const WORKSPACES = new Set(
  ['apps', 'packages'].flatMap((group) => {
    const base = join(REPO_ROOT, group);
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .map((name) => join(base, name, 'package.json'))
      .filter((file) => existsSync(file))
      .map((file) => JSON.parse(readFileSync(file, 'utf-8')).name)
      .filter((name) => typeof name === 'string');
  }),
);

/**
 * What `yarn dev` means, decided by which applications are here rather than by a
 * flag. `all` starts the hosted web application; a repository without it would
 * otherwise bring up an API and no interface at all.
 */
const DEFAULT_PROFILE = WORKSPACES.has('@aflow/web') ? 'all' : 'local';

// Predefined profiles
const PROFILES = {
  core: ['orchestrator', 'server', 'executor-mock'],
  engine: ['orchestrator', 'executor-mock'],
  api: ['server'],
  ui: ['web-product', 'web', 'server'],
  // Full stack including compute executor (requires Docker on host for sandbox steps)
  all: [
    'orchestrator',
    'server',
    'executor-ai',
    'executor-api',
    'executor-user',
    'executor-memory',
    'executor-ui',
    'executor-mcp',
    'executor-compute',
    'executor-code',
    'web-product',
    'web',
  ],
  // The local edition: the coding lane and voice are not part of the product.
  // The compute sandbox is — running code is one of the capabilities the product
  // is for, so it starts with everything else rather than waiting to be asked
  // for. Needs Docker on the host, as the `all` profile does. The host executor
  // is the local edition's coding and command lane; it starts when this machine
  // is paired (see `pairedHostEnvPath`).
  local: [
    'orchestrator',
    'server',
    'executor-host',
    'executor-ai',
    'executor-api',
    'executor-user',
    'executor-memory',
    'executor-ui',
    'executor-mcp',
    'executor-compute',
    'web-product',
    'web-local',
  ],
  mcp: ['mcp'],
  // 'mock' profile: legacy — uses mock executor for everything
  mock: ['orchestrator', 'server', 'executor-mock', 'web-product', 'web'],
};

// Track spawned processes for cleanup
const processes = new Map();

/**
 * Parse CLI arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    services: null,
    profile: null,
    infra: null,
    env: '.env',
    watchPackages: false,
    incompleteProfiles: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--watch-packages') {
      options.watchPackages = true;
    } else if (arg === '--incomplete-profiles') {
      options.incompleteProfiles = true;
    } else if (arg === '--services' && i + 1 < args.length) {
      options.services = args[++i].split(',').map((s) => s.trim());
    } else if (arg === '--profile' && i + 1 < args.length) {
      options.profile = args[++i];
    } else if (arg === '--infra' && i + 1 < args.length) {
      options.infra = args[++i];
    } else if (arg === '--env' && i + 1 < args.length) {
      options.env = args[++i];
    }
  }

  return options;
}

/**
 * Handle infra commands (delegate to existing yarn scripts)
 */
async function handleInfra(command) {
  const validCommands = ['up', 'down', 'reset', 'logs'];
  if (!validCommands.includes(command)) {
    console.error(`Invalid infra command: ${command}. Valid: ${validCommands.join(', ')}`);
    process.exit(1);
  }

  const yarnCommand = command === 'logs' ? 'infra:logs' : `infra:${command}`;
  const child = spawn('yarn', [yarnCommand], {
    stdio: 'inherit',
    shell: true,
  });

  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Infra command failed with code ${code}`));
      }
    });
  });
}

/**
 * Load environment variables from .env file
 */
function loadEnv(envPath) {
  try {
    const content = readFileSync(envPath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
    return env;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`Warning: .env file not found at ${envPath}, continuing without it`);
      return {};
    }
    throw error;
  }
}

/**
 * Merge .env-derived vars onto process.env and enable ANSI in children when safe.
 *
 * Children use stdio: 'pipe' for prefixed logs, so their stdout is not a TTY and
 * @aflow/observability (and pino-pretty) would skip colors unless FORCE_COLOR is set.
 * When the dev runner itself is in a real terminal, force colors so logs match
 * `yarn server:dev` etc.; respect NO_COLOR and explicit FORCE_COLOR from the user.
 */
function buildSpawnEnv(dotenvVars) {
  // `null` means the service reads its connection from its own paired file:
  // it gets the parent environment alone, with neither `.env` nor the overrides.
  const merged = dotenvVars === null ? { ...process.env } : { ...process.env, ...dotenvVars };
  // `.env` is merged over the parent environment, so a caller that must win —
  // `dev:local` pinning an edition the shared file contradicts — hands its
  // values here instead of exporting them and watching the file refill them.
  const overrides = process.env['PHOENIX_DEV_ENV_OVERRIDES'];
  if (dotenvVars !== null && overrides !== undefined && overrides !== '') {
    Object.assign(merged, JSON.parse(overrides));
  }
  if (
    process.stdout.isTTY === true &&
    merged['NO_COLOR'] == null &&
    merged['FORCE_COLOR'] == null
  ) {
    merged['FORCE_COLOR'] = '1';
  }
  return merged;
}

/**
 * Spawn a service process with prefixed output.
 * Uses `detached: true` so we can kill the entire process group on shutdown,
 * ensuring child tsx/node processes don't outlive the wrapper.
 */
function spawnService(serviceName, command, env) {
  const [cmd, ...args] = command.split(' ');
  const child = spawn(cmd, args, {
    stdio: 'pipe',
    shell: true,
    detached: true,
    env: buildSpawnEnv(env),
  });

  // Prefix stdout lines
  const rlOut = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  rlOut.on('line', (line) => {
    console.log(`[${serviceName}] ${line}`);
  });

  // Prefix stderr lines
  const rlErr = createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });
  rlErr.on('line', (line) => {
    console.error(`[${serviceName}] ${line}`);
  });

  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[${serviceName}] Process exited with code ${code}`);
    } else if (signal) {
      console.log(`[${serviceName}] Process terminated by signal ${signal}`);
    }
    // During shutdown, keep entries so the force-kill pass still sees them; the shell can exit
    // while a grandchild (e.g. node on :3000) is still alive.
    if (!devRunnerShuttingDown) {
      processes.delete(serviceName);
    }
  });

  processes.set(serviceName, child);
  return child;
}

/**
 * Where `pair` wrote this machine's host env, or null when it never ran. The
 * host executor resolves the same directory (`PHOENIX_HOST_POLICY_PATH`, then
 * `PHOENIX_HOST_DIR`, then `~/.aflow`).
 */
function pairedHostEnvPath() {
  const policyPath = process.env.PHOENIX_HOST_POLICY_PATH?.trim();
  const dir =
    policyPath !== undefined && policyPath !== ''
      ? join(policyPath, '..')
      : process.env.PHOENIX_HOST_DIR?.trim() || join(homedir(), '.aflow');
  const envPath = join(dir, 'host.env');
  return existsSync(envPath) ? envPath : null;
}

/** Whether a host executor already runs here, as the launch-agent service or in a foreground shell. */
function hostExecutorAlreadyRunning() {
  try {
    const out = execSync("pgrep -f 'aflow-executor-host/(src|dist)/index' || true", {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve service list from CLI options
 */
function resolveServices(options) {
  if (options.services) {
    // Validate all services exist
    const invalid = options.services.filter((s) => !SERVICE_REGISTRY[s]);
    if (invalid.length > 0) {
      console.error(`Unknown services: ${invalid.join(', ')}`);
      console.error(`Available services: ${Object.keys(SERVICE_REGISTRY).join(', ')}`);
      process.exit(1);
    }
    return options.services;
  }

  if (options.profile) {
    if (!PROFILES[options.profile]) {
      console.error(`Unknown profile: ${options.profile}`);
      console.error(`Available profiles: ${Object.keys(PROFILES).join(', ')}`);
      process.exit(1);
    }
    const services = [...PROFILES[options.profile]];
    if (services.includes('executor-host')) {
      if (pairedHostEnvPath() === null) {
        services.splice(services.indexOf('executor-host'), 1);
        console.error(
          '[dev] executor-host not started: this machine is not paired (no host.env under ' +
            '~/.aflow or PHOENIX_HOST_DIR). Pair it with ' +
            'AFLOW_PAIR_SECRET=<instance secret> yarn workspace @aflow/aflow-executor-host pair --api <url>, ' +
            'then restart this profile.',
        );
      } else if (hostExecutorAlreadyRunning()) {
        services.splice(services.indexOf('executor-host'), 1);
        console.error(
          '[dev] executor-host not started: a host executor is already running on this machine ' +
            '(the launch-agent service or a foreground `yarn executor:host`). Only one may run; ' +
            'it keeps serving this stack.',
        );
      }
    }
    for (const name of [...services]) {
      const missing = whyUnavailable(name);
      if (missing === null) continue;
      services.splice(services.indexOf(name), 1);
      console.error(`[dev] ${name} not started: ${missing}`);
    }
    if (options.watchPackages) {
      services.push('packages-watch');
    }
    return services;
  }

  if (!options.profile && !options.services) {
    console.error(`[dev] no profile given; starting \`${DEFAULT_PROFILE}\``);
    return resolveServices({ ...options, profile: DEFAULT_PROFILE });
  }

  // Default: show help
  console.error('Error: Must specify either --services <csv> or --profile <name>');
  console.error('\nUsage:');
  console.error('  node scripts/dev.mjs --services server,orchestrator');
  console.error('  node scripts/dev.mjs --profile core');
  console.error('  node scripts/dev.mjs --profile all --watch-packages');
  console.error('  node scripts/dev.mjs --infra up|down|reset|logs');
  console.error('\nProfiles:');
  for (const [name, services] of Object.entries(PROFILES)) {
    console.error(`  ${name}: ${services.join(', ')}`);
  }
  console.error('\nFlags:');
  console.error('  --watch-packages  Auto-rebuild packages on source changes');
  process.exit(1);
}

/**
 * Kill an entire process group (the spawned shell + all its children).
 * Falls back to killing just the child if process group kill fails.
 */
function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead
    }
  }
}

/**
 * Last-resort cleanup: kill whatever is still bound to the ports of the services
 * this runner started (orphan node/tsx after shell exit). Only those: another
 * stack's server and web share these port numbers, and a runner that owned only
 * the MCP server would otherwise kill them on its way out.
 *
 * `-sTCP:LISTEN` is load-bearing, not a narrowing: without it `lsof` reports
 * every socket on the port including the far end, so the sweep SIGKILLed the
 * browser that had a tab open on the dev server.
 */
function ownedPorts() {
  return [...new Set([...processes.keys()].flatMap((name) => SERVICE_REGISTRY[name]?.ports ?? []))];
}

function killListenersOnOwnedPorts(ports) {
  for (const port of ports) {
    try {
      execSync(`lsof -t -sTCP:LISTEN -iTCP:${port} 2>/dev/null | xargs kill -9 2>/dev/null`, {
        shell: true,
        stdio: 'ignore',
      });
    } catch {
      // No listeners or already gone
    }
  }
}

/**
 * Setup signal handlers for clean shutdown.
 *
 * Strategy: send SIGTERM to the direct child only (the shell/yarn wrapper).
 * This lets tsx watch propagate the signal to the app naturally, so it can
 * run its own graceful shutdown without interference.
 *
 * After the grace period, SIGKILL the entire process GROUP to ensure no
 * orphan tsx/node processes linger.
 *
 * Important: `child.killed` becomes true as soon as `kill()` is called, so we
 * must not use it to detect "still running" — otherwise the SIGKILL path never
 * runs and detached children (e.g. server on :3000) survive after Ctrl+C.
 */
function setupSignalHandlers() {
  const GRACE_PERIOD_MS = 10_000;
  let shuttingDown = false;

  const isStillRunning = (child) => child && child.exitCode === null && child.signalCode === null;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    devRunnerShuttingDown = true;

    console.log(
      `\n[dev-runner] Received ${signal}, shutting down (${GRACE_PERIOD_MS / 1000}s grace)...`,
    );
    const shutdownPromises = [];

    for (const [name, child] of processes.entries()) {
      if (isStillRunning(child)) {
        console.log(`[dev-runner] Stopping ${name}...`);
        // SIGTERM to direct child only — let tsx watch forward it cleanly
        try {
          child.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        shutdownPromises.push(
          new Promise((resolve) => {
            child.on('exit', resolve);
          }),
        );
      }
    }

    Promise.race([
      Promise.all(shutdownPromises),
      new Promise((resolve) => setTimeout(resolve, GRACE_PERIOD_MS)),
    ]).then(() => {
      // Force kill any survivors via process group (shell may already have exited)
      for (const [name, child] of processes.entries()) {
        if (isStillRunning(child)) {
          console.log(`[dev-runner] Force killing ${name} (pgid ${child.pid})...`);
          killProcessGroup(child, 'SIGKILL');
        }
      }
      // Shell can exit before tsx/node release ports; pgid kill may miss grandchildren.
      const ports = ownedPorts();
      if (ports.length > 0) {
        console.log(`[dev-runner] Clearing ports ${ports.join(', ')} if anything still listens...`);
        killListenersOnOwnedPorts(ports);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Closing the terminal tab sends SIGHUP; without this, Node exits immediately and
  // never runs shutdown(), so detached children (server on :3000, etc.) survive.
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

/**
 * Main entry point
 */
async function main() {
  const options = parseArgs();

  // The profiles this tree cannot run whole. The core cut drops the root scripts
  // that start them: a profile missing its web application starts an API with no
  // interface, which is a broken command rather than a smaller one.
  if (options.incompleteProfiles) {
    const incomplete = Object.entries(PROFILES)
      .filter(([, services]) => services.some((name) => whyUnavailable(name) !== null))
      .map(([name]) => name);
    console.log(JSON.stringify(incomplete));
    return;
  }

  // Handle infra commands
  if (options.infra) {
    await handleInfra(options.infra);
    return;
  }

  // Resolve services to run
  const services = resolveServices(options);

  // One stack per machine, refused rather than raced. Two of them attach to the
  // same Redis and join the same consumer group, so the second looks healthy
  // while splitting the first one's work — and both would bind the same ports.
  //
  // Refused here, before `setupSignalHandlers`, and that order is load-bearing:
  // the teardown those handlers install sweeps the ports of whatever this runner
  // started, so a refusal raised after them could kill the very stack it
  // declined to join.
  if (options.profile === undefined || profileConflicts(options.profile, PROFILES)) {
    const conflict = stackConflictMessage(findRunningStack(), {
      command: process.env['PHOENIX_DEV_RESTART_HINT'] ?? 'yarn dev',
    });
    if (conflict !== undefined) {
      console.error(`\n[dev-runner] ${conflict}\n`);
      process.exit(1);
    }
  }

  // Check for stale packages (advisory)
  try {
    const { execSync } = await import('node:child_process');
    execSync('node scripts/check-package-staleness.mjs', { stdio: 'inherit' });
  } catch {
    // Non-fatal — continue starting services
  }

  // Load environment
  const env = loadEnv(options.env);

  // Setup signal handlers
  setupSignalHandlers();

  // Spawn all services
  console.log(`[dev-runner] Starting services: ${services.join(', ')}`);
  console.log(`[dev-runner] Using env file: ${options.env}\n`);

  for (const serviceName of services) {
    const entry = SERVICE_REGISTRY[serviceName];
    if (!entry) {
      console.error(`[dev-runner] Unknown service: ${serviceName}`);
      process.exit(1);
    }
    const command = typeof entry === 'string' ? entry : entry.cmd;
    const serviceEnv =
      typeof entry === 'object' && entry.dotenv === false
        ? null
        : typeof entry === 'object' && entry.env
          ? { ...env, ...entry.env }
          : env;
    spawnService(serviceName, command, serviceEnv);
  }

  // Keep process alive
  process.stdin.resume();
}

// eslint-disable-next-line @typescript-eslint/use-unknown-in-catch-callback-variable -- .mjs has no type annotations
main().catch((error) => {
  console.error('[dev-runner] Fatal error:', error);
  process.exit(1);
});
