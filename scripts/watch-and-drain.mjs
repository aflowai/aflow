#!/usr/bin/env node

/**
 * Runs a TypeScript service and restarts it when its sources change, as
 * `tsx watch` does, except that a restart waits for the service to exit.
 * `tsx watch` sends SIGTERM and SIGKILLs five seconds later, which cuts short
 * a service that drains — the host executor, whose harness runs, checks and
 * reviews take minutes. A restart sends the drain signal (`drainSignal.mjs`),
 * once: a second is the word to stop now, so a change during a drain only
 * waits. The watcher's own SIGTERM or SIGINT is passed on as itself, a stop.
 *
 * Usage: node scripts/watch-and-drain.mjs <entry.ts> <watched dir>...
 * A change is a `.ts` file under a `src` directory of a watched dir, outside
 * `node_modules` and `dist` — what the `tsx watch --include` it replaces read.
 */

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve, sep } from 'node:path';
import process from 'node:process';
import { signalToSend } from './drainSignal.mjs';

const [entry, ...watchedDirs] = process.argv.slice(2);
if (entry === undefined || watchedDirs.length === 0) {
  console.error('Usage: node scripts/watch-and-drain.mjs <entry.ts> <watched dir>...');
  process.exit(1);
}

/** The pause `tsx watch` gives a burst of writes, so a merge's files restart the service once. */
const BURST_MS = 100;

let child = null;
let restartWanted = false;
let stopping = false;
let burst = null;

function start() {
  child = spawn(process.execPath, ['--conditions=ts-source', '--import', 'tsx', entry], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(code ?? 0);
    }
    if (restartWanted) {
      restartWanted = false;
      console.log('[watch] The service has exited; starting it again.');
      start();
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
  if (child === null) {
    console.log(`[watch] ${path} changed; starting the service.`);
    start();
    return;
  }
  if (restartWanted) return;
  restartWanted = true;
  console.log(`[watch] ${path} changed; the service drains, then starts again.`);
  child.kill(signalToSend({ kind: 'restart' }));
}

for (const dir of watchedDirs) {
  const root = resolve(dir);
  watch(root, { recursive: true }, (_event, filename) => {
    if (filename === null) return;
    const path = resolve(root, filename);
    if (!isSource(path)) return;
    if (burst !== null) clearTimeout(burst);
    burst = setTimeout(() => {
      burst = null;
      changed(path);
    }, BURST_MS);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    if (child === null) process.exit(0);
    child.kill(signalToSend({ kind: 'stop', signal }));
  });
}

start();
