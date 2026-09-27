/**
 * The gap between the check and the use.
 *
 * `resolveWithin` already refuses a path that is a symlink out of the binding
 * *when it looks*. What it cannot speak for is the moment afterwards: the
 * handler still has to open the path it was given, and anything able to write
 * inside the binding — a command from a previous step, the operator's own
 * editor — can replace that name with a link in between.
 *
 * Tests that plant the link beforehand are answered by the existing `realpath`
 * check and would pass with or without the flags below, which is what made this
 * worth a file of its own: the swap happens *after* the check returns, which is
 * the only arrangement that exercises the open.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actual = await vi.importActual<typeof import('../bindings.js')>('../bindings.js');

/** Set by each test: what to do in the instant after the check succeeds. */
let swap: (resolved: string) => Promise<void> = async () => undefined;

vi.mock('../bindings.js', async () => {
  const real = await vi.importActual<typeof import('../bindings.js')>('../bindings.js');
  return {
    ...real,
    resolveWithin: async (...args: Parameters<typeof real.resolveWithin>) => {
      const resolved = await real.resolveWithin(...args);
      await swap(resolved);
      return resolved;
    },
  };
});

let base: string;
let root: string;
let outside: string;
let policyPath: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-window-'));
  root = join(base, 'project');
  outside = join(base, 'outside.txt');
  await mkdir(root, { recursive: true });
  await writeFile(outside, 'ORIGINAL OUTSIDE THE BINDING');
  policyPath = join(base, 'p.json');
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
  swap = async () => undefined;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function context(
  operationId: string,
  input: Record<string, unknown>,
  captured: { output?: unknown },
) {
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
      captured.output = data;
      return Promise.resolve('inline:out');
    },
  } as never;
}

describe('a path swapped for a link after it was checked', () => {
  it('is not read through', async () => {
    await writeFile(join(root, 'innocent.txt'), 'inside');
    swap = async (resolved) => {
      await unlink(resolved);
      await symlink(outside, resolved);
    };

    const captured: { output?: unknown } = {};
    const { createHostFileHandler } = await import('../handlers/fileHandlers.js');
    const result = await createHostFileHandler(policyPath).execute(
      context('host.file.get', { bindingId: 'hb', path: 'innocent.txt' }, captured),
    );

    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output ?? {})).not.toContain('ORIGINAL OUTSIDE');
  });

  it('is not written through', async () => {
    // A replace, not a create: the write path refuses an existing file outright
    // unless the caller passes the revision it read, so only this arrangement
    // reaches the open at all. The link's target is given the same contents so
    // the revision still matches and nothing earlier declines the write.
    await writeFile(join(root, 'innocent.txt'), 'inside');
    await writeFile(outside, 'inside');

    const read: { output?: unknown } = {};
    const { createHostFileHandler } = await import('../handlers/fileHandlers.js');
    const handler = createHostFileHandler(policyPath);
    await handler.execute(
      context('host.file.get', { bindingId: 'hb', path: 'innocent.txt' }, read),
    );
    const revision = (read.output as { revision?: string }).revision;
    expect(revision).toBeDefined();

    swap = async (resolved) => {
      await unlink(resolved);
      await symlink(outside, resolved);
    };

    const captured: { output?: unknown } = {};
    const result = await handler.execute(
      context(
        'host.file.put',
        {
          bindingId: 'hb',
          path: 'innocent.txt',
          content: 'OVERWRITTEN',
          encoding: 'utf8',
          expectedRevision: revision,
        },
        captured,
      ),
    );

    expect(result.status).toBe('FAILED');
    expect(await readFile(outside, 'utf8')).toBe('inside');
  });

  it('still writes an ordinary file, so the refusal is the link and not the flag', async () => {
    const captured: { output?: unknown } = {};
    const { createHostFileHandler } = await import('../handlers/fileHandlers.js');
    const result = await createHostFileHandler(policyPath).execute(
      context(
        'host.file.put',
        { bindingId: 'hb', path: 'ordinary.txt', content: 'written', encoding: 'utf8' },
        captured,
      ),
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(await readFile(join(root, 'ordinary.txt'), 'utf8')).toBe('written');
    expect(actual.HostBindingError).toBeDefined();
  });
});
