#!/usr/bin/env node

/**
 * Production launcher: runs multiple Phoenix services as child processes
 * within a single container/dyno.
 *
 * Usage:
 *   PHOENIX_PROFILE=web-core node scripts/prod-launcher.mjs
 *
 * `PHOENIX_SERVER_ENTRY` overrides the server's composition root; unset means
 * the widest one the artifact contains.
 *
 * Profiles:
 *   web-core        — API server only (Cloud Run)
 *   worker          — Orchestrator + the executors needing no host control (GCE VM)
 *   compute-worker  — Sandbox executor only, the one host mounting the Docker socket
 *   code-worker     — Coding-lane executor only (dedicated/on-demand instance)
 *   web-core-legacy — (dev) server + orchestrator + two executors in one process tree
 *   all             — (dev) everything except the web UI, single instance
 *
 * A profile deployed in production must also carry a connection budget in
 * `POOLED_FLEET` (@aflow/database/connection-budget), or its services fall
 * back to a per-process default that no longer fits the fleet. A guard test
 * enforces it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { serviceBundlePath } from '@aflow/lib/service-bundle-path';
import {
  poolPlan,
  serverMaxConnectionsFromEnv,
  instanceCeilingDrift,
  POOLED_FLEET,
} from '@aflow/database/connection-budget';

// ---------------------------------------------------------------------------
// Service registry: the services a profile may name. All apps are pre-built via
// `yarn build` — no tsx, no watch.
// ---------------------------------------------------------------------------
const SERVICE_REGISTRY = {
  server: {},
  orchestrator: {},
  'executor-ai': {},
  'executor-api': {},
  'executor-user': {},
  'executor-memory': {},
  'executor-compute': {},
  'executor-ui': {},
  'executor-code': {},
  'executor-mcp': {},
};

/** @param {string} name */
const serviceEntry = (name) =>
  serviceBundlePath(name, { override: process.env.PHOENIX_SERVER_ENTRY, exists: existsSync });

// ---------------------------------------------------------------------------
// Profiles: which services run together in each dyno/container.
// ---------------------------------------------------------------------------
const PROFILES = {
  // Cloud Run — HTTP API server only (no background workers)
  'web-core': ['server'],

  // GCE VM — orchestrator and the executors that need no host control.
  // This is the primary worker profile for production.
  //
  // `executor-compute` is deliberately absent. It reaches the host Docker
  // daemon to spawn sandboxes, and a process that can reach that socket can ask
  // for a privileged container bind-mounting `/` — so it is host root whatever
  // user holds it. Keeping it here meant the orchestrator shared a host with
  // that authority while holding model, email and credential-wrapping secrets.
  // It runs on `compute-worker` instead, which holds none of them.
  worker: [
    'orchestrator',
    'executor-ai',
    'executor-api',
    'executor-user',
    'executor-memory',
    'executor-ui',
    'executor-mcp',
  ],

  // Dedicated coding lane — the code executor runs on a bigger/on-demand
  // instance (not the e2-small hot-path worker) consuming aflow:jobs:code.
  'code-worker': ['executor-code'],

  // Dedicated sandbox host — the one workload that mounts the Docker socket,
  // on a machine that holds no model key, no mail credential and no
  // credential-wrapping key, so socket-equals-root buys an attacker the host
  // and nothing carried on it. Distinct from `code-worker`: the sandbox runs
  // `--network none` and the lane needs egress, so co-locating them would put
  // an egress-capable container on the host whose isolation story is that
  // nothing egresses.
  'compute-worker': ['executor-compute'],

  'web-core-legacy': ['server', 'orchestrator', 'executor-api', 'executor-user'],

  // Single instance with everything (for minimal dev/demo)
  all: [
    'server',
    'orchestrator',
    'executor-ai',
    'executor-api',
    'executor-user',
    'executor-memory',
    'executor-compute',
    'executor-code',
    'executor-mcp',
  ],
};

// ---------------------------------------------------------------------------
// Database pool sizes
//
// This process is the only place that knows how many services will share one
// container, so it is the only place that can turn the fleet's declared split
// into a per-service number. Left to itself each service would take the
// package default, and a profile running seven of them would ask the database
// for seven times what a single-service host asks for.
//
// An explicit `DB_MAX_CONNECTIONS` in the environment is an operator override
// and wins; a development profile that carries no production budget is left
// alone, because the database it points at is not the scarce one.
// ---------------------------------------------------------------------------
function databasePoolSizes(profileName) {
  const override = process.env.DB_MAX_CONNECTIONS;
  if (override !== undefined && override.trim() !== '') {
    console.log(`[launcher] DB pool: DB_MAX_CONNECTIONS=${override} (operator override)`);
    return {};
  }

  // Gate on the PROFILE, not on whether its services happen to be budgeted:
  // `all` and `web-core-legacy` run the same services production does, so
  // matching on services alone handed a dev container the production fleet's
  // shares of a database it does not point at.
  if (!(profileName in POOLED_FLEET)) {
    console.log(`[launcher] DB pool: profile "${profileName}" carries no production budget`);
    return {};
  }

  const serverMaxConnections = serverMaxConnectionsFromEnv(process.env);
  // Instance counts come from the declared fleet, not from this host's
  // environment: `PHOENIX_MAX_INSTANCES` is set on the autoscaling service and
  // on none of the VMs, so a host reading its own environment would plan for a
  // fleet smaller than the real one and take a larger share than the other
  // hosts left it. Where the variable IS present it is checked against the
  // declaration instead.
  const plan = poolPlan({ serverMaxConnections });
  const ceilingDrift = instanceCeilingDrift({
    profile: profileName,
    configured: process.env.PHOENIX_MAX_INSTANCES,
  });
  if (ceilingDrift) console.warn(ceilingDrift);

  const mine = Object.fromEntries(
    (PROFILES[profileName] ?? [])
      .filter((s) => plan.perService[s] !== undefined)
      .map((s) => [s, plan.perService[s]]),
  );

  const split = Object.entries(mine)
    .map(([s, n]) => `${s}=${n}`)
    .join(' ');
  console.log(
    `[launcher] DB pool: ${split} ` +
      `(fleet worst case ${plan.fleetWorstCase} of ${plan.budget} servable, ` +
      `server max_connections ${plan.serverMaxConnections})`,
  );
  if (!plan.fits) {
    console.warn(
      `[launcher] DB pool: the fleet's worst case (${plan.fleetWorstCase}) exceeds the ` +
        `${plan.budget} connections available after reserves. Raise the database's ` +
        `max_connections and set DB_SERVER_MAX_CONNECTIONS to match.`,
    );
  }
  return mine;
}

// Track spawned processes for cleanup
const processes = new Map();
const restartDelays = new Map(); // serviceName → current delay in ms
const startTimes = new Map(); // serviceName → Date.now() at spawn
let shuttingDown = false;

const MIN_RESTART_DELAY = 2000;
const MAX_RESTART_DELAY = 30000;
const STABLE_UPTIME_MS = 60000; // reset backoff after 60s of stable uptime

// ---------------------------------------------------------------------------
// Spawn a service as a child process with prefixed log output
// ---------------------------------------------------------------------------
function spawnService(serviceName, command, extraEnv = {}) {
  const [cmd, ...args] = command.split(' ');
  const child = spawn(cmd, args, {
    stdio: 'pipe',
    shell: false,
    env: { ...process.env, ...extraEnv },
    cwd: process.cwd(),
  });

  startTimes.set(serviceName, Date.now());

  const rlOut = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rlOut.on('line', (line) => {
    process.stdout.write(`[${serviceName}] ${line}\n`);
  });

  const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
  rlErr.on('line', (line) => {
    process.stderr.write(`[${serviceName}] ${line}\n`);
  });

  child.on('exit', (code, signal) => {
    processes.delete(serviceName);

    if (shuttingDown) return; // expected during shutdown

    if (code !== null && code !== 0) {
      const uptime = Date.now() - (startTimes.get(serviceName) || 0);

      // Reset backoff if the service was stable for a while
      if (uptime >= STABLE_UPTIME_MS) {
        restartDelays.delete(serviceName);
      }

      const currentDelay = restartDelays.get(serviceName) || MIN_RESTART_DELAY;
      const nextDelay = Math.min(currentDelay * 2, MAX_RESTART_DELAY);
      restartDelays.set(serviceName, nextDelay);

      console.error(
        `[launcher] ${serviceName} exited with code ${code} (uptime ${Math.round(uptime / 1000)}s) — restarting in ${currentDelay / 1000}s`,
      );
      setTimeout(() => {
        if (!shuttingDown) {
          spawnService(serviceName, command, extraEnv);
        }
      }, currentDelay);
    } else if (signal) {
      console.log(`[launcher] ${serviceName} killed by ${signal}`);
    } else {
      // A clean exit is not restarted, so without this line a service that
      // handled SIGTERM and exited 0 simply vanishes: the launcher stays up,
      // the container stays healthy, and nothing anywhere records that the
      // work it was running has stopped.
      console.log(`[launcher] ${serviceName} exited cleanly (code 0) — not restarting`);
    }
  });

  processes.set(serviceName, child);
  return child;
}

// ---------------------------------------------------------------------------
// Graceful shutdown: forward signal to all children, wait, force kill.
// Cloud Run sends SIGTERM with a 10s grace period by default; Docker's
// default stop timeout is 10s too, and most other hosts allow 30s.
// ---------------------------------------------------------------------------

// Detect Cloud Run via K_SERVICE env var (set automatically by Cloud Run)
const isCloudRun = !!process.env.K_SERVICE;
const SHUTDOWN_GRACE_MS = isCloudRun ? 8000 : 25000;

function setupSignalHandlers() {
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const platform = isCloudRun ? 'Cloud Run' : 'this host';
    console.log(
      `\n[launcher] Received ${signal} on ${platform}, shutting down (grace: ${SHUTDOWN_GRACE_MS}ms)...`,
    );
    const exitPromises = [];

    for (const [name, child] of processes.entries()) {
      if (child && !child.killed) {
        console.log(`[launcher] Stopping ${name}...`);
        child.kill('SIGTERM');
        exitPromises.push(
          new Promise((resolve) => {
            child.on('exit', resolve);
          }),
        );
      }
    }

    // Wait with platform-appropriate grace period
    void Promise.race([
      Promise.all(exitPromises),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]).then(() => {
      for (const [name, child] of processes.entries()) {
        if (child && !child.killed) {
          console.log(`[launcher] Force killing ${name}...`);
          child.kill('SIGKILL');
        }
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const profileName = process.env.PHOENIX_PROFILE ?? process.argv[2] ?? '';

  if (!profileName || !PROFILES[profileName]) {
    console.error(`[launcher] Unknown or missing profile: "${profileName}"`);
    console.error(`[launcher] Available profiles: ${Object.keys(PROFILES).join(', ')}`);
    console.error(`[launcher] Set PHOENIX_PROFILE env var or pass as first argument.`);
    process.exit(1);
  }

  const services = PROFILES[profileName];

  setupSignalHandlers();

  console.log(`[launcher] Profile: ${profileName}`);
  console.log(`[launcher] Starting: ${services.join(', ')}`);
  console.log(`[launcher] NODE_ENV: ${process.env.NODE_ENV ?? 'not set'}`);
  console.log();

  const pools = databasePoolSizes(profileName);

  for (const serviceName of services) {
    const entry = SERVICE_REGISTRY[serviceName];
    if (!entry) {
      console.error(`[launcher] Unknown service: ${serviceName}`);
      process.exit(1);
    }
    const bundle = serviceEntry(serviceName);
    // A distribution need not ship every lane. Saying so is the point: without
    // this the spawn fails with a module-not-found several lines into a child
    // process, which reads as a broken build rather than as a profile asking
    // for something this artifact does not contain.
    if (!existsSync(bundle)) {
      console.error(`[launcher] Service "${serviceName}" is not part of this distribution.`);
      console.error(`[launcher]   expected ${bundle}`);
      process.exit(1);
    }
    const command = `node ${bundle}`;
    const serviceEnv = entry.env ?? {};
    const poolMax = pools[serviceName];
    spawnService(serviceName, command, {
      ...serviceEnv,
      ...(poolMax === undefined ? {} : { DB_MAX_CONNECTIONS: String(poolMax) }),
    });
  }

  // Cloud Run requires an HTTP endpoint for health checks.
  // If the profile doesn't include the Fastify server, start a minimal one.
  if (!services.includes('server')) {
    const port = process.env.PORT || 8080;
    createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', profile: profileName }));
    }).listen(port, () => {
      console.log(`[launcher] Health server listening on :${port}`);
    });
  }

  // Keep process alive
  process.stdin.resume();
}

main();
