/**
 * `host.file.put` with `createParents`: a file whose directory does not exist
 * yet is written once the directory is made inside the binding, and without
 * the flag the refusal names the missing directory.
 */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHostFileHandler } from '../handlers/fileHandlers.js';

let base: string;
let root: string;
let policyPath: string;

async function writePolicy(mode: 'read' | 'readwrite') {
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [
        { id: 'hb', root, mode, allowsExecution: false, singleFile: false, spaceId: 'space-test' },
      ],
    }),
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aflow-createparents-'));
  root = join(base, 'project');
  await mkdir(root, { recursive: true });
  policyPath = join(base, 'p.json');
  await writePolicy('readwrite');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(input: Record<string, unknown>) {
  const captured: { output?: unknown } = {};
  const result = await createHostFileHandler(policyPath).execute({
    operationId: 'host.file.put',
    spaceId: 'space-test',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve({ bindingId: 'hb', content: '# Goals\n', ...input }),
    emitLiveDelta: () => Promise.resolve(),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data;
      return Promise.resolve('inline:out');
    },
  } as never);
  return { status: result.status, output: captured.output as Record<string, unknown> };
}

describe('host.file.put — createParents', () => {
  it('creates the missing directory and writes the file into it', async () => {
    const written = await put({ path: 'strategy/goals.md', createParents: true });
    expect(written.status).toBe('SUCCEEDED');
    expect(written.output).toMatchObject({ path: 'strategy/goals.md', created: true });
    expect(await readFile(join(root, 'strategy', 'goals.md'), 'utf8')).toBe('# Goals\n');
    // Every missing level is made, one directory at a time.
    expect((await put({ path: 'a/b/c/goals.md', createParents: true })).status).toBe('SUCCEEDED');
    expect(await readFile(join(root, 'a', 'b', 'c', 'goals.md'), 'utf8')).toBe('# Goals\n');
    // A directory already there is used as it is.
    expect((await put({ path: 'strategy/principles.md', createParents: true })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('without it, refuses a missing directory and names it', async () => {
    const refused = await put({ path: 'strategy/goals.md' });
    expect(refused.status).toBe('FAILED');
    expect(JSON.stringify(refused.output)).toContain('`strategy`');
    expect(JSON.stringify(refused.output)).toContain('createParents');
  });

  it('names a file that stands where the directory must be', async () => {
    await writeFile(join(root, 'strategy'), 'not a directory');
    const refused = await put({ path: 'strategy/goals.md', createParents: true });
    expect(refused.status).toBe('FAILED');
    expect(JSON.stringify(refused.output)).toContain('A file stands where a directory');
  });

  it('creates nothing outside the binding, and nothing in a read-only one', async () => {
    await symlink(base, join(root, 'out'));
    expect((await put({ path: 'out/escape/goals.md', createParents: true })).status).toBe('FAILED');
    // Not even an empty directory is made where the link leads.
    await expect(stat(join(base, 'escape'))).rejects.toThrow();
    expect((await put({ path: '../escape/goals.md', createParents: true })).status).toBe('FAILED');
    await writePolicy('read');
    expect((await put({ path: 'strategy/goals.md', createParents: true })).status).toBe('FAILED');
    await expect(readFile(join(root, 'strategy', 'goals.md'))).rejects.toThrow();
  });
});
