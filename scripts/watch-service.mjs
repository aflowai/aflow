#!/usr/bin/env node

/**
 * Runs a TypeScript service and starts it again when its sources change, as
 * `tsx watch` does, and when it crashes, as the appliance's launcher does.
 * `tsx watch` restarts on a change only: a service that died stayed dead until
 * somebody edited a file, while the watch process above it stayed up, so
 * nothing supervising the stack could tell.
 *
 * A change restarts the service with SIGTERM and kills it after the grace
 * `tsx watch` gave. With `--drain` it sends the drain signal instead
 * (`drainSignal.mjs`) and waits for the exit however long that takes — the
 * host executor's harness runs, checks and reviews take minutes — once: a
 * second is the word to stop now, so a change during a drain only waits.
 *
 * A crash — a non-zero exit nobody asked for — starts it again after the
 * launcher's backoff (`serviceRestart.mjs`), and a change during that wait
 * starts it at once. A clean exit, or a kill by a signal from elsewhere, waits
 * for the next change. The watcher's own SIGTERM or SIGINT is passed on as
 * itself, a stop.
 *
 * Usage: node scripts/watch-service.mjs [--drain] <entry.ts> <watched dir>...
 * A change is a `.ts` file under a `src` directory of a watched dir, outside
 * `node_modules` and `dist` — what the `tsx watch --include` it replaces read.
 */

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve, sep } from 'node:path';
import process from 'node:process';
import { signalToSend } from './drainSignal.mjs';
import { restartAfterExit } from './serviceRestart.mjs';

const DRAIN_FLAG = '--drain';
const args = process.argv.slice(2);
const drains = args[0] === DRAIN_FLAG;
const [entry, ...watchedDirs] = drains ? args.slice(1) : args;
if (entry === undefined || watchedDirs.length === 0) {
  console.error(
    `Usage: node scripts/watch-service.mjs [${DRAIN_FLAG}] <entry.ts> <watched dir>...`,
  );
  process.exit(1);
}

/** The pause `tsx watch` gives a burst of writes, so a merge's files restart the service once. */
const BURST_MS = 100;

/** How long a restart for a change waits for the service to exit before killing it, as `tsx watch` does. */
const RESTART_KILL_GRACE_MS = 5_000;

let child = null;
let startedAt = 0;
let restartWanted = false;
let stopping = false;
let burst = null;
let killTimer = null;
let crashRestart = null;
let backoffMs;

function start() {
  if (crashRestart !== null) {
    clearTimeout(crashRestart);
    crashRestart = null;
  }
  startedAt = Date.now();
  // Absolute, so the process names the checkout it runs from: the single-stack
  // check finds a running stack's worktree by it (`devStackLock.mjs`).
  child = spawn(process.execPath, ['--conditions=ts-source', '--import', 'tsx', resolve(entry)], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (stopping) {
      process.exit(code ?? 0);
    }
    if (restartWanted) {
      restartWanted = false;
      console.log('[watch] The service has exited; starting it again.');
      start();
      return;
    }
    const decision = restartAfterExit({ code, uptimeMs: Date.now() - startedAt, backoffMs });
    if (decision.restart) {
      backoffMs = decision.nextBackoffMs;
      console.log(
        `[watch] The service exited with code ${String(code)}; starting it again in ${String(decision.delayMs / 1000)}s, or at the next change.`,
      );
      crashRestart = setTimeout(start, decision.delayMs);
      return;
    }
    console.log(
      `[watch] The service exited (${signal ?? `code ${String(code)}`}); it starts again on the next change.`,
    );
  });
}

function isSource(path) {
  const parts = path.split(sep);
  return (
    path.endsWith('.ts') &&
    parts.includes('src') &&
    !parts.includes('node_modules') &&
    !parts.includes('dist')
  );
}

function changed(path) {
  if (stopping) return;
  // New code is a new start: the backoff a crash loop built up belongs to the old.
  backoffMs = undefined;
  if (child === null) {
    console.log(`[watch] ${path} changed; starting the service.`);
    start();
    return;
  }
  if (restartWanted) return;
  restartWanted = true;
  if (drains) {
    console.log(`[watch] ${path} changed; the service drains, then starts again.`);
    child.kill(signalToSend({ kind: 'restart' }));
    return;
  }
  console.log(`[watch] ${path} changed; restarting the service.`);
  child.kill('SIGTERM');
  killTimer = setTimeout(() => {
    child?.kill('SIGKILL');
  }, RESTART_KILL_GRACE_MS);
}

for (const dir of watchedDirs) {
  const root = resolve(dir);
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const path = resolve(root, filename);
    if (!isSource(path)) return;
    if (burst !== null) clearTimeout(burst);
    burst = setTimeout(() => {
      burst = null;
      changed(path);
    }, BURST_MS);
  });
  // Unhandled, a failed watch would end this process and the service under it.
  watcher.on('error', (error) => {
    watcher.close();
    console.error(
      `[watch] Watching ${dir} failed (${error.message}); a change there no longer restarts the service, and a crash still does.`,
    );
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    if (crashRestart !== null) clearTimeout(crashRestart);
    if (child === null) process.exit(0);
    child.kill(signalToSend({ kind: 'stop', signal }));
  });
}

start();
