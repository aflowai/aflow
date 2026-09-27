import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVitestInvocation,
  lockOwnerState,
  projectFilterForMode,
  unsupportedNodeMessage,
} from './test-runner.mjs';

const runnerUrl = new URL('./test-runner.mjs', import.meta.url).href;
const temporaryDirectories = [];
const childProcesses = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryLockDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'phoenix-test-runner-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'suite.lock');
}

function spawnLockContender(lockDirectory, options = {}) {
  const holdMs = options.holdMs ?? 0;
  const childMs = options.childMs ?? 0;
  const crash = options.crash ?? false;
  const source = `
    import { spawn } from 'node:child_process';
    import { acquireTestLock } from ${JSON.stringify(runnerUrl)};
    const lock = await acquireTestLock('test', {
      lockDirectory: ${JSON.stringify(lockDirectory)},
      pollIntervalMs: 20,
    });
    console.log('ACQUIRED');
    if (${childMs} > 0) {
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(
        `setTimeout(() => {}, ${childMs})`,
      )}], { stdio: 'ignore' });
      child.unref();
      await lock.setChildPid(child.pid);
      console.log('CHILD=' + child.pid);
    }
    if (${crash ? 'true' : 'false'}) process.kill(process.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
    await lock.release();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childProcesses.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  return {
    child,
    output: () => output,
    waitFor: (text, timeoutMs = 3_000) =>
      new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
          if (output.includes(text)) {
            resolve(Date.now());
            return;
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            reject(new Error(`Contender exited before ${text}: ${output}`));
            return;
          }
          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${text}: ${output}`));
            return;
          }
          setTimeout(check, 10);
        };
        check();
      }),
  };
}

describe('buildVitestInvocation', () => {
  it('builds full, changed, focused, and listing invocations', () => {
    expect(buildVitestInvocation(['full', '--reporter=dot'])).toEqual({
      command: 'run',
      arguments: ['--reporter=dot'],
      lock: true,
    });
    expect(buildVitestInvocation(['changed', 'origin/main', '--reporter=dot'])).toEqual({
      command: 'run',
      arguments: ['--changed=origin/main', '--reporter=dot'],
      lock: false,
    });
    expect(buildVitestInvocation(['workspace', '@aflow/schemas'])).toEqual({
      command: 'run',
      arguments: ['--project=@aflow/schemas'],
      lock: false,
    });
    expect(buildVitestInvocation(['file', 'packages/schemas/src/foo.test.ts'])).toEqual({
      command: 'run',
      arguments: ['packages/schemas/src/foo.test.ts'],
      lock: false,
    });
    expect(buildVitestInvocation(['changed'])).toEqual({
      command: 'run',
      arguments: ['--changed=main'],
      lock: false,
    });
  });

  it('rejects incomplete focused commands', () => {
    expect(() => buildVitestInvocation(['workspace'])).toThrow('test:workspace');
    expect(() => buildVitestInvocation(['file'])).toThrow('test:file');
  });
});

describe('runtime guardrails', () => {
  it('accepts Node 22 and explains unsupported versions', () => {
    expect(unsupportedNodeMessage('22.22.0')).toBeUndefined();
    expect(unsupportedNodeMessage('25.0.0')).toContain('require Node 22');
  });

  it('limits focused commands to their addressed projects', () => {
    expect(projectFilterForMode('workspace', ['@aflow/schemas'])).toBe('@aflow/schemas');
    expect(projectFilterForMode('file', ['scripts/test-runner.test.mjs'])).toBe(
      'phoenix-test-infrastructure',
    );
    expect(
      projectFilterForMode('file', [
        'packages/schemas/src/__tests__/snooze.test.ts',
        'packages/platform-artifacts/src/__tests__/storeCatalog.test.ts',
      ]),
    ).toBe('@aflow/schemas,@aflow/platform-artifacts');
    expect(projectFilterForMode('changed', [])).toBeUndefined();
  });

  it('distinguishes active, dead, child-owned, and incomplete locks', () => {
    const now = Date.now();
    const active = { pid: 42, startedAt: now };
    expect(lockOwnerState(active, now, () => true)).toBe('active');
    expect(lockOwnerState(active, now, () => false)).toBe('stale');
    expect(lockOwnerState({ ...active, childPid: 43 }, now, (pid) => pid === 43)).toBe('active');
    expect(lockOwnerState(undefined, now, () => true)).toBe('unknown');
  });

  it('serializes process contenders and transfers ownership after release', async () => {
    const lockDirectory = await temporaryLockDirectory();
    const first = spawnLockContender(lockDirectory, { holdMs: 300 });
    await first.waitFor('ACQUIRED');

    const second = spawnLockContender(lockDirectory);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.output()).not.toContain('ACQUIRED');
    await second.waitFor('ACQUIRED');
  });

  it('waits for an orphaned child before reclaiming a crashed owner', async () => {
    const lockDirectory = await temporaryLockDirectory();
    const first = spawnLockContender(lockDirectory, { childMs: 400, crash: true });
    await first.waitFor('CHILD=');

    const startedAt = Date.now();
    const second = spawnLockContender(lockDirectory);
    const acquiredAt = await second.waitFor('ACQUIRED');
    expect(acquiredAt - startedAt).toBeGreaterThanOrEqual(200);
  });
});
