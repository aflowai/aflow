/**
 * `host.file.get` with `ifMissing: "absent"`: a path with no file is an
 * answer, and every other failure is still a failed read, so a caller can
 * tell the two apart.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HostFileAbsentOutputSchema,
  HostFileFoundOutputSchema,
  HostFileGetOutputSchema,
} from '@aflow/schemas';

import { createHostFileHandler } from '../handlers/fileHandlers.js';

let base: string;
let root: string;
let policyPath: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-ifmissing-'));
  root = join(base, 'project');
  await mkdir(join(root, 'strategy'), { recursive: true });
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
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function read(input: Record<string, unknown>) {
  const captured: { output?: unknown } = {};
  const result = await createHostFileHandler(policyPath).execute({
    operationId: 'host.file.get',
    spaceId: 'space-test',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve({ bindingId: 'hb', ...input }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data;
      return Promise.resolve('inline:out');
    },
  } as never);
  return { status: result.status, output: captured.output as Record<string, unknown> };
}

describe('host.file.get — ifMissing', () => {
  it('answers found: false for a missing file where asked, and fails it otherwise', async () => {
    const absent = await read({ path: 'strategy/goals.md', ifMissing: 'absent' });
    expect(absent).toEqual({
      status: 'SUCCEEDED',
      output: { path: 'strategy/goals.md', found: false },
    });
    // Its parent missing too is still a missing file.
    expect((await read({ path: 'nowhere/goals.md', ifMissing: 'absent' })).output).toEqual({
      path: 'nowhere/goals.md',
      found: false,
    });
    expect((await read({ path: 'strategy/goals.md' })).status).toBe('FAILED');
  });

  it('reads a file that is there as before', async () => {
    await writeFile(join(root, 'strategy', 'goals.md'), '# Goals\n');
    const found = await read({ path: 'strategy/goals.md', ifMissing: 'absent' });
    expect(found.status).toBe('SUCCEEDED');
    expect(found.output).toMatchObject({ content: '# Goals\n', encoding: 'utf8' });
    expect(found.output).not.toHaveProperty('found');
  });

  it('declares a found read with its content and revision, and only an absent one without', async () => {
    await writeFile(join(root, 'strategy', 'goals.md'), '# Goals\n');
    const found = (await read({ path: 'strategy/goals.md', ifMissing: 'absent' })).output;
    expect(HostFileFoundOutputSchema.safeParse(found).success).toBe(true);
    const absent = (await read({ path: 'strategy/principles.md', ifMissing: 'absent' })).output;
    expect(HostFileAbsentOutputSchema.safeParse(absent).success).toBe(true);
    expect(HostFileGetOutputSchema.safeParse(absent).success).toBe(true);
    // A read that is not absent and carries no content or revision is no answer.
    expect(HostFileGetOutputSchema.safeParse({ path: 'strategy/goals.md' }).success).toBe(false);
    for (const field of ['content', 'revision']) {
      const without = Object.fromEntries(Object.entries(found).filter(([key]) => key !== field));
      expect(HostFileGetOutputSchema.safeParse(without).success, field).toBe(false);
    }
  });

  it('keeps every other failure a failed read, never a missing file', async () => {
    await mkdir(join(root, 'strategy', 'goals.md'));
    expect((await read({ path: 'strategy/goals.md', ifMissing: 'absent' })).status).toBe('FAILED');
    await symlink(join(base, 'outside.md'), join(root, 'strategy', 'principles.md'));
    expect((await read({ path: 'strategy/principles.md', ifMissing: 'absent' })).status).toBe(
      'FAILED',
    );
    expect((await read({ path: '../outside.md', ifMissing: 'absent' })).status).toBe('FAILED');
  });
});
