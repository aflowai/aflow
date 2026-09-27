#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestEntry = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

export function buildVitestInvocation(argv) {
  const [mode = 'full', ...rawArguments] = argv;
  const argumentsAfterSeparator = rawArguments.filter((argument) => argument !== '--');

  switch (mode) {
    case 'full':
      return { command: 'run', arguments: argumentsAfterSeparator, lock: true };
    case 'profile':
      return {
        command: 'run',
        arguments: [
          '--experimental.importDurations.print=on-warn',
          '--experimental.importDurations.limit=20',
          ...argumentsAfterSeparator,
        ],
        lock: true,
      };
    case 'changed': {
      const [since, ...extraArguments] = argumentsAfterSeparator;
      const hasSince = since !== undefined && !since.startsWith('-');
      return {
        command: 'run',
        arguments: [
          `--changed=${hasSince ? since : 'main'}`,
          ...(hasSince ? extraArguments : argumentsAfterSeparator),
        ],
        lock: false,
      };
    }
    case 'workspace': {
      const [workspace, ...extraArguments] = argumentsAfterSeparator;
      if (!workspace || workspace.startsWith('-')) {
        throw new Error('Usage: yarn test:workspace <package-name> [vitest options]');
      }
      return {
        command: 'run',
        arguments: [`--project=${workspace}`, ...extraArguments],
        lock: false,
      };
    }
    case 'file': {
      const [file, ...extraArguments] = argumentsAfterSeparator;
      if (!file || file.startsWith('-')) {
        throw new Error('Usage: yarn test:file <path> [vitest options]');
      }
      return { command: 'run', arguments: [file, ...extraArguments], lock: false };
    }
    default:
      throw new Error(`Unknown test mode "${mode}"`);
  }
}

export function unsupportedNodeMessage(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  if (major === 22) return undefined;
  return `Phoenix tests require Node 22 (current: ${version}). Run \`nvm use\` or select the version in .node-version.`;
}

export function projectFilterForMode(mode, argv, root = repoRoot) {
  const argumentsAfterSeparator = argv.filter((argument) => argument !== '--');
  if (mode === 'workspace') {
    const workspace = argumentsAfterSeparator[0];
    return workspace && !workspace.startsWith('-') ? workspace : undefined;
  }
  if (mode !== 'file') return undefined;

  const projects = new Set();
  for (const argument of argumentsAfterSeparator) {
    if (argument.startsWith('-')) continue;
    const absolutePath = path.resolve(root, argument);
    if (!existsSync(absolutePath)) continue;
    const [group, workspace] = path.relative(root, absolutePath).split(path.sep);
    if (group === 'scripts') {
      projects.add('phoenix-test-infrastructure');
      continue;
    }
    if ((group !== 'apps' && group !== 'packages') || !workspace) return undefined;
    const manifest = JSON.parse(
      readFileSync(path.join(root, group, workspace, 'package.json'), 'utf8'),
    );
    if (typeof manifest.name !== 'string') return undefined;
    projects.add(manifest.name);
  }
  return projects.size > 0 ? [...projects].join(',') : undefined;
}

export function lockOwnerState(metadata, now = Date.now(), isProcessAlive = processIsAlive) {
  if (!metadata || typeof metadata.pid !== 'number' || typeof metadata.startedAt !== 'number') {
    return 'unknown';
  }
  const ownerPids = [metadata.pid, metadata.childPid].filter(Number.isInteger);
  return ownerPids.some((pid) => isProcessAlive(pid, now)) ? 'active' : 'stale';
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function resolveLockDirectory() {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Unable to resolve the Git common directory: ${result.stderr.trim()}`);
  }
  const identity = createHash('sha256').update(result.stdout.trim()).digest('hex').slice(0, 16);
  return path.join(tmpdir(), `phoenix-test-${identity}.lock`);
}

async function readLockMetadata(lockDirectory) {
  try {
    return JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function reclaimStaleLock(lockDirectory) {
  const staleDirectory = `${lockDirectory}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDirectory, staleDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await rm(staleDirectory, { recursive: true, force: true });
}

async function publishLock(lockDirectory, metadata) {
  const candidateDirectory = `${lockDirectory}.candidate-${process.pid}-${randomUUID()}`;
  await mkdir(candidateDirectory);
  try {
    await writeFile(
      path.join(candidateDirectory, 'owner.json'),
      `${JSON.stringify(metadata)}\n`,
      'utf8',
    );
    await rename(candidateDirectory, lockDirectory);
  } catch (error) {
    await rm(candidateDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function replaceLockMetadata(lockDirectory, metadata) {
  const candidateFile = path.join(lockDirectory, `owner-${metadata.token}.json`);
  await writeFile(candidateFile, `${JSON.stringify(metadata)}\n`, 'utf8');
  await rename(candidateFile, path.join(lockDirectory, 'owner.json'));
}

export async function acquireTestLock(mode, options = {}) {
  if (process.env['PHOENIX_TEST_LOCK'] === 'off') {
    return { release: async () => {}, setChildPid: async () => {} };
  }

  const lockDirectory = options.lockDirectory ?? resolveLockDirectory();
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const token = randomUUID();
  const metadata = { pid: process.pid, mode, startedAt: Date.now(), token };
  let announcedWait = false;
  let lastWaitMessageAt = 0;

  for (;;) {
    try {
      await publishLock(lockDirectory, metadata);
      return {
        setChildPid: async (childPid) => {
          metadata.childPid = childPid;
          const currentOwner = await readLockMetadata(lockDirectory);
          if (currentOwner?.token === token) await replaceLockMetadata(lockDirectory, metadata);
        },
        release: async () => {
          const currentOwner = await readLockMetadata(lockDirectory);
          if (currentOwner?.token === token) {
            await rm(lockDirectory, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;

      const owner = await readLockMetadata(lockDirectory);
      let state = lockOwnerState(owner);
      if (state === 'unknown') {
        // Published lock directories always contain metadata. A grace period
        // avoids reclaiming malformed locks while another process inspects them.
        const lockStat = await stat(lockDirectory).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > 5_000) state = 'stale';
      }
      if (state === 'stale') {
        await reclaimStaleLock(lockDirectory);
        continue;
      }

      const now = Date.now();
      if (!announcedWait || now - lastWaitMessageAt >= 30_000) {
        const ownerDescription = owner?.pid
          ? `PID ${owner.pid} (${owner.mode ?? 'test'})`
          : 'another test run';
        console.log(`[phoenix:test] Waiting for ${ownerDescription} to finish…`);
        announcedWait = true;
        lastWaitMessageAt = now;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

async function run() {
  const nodeError = unsupportedNodeMessage();
  if (nodeError && process.env['PHOENIX_ALLOW_UNSUPPORTED_NODE'] !== '1') {
    throw new Error(nodeError);
  }

  const invocation = buildVitestInvocation(process.argv.slice(2));
  const mode = process.argv[2] ?? 'full';
  const lock = invocation.lock
    ? await acquireTestLock(mode)
    : { release: async () => {}, setChildPid: async () => {} };
  const startedAt = Date.now();

  try {
    const childEnvironment = { ...process.env };
    delete childEnvironment['PHOENIX_TEST_PROJECTS'];
    const projectFilter = projectFilterForMode(mode, process.argv.slice(3));
    if (projectFilter) childEnvironment['PHOENIX_TEST_PROJECTS'] = projectFilter;

    const child = spawn(
      process.execPath,
      [
        vitestEntry,
        invocation.command,
        '--config',
        path.join(repoRoot, 'vitest.config.ts'),
        ...invocation.arguments,
      ],
      {
        cwd: repoRoot,
        env: childEnvironment,
        stdio: 'inherit',
      },
    );
    await lock.setChildPid(child.pid);

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        child.kill(signal);
      });
    }

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve(code ?? (signal ? 1 : 0));
      });
    });
    const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
    console.log(`[phoenix:test] Finished in ${elapsedSeconds}s`);
    process.exitCode = exitCode;
  } finally {
    await lock.release();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    await run();
  } catch (error) {
    console.error(`[phoenix:test] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
