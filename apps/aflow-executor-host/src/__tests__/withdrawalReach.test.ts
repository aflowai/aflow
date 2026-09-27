/**
 * Three findings from the second review round: a listing that walked what the
 * resolver refuses, a cancellation that could be ignored, and a withdrawal that
 * waited for a request that was never going to come.
 */
import { execFile } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHostFileHandler } from '../handlers/fileHandlers.js';
import { watchPolicy } from '../policyWatch.js';

const run = promisify(execFile);

let base: string;
let root: string;
let policyPath: string;

interface Captured {
  output?: Record<string, unknown>;
}

function contextFor(operationId: string, input: unknown, captured: Captured): never {
  return {
    operationId,
    spaceId: 'space-test',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve(input),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data as Record<string, unknown>;
      return Promise.resolve('inline:out');
    },
  } as never;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-wr-'));
  root = join(base, 'project');
  await run('git', ['init', '-q', '--initial-branch=main', root]);
  await writeFile(join(root, 'app.ts'), 'export const x = 1;\n');
  policyPath = join(base, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: false,
          singleFile: false,
          spaceId: 'space-test',
        },
      ],
    }),
  );
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * Filesystem notifications are not synchronous and their latency moves with
 * machine load, so these wait for the condition rather than for a duration a
 * quiet machine happened to need. A fixed sleep here passes alone and fails in
 * a full run, which is worse than no test.
 */
/**
 * Vitest's per-test budget has to exceed this helper's deadline, or the two
 * disagree and the shorter one wins silently: `until` would sit inside its
 * twenty seconds while the test was killed at five, reported as a timeout with
 * nothing to say about what it was waiting for. These tests wait on filesystem
 * watch events and process signals — delivery latency the code does not control
 * and a busy machine does not hurry.
 */
const WAITS_ON_THE_OS_MS = 30_000;

/**
 * The debounce these tests give the watcher.
 *
 * It is a TRAILING debounce: every event resets the timer, so a burst collapses
 * only while consecutive events stay closer together than this. The burst below
 * is five awaited writes, and at 60ms a loaded machine put more than the window
 * between two of them — the timer fired mid-burst and a correct debounce
 * reported two firings for one logical save.
 *
 * Widened rather than asserted around: relaxing the count to "fewer than five"
 * makes the test pass with the debounce deleted entirely, which is no test at
 * all. The window has to exceed real write latency for the claim to mean
 * anything, and these cases already budget 30s of OS patience.
 */
const SETTLE_MS = 1_000;

async function until(condition: () => boolean, deadlineMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition() && Date.now() - started < deadlineMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Write until the watcher answers.
 *
 * `fs.watch` arms asynchronously. A single write immediately after
 * `watchPolicy` returns can land before the watch exists — and then nothing
 * writes again, so the wait runs to its deadline and reports a timeout as if
 * the watcher were broken. Rewriting on each poll asserts "a change fires it",
 * which is the property, rather than "the first change fires it", which was
 * never true and depends on how quickly the operating system arms a watch.
 */
async function writeUntilFired(
  write: () => Promise<void>,
  fired: () => number,
  deadlineMs = 20_000,
): Promise<void> {
  const started = Date.now();
  const before = fired();
  while (fired() === before && Date.now() - started < deadlineMs) {
    await write();
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('a listing honours what the resolver refuses', () => {
  it('does not walk into a repository .git', async () => {
    // Contents stayed unreadable, but the paths came back — and on a fresh
    // checkout they are nearly all of them: 27 git internals for one real file.
    const captured: Captured = {};
    await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.list',
        { bindingId: 'hb', path: '.', recursive: true, limit: 500 },
        captured,
      ),
    );
    const paths = (captured.output?.['entries'] as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('app.ts');
    expect(paths.filter((p) => p.split('/').includes('.git'))).toEqual([]);
  });

  it('still lists an ordinary directory whose name merely resembles it', async () => {
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    const captured: Captured = {};
    await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.list',
        { bindingId: 'hb', path: '.', recursive: true, limit: 500 },
        captured,
      ),
    );
    const paths = (captured.output?.['entries'] as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('.gitignore');
  });
});

describe('file writes still honour create-only and replace', () => {
  it('creates a new file when no revision is supplied', async () => {
    const captured: Captured = {};
    const result = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.put',
        { bindingId: 'hb', path: 'created.txt', encoding: 'utf8', content: 'new file\n' },
        captured,
      ),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output?.['created']).toBe(true);
    expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('new file\n');
  });

  it('replaces an existing file only when its revision still matches', async () => {
    const readCaptured: Captured = {};
    const readResult = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.get',
        { bindingId: 'hb', path: 'app.ts', maxBytes: 1024 },
        readCaptured,
      ),
    );
    expect(readResult.status).toBe('SUCCEEDED');

    const writeCaptured: Captured = {};
    const writeResult = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.put',
        {
          bindingId: 'hb',
          path: 'app.ts',
          encoding: 'utf8',
          content: 'x\n',
          expectedRevision: readCaptured.output?.['revision'],
        },
        writeCaptured,
      ),
    );

    expect(writeResult.status).toBe('SUCCEEDED');
    expect(writeCaptured.output?.['created']).toBe(false);
    expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe('x\n');
  });

  it('refuses a create-only write when the file already exists', async () => {
    const captured: Captured = {};
    const result = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.put',
        { bindingId: 'hb', path: 'app.ts', encoding: 'utf8', content: 'new file\n' },
        captured,
      ),
    );

    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output ?? {})).toContain('already exists');
    expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('refuses a replace when the file changed after it was read', async () => {
    const readCaptured: Captured = {};
    const readResult = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.get',
        { bindingId: 'hb', path: 'app.ts', maxBytes: 1024 },
        readCaptured,
      ),
    );
    expect(readResult.status).toBe('SUCCEEDED');

    await writeFile(join(root, 'app.ts'), 'operator change\n');

    const writeCaptured: Captured = {};
    const writeResult = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.put',
        {
          bindingId: 'hb',
          path: 'app.ts',
          encoding: 'utf8',
          content: 'x\n',
          expectedRevision: readCaptured.output?.['revision'],
        },
        writeCaptured,
      ),
    );

    expect(writeResult.status).toBe('FAILED');
    expect(JSON.stringify(writeCaptured.output ?? {})).toContain('changed since it was read');
    expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe('operator change\n');
  });

  it('refuses a write through a symlinked file target', async () => {
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'outside\n');
    await symlink(outside, join(root, 'linked.txt'));

    const captured: Captured = {};
    const result = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.put',
        { bindingId: 'hb', path: 'linked.txt', encoding: 'utf8', content: 'inside\n' },
        captured,
      ),
    );

    expect(result.status).toBe('FAILED');
    expect(await readFile(outside, 'utf8')).toBe('outside\n');
  });

  it('refuses a write through a symlinked ancestor directory', async () => {
    const outsideDir = join(base, 'outside-dir');
    await fsPromises.mkdir(outsideDir);
    await symlink(outsideDir, join(root, 'linked-dir'));

    const captured: Captured = {};
    const result = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.put',
        { bindingId: 'hb', path: 'linked-dir/new.txt', encoding: 'utf8', content: 'inside\n' },
        captured,
      ),
    );

    expect(result.status).toBe('FAILED');
    await expect(readFile(join(outsideDir, 'new.txt'), 'utf8')).rejects.toThrow();
  });

  it('fails closed if the descriptor write makes no progress', async () => {
    const readCaptured: Captured = {};
    const readResult = await createHostFileHandler(policyPath).execute(
      contextFor(
        'host.file.get',
        { bindingId: 'hb', path: 'app.ts', maxBytes: 1024 },
        readCaptured,
      ),
    );
    expect(readResult.status).toBe('SUCCEEDED');

    const probeHandle = await fsPromises.open(join(root, 'app.ts'), 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      write: (buffer: Buffer, offset: number, length: number, position: number) => Promise<unknown>;
    };
    await probeHandle.close();

    const writeSpy = vi
      .spyOn(fileHandlePrototype, 'write')
      .mockResolvedValueOnce({ bytesWritten: 0, buffer: Buffer.alloc(0) } as never);
    try {
      const writeCaptured: Captured = {};
      const writeResult = await createHostFileHandler(policyPath).execute(
        contextFor(
          'host.file.put',
          {
            bindingId: 'hb',
            path: 'app.ts',
            encoding: 'utf8',
            content: 'x\n',
            expectedRevision: readCaptured.output?.['revision'],
          },
          writeCaptured,
        ),
      );

      expect(writeResult.status).toBe('FAILED');
      expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('withdrawal does not wait to be asked', () => {
  it(
    'fires when the policy file changes',
    async () => {
      // A detached command exists so the step can end, so ordinarily nothing
      // arrives afterwards and per-operation reconciliation never runs.
      let fired = 0;
      const watcher = watchPolicy(
        policyPath,
        () => {
          fired += 1;
        },
        20,
      );
      try {
        await writeUntilFired(
          () => writeFile(policyPath, JSON.stringify({ version: 1, bindings: [] })),
          () => fired,
        );
        expect(fired).toBeGreaterThan(0);
      } finally {
        watcher.close();
      }
    },
    WAITS_ON_THE_OS_MS,
  );

  it(
    'survives an atomic save, which is how the file is actually written',
    async () => {
      // Watching the file follows its inode; a write-temp-then-rename leaves the
      // watch pointed at an inode nothing will touch again. Every editor saves
      // this way, and so does the writer in this repository — so the first real
      // save killed the watch and every withdrawal after it went unnoticed.
      let fired = 0;
      const watcher = watchPolicy(
        policyPath,
        () => {
          fired += 1;
        },
        20,
      );
      try {
        const staging = `${policyPath}.partial`;
        await writeUntilFired(
          async () => {
            await writeFile(staging, JSON.stringify({ version: 1, bindings: [] }));
            await rename(staging, policyPath);
          },
          () => fired,
        );
        expect(fired).toBeGreaterThan(0);

        // And again, because one survival could be the pre-rename watch firing.
        const before = fired;
        await writeFile(staging, JSON.stringify({ version: 1, bindings: [], n: 2 }));
        await rename(staging, policyPath);
        await until(() => fired > before);
        expect(fired).toBeGreaterThan(before);
      } finally {
        watcher.close();
      }
    },
    WAITS_ON_THE_OS_MS,
  );

  it(
    'coalesces the burst one save produces',
    async () => {
      // A rename-and-replace fires several events for one edit; reconciling four
      // times is wasted work, not four withdrawals.
      let fired = 0;
      const watcher = watchPolicy(
        policyPath,
        () => {
          fired += 1;
        },
        SETTLE_MS,
      );
      try {
        // Armed before the burst is written, or a watch that never armed would
        // read as perfect coalescing — the one result this test must not accept
        // as a pass.
        await writeUntilFired(
          () => writeFile(policyPath, JSON.stringify({ version: 1, bindings: [], n: -1 })),
          () => fired,
        );
        await new Promise((r) => setTimeout(r, SETTLE_MS * 4));
        const armed = fired;

        for (let i = 0; i < 5; i += 1) {
          await writeFile(policyPath, JSON.stringify({ version: 1, bindings: [], n: i }));
        }
        await until(() => fired > armed);
        // Then let the settle window close, so a second firing would be visible.
        await new Promise((r) => setTimeout(r, SETTLE_MS * 4));
        expect(fired).toBe(armed + 1);
      } finally {
        watcher.close();
      }
    },
    WAITS_ON_THE_OS_MS,
  );

  it(
    'stops firing once closed, and closing twice is harmless',
    async () => {
      let fired = 0;
      const watcher = watchPolicy(
        policyPath,
        () => {
          fired += 1;
        },
        20,
      );
      watcher.close();
      watcher.close();
      await writeFile(policyPath, JSON.stringify({ version: 1, bindings: [] }));
      await new Promise((r) => setTimeout(r, 200));
      expect(fired).toBe(0);
    },
    WAITS_ON_THE_OS_MS,
  );

  it(
    'survives a policy path that cannot be watched',
    () => {
      // Losing the watch is not losing the guarantee: every operation still
      // reconciles, so this reports rather than throws.
      expect(() =>
        watchPolicy(join(base, 'does-not-exist.json'), () => undefined).close(),
      ).not.toThrow();
    },
    WAITS_ON_THE_OS_MS,
  );
});

describe('taking the execution grant away is a withdrawal too', () => {
  it(
    'a folder connected for files only permits nothing to keep running',
    async () => {
      // Three of the four reconciliation sites accepted any binding that still
      // existed. Removing `--run` leaves the folder connected while revoking the
      // right to run anything in it, and a detached command kept both its
      // execution and its filesystem access until timeout.
      const { HostPolicySchema, executionPermitted } = await import('../bindings.js');
      const policy = HostPolicySchema.parse({
        version: 1,
        bindings: [
          { id: 'runs', root: '/a', mode: 'readwrite', allowsExecution: true, spaceId: 's' },
          { id: 'files_only', root: '/b', mode: 'readwrite', allowsExecution: false, spaceId: 's' },
        ],
      });
      const permitted = executionPermitted(new Map(policy.bindings.map((b) => [b.id, b])));
      expect([...permitted]).toEqual(['runs']);
    },
    WAITS_ON_THE_OS_MS,
  );

  it(
    'is the same answer everywhere it is asked',
    async () => {
      // The fourth site had it right, which is exactly how a rule drifts. A guard
      // rather than a comment: every reconciliation reads one definition.
      const { readFileSync, readdirSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const src = join(dirname(fileURLToPath(import.meta.url)), '..');
      const files = [
        join(src, 'index.ts'),
        ...readdirSync(join(src, 'handlers'))
          .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
          .map((f) => join(src, 'handlers', f)),
      ];
      const handRolled = files.filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /reapWithdrawn\(\s*new Set\(/.test(source);
      });
      expect(handRolled).toEqual([]);
    },
    WAITS_ON_THE_OS_MS,
  );
});
