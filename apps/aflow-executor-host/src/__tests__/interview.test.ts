/**
 * The interview exists so a folder can be connected without knowing what a
 * binding is. These cover the two answers it must never get wrong: what it
 * assumes when nobody is there to ask, and which directories it offers.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPrompter, toolDirectoriesOnPath } from '../interview.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(homedir(), '.aflow-interview-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('what it assumes when there is nobody to ask', () => {
  it('takes the fallback rather than blocking on a prompt nobody will see', async () => {
    // A command in a script must behave. Waiting forever on a question written
    // to a pipe is the failure mode this replaces.
    const prompter = createPrompter();
    expect(await prompter.confirm('anything?', false)).toBe(false);
    expect(await prompter.confirm('anything?', true)).toBe(true);
    expect(await prompter.ask('which?', 'the-default')).toBe('the-default');
    prompter.close();
  });
});

describe('whether there is anyone to answer', () => {
  it('says so, so a caller can refuse rather than assume', () => {
    // `connect` needs this. Run through `yarn workspace`, the working directory
    // is the executor's own package — so a default-to-cwd with nobody to correct
    // it would offer this source tree as the folder, with whatever grants the
    // flags asked for. Knowing there is no terminal is what lets it stop.
    const prompter = createPrompter();
    expect(prompter.interactive).toBe(
      process.stdin.isTTY === true && process.stdout.isTTY === true,
    );
    prompter.close();
  });
});

describe('which directories it offers', () => {
  it('offers a directory under home that holds a runnable tool', async () => {
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    const tool = join(bin, 'mytool');
    await writeFile(tool, '#!/bin/sh\necho hi\n');
    await chmod(tool, 0o755);

    const found = await toolDirectoriesOnPath({ PATH: bin });
    expect(found).toEqual([{ directory: bin, name: 'mytool', count: 1 }]);
  });

  it('counts what a folder holds, naming the first', async () => {
    const bin = join(dir, 'many');
    await mkdir(bin, { recursive: true });
    for (const name of ['cargo', 'rustc', 'rustup']) {
      const tool = join(bin, name);
      await writeFile(tool, '#!/bin/sh\n');
      await chmod(tool, 0o755);
    }
    expect(await toolDirectoriesOnPath({ PATH: bin })).toEqual([
      { directory: bin, name: 'cargo', count: 3 },
    ]);
  });

  it("skips a project's own node_modules/.bin, which a package manager put on PATH for one command", async () => {
    const bin = join(dir, 'project', 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    const tool = join(bin, 'acorn');
    await writeFile(tool, '#!/bin/sh\n');
    await chmod(tool, 0o755);
    expect(await toolDirectoriesOnPath({ PATH: bin })).toEqual([]);
  });

  it('skips a tool folder inside the folder being connected, which that folder already reaches', async () => {
    const root = join(dir, 'connected');
    const bin = join(root, 'tools');
    await mkdir(bin, { recursive: true });
    const tool = join(bin, 'run');
    await writeFile(tool, '#!/bin/sh\n');
    await chmod(tool, 0o755);
    expect(await toolDirectoriesOnPath({ PATH: bin }, { within: root })).toEqual([]);
    expect(await toolDirectoriesOnPath({ PATH: bin })).toHaveLength(1);
  });

  it('says nothing about directories outside home, which are already reachable', async () => {
    // Offering these would be a question whose answer changes nothing — home is
    // the region that is denied, and only what it catches needs asking about.
    const found = await toolDirectoriesOnPath({ PATH: '/usr/bin:/bin' });
    expect(found).toEqual([]);
  });

  it('skips a directory with nothing runnable in it', async () => {
    const empty = join(dir, 'empty');
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, 'notes.txt'), 'not a program');
    expect(await toolDirectoriesOnPath({ PATH: empty })).toEqual([]);
  });

  it('survives a PATH entry that does not exist', async () => {
    expect(await toolDirectoriesOnPath({ PATH: join(dir, 'nope') })).toEqual([]);
  });

  it('reports each directory once, however often PATH names it', async () => {
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    const tool = join(bin, 'atool');
    await writeFile(tool, '#!/bin/sh\n');
    await chmod(tool, 0o755);
    expect(await toolDirectoriesOnPath({ PATH: `${bin}:${bin}` })).toHaveLength(1);
  });
});
