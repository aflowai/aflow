/**
 * Contract: a path from a job never lands outside its binding.
 *
 * The OS boundary refuses these too, and refuses them later and with a worse
 * error. This is the earlier answer, and it is the one that still holds on a
 * host where native enforcement is unqualified.
 */
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll } from 'vitest';

import {
  HostBindingError,
  resolveWithin,
  requireDirectory,
  requireWritable,
  type HostBinding,
} from '../bindings.js';

let root: string;
let outside: string;
let binding: HostBinding;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-binding-'));
  root = join(base, 'project');
  outside = join(base, 'secrets');
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'allowed.txt'), 'in');
  await writeFile(join(outside, 'private.txt'), 'out');
  await symlink(outside, join(root, 'escape-dir'));
  await symlink(join(outside, 'private.txt'), join(root, 'escape-file'));
  // A link whose target does not exist: `realpath` resolves nothing while the
  // link itself is very much there, and a write follows it.
  await symlink(join(outside, 'not-yet.txt'), join(root, 'dangling'));
  binding = { id: 'hb_test', root, mode: 'readwrite', singleFile: false };
});

const refuses = async (path: string, mustExist: boolean): Promise<string> => {
  try {
    await resolveWithin(binding, path, mustExist);
  } catch (error) {
    if (error instanceof HostBindingError) return error.kind;
    throw error;
  }
  throw new Error(`expected \`${path}\` to be refused`);
};

describe('host binding path confinement', () => {
  it('resolves a path inside the root', async () => {
    await expect(resolveWithin(binding, 'allowed.txt', true)).resolves.toContain('allowed.txt');
  });

  it('refuses an absolute path', async () => {
    expect(await refuses('/etc/hosts', true)).toBe('outside_root');
  });

  it('refuses traversal above the root', async () => {
    expect(await refuses('../secrets/private.txt', true)).toBe('outside_root');
  });

  it('refuses a symlinked file that lands outside', async () => {
    expect(await refuses('escape-file', true)).toBe('outside_root');
  });

  it('refuses a path through a symlinked directory', async () => {
    expect(await refuses('escape-dir/private.txt', true)).toBe('outside_root');
  });

  it('refuses creating a file through a symlinked directory', async () => {
    // The parent must resolve inside, or a symlink becomes a way to place new
    // files anywhere the operator never connected.
    expect(await refuses('escape-dir/planted.txt', false)).toBe('outside_root');
  });

  it('refuses writing through a dangling symlink', async () => {
    // The escape that a directory-only test misses: `realpath` fails, so the
    // parent check is reached, the parent is the root, and the write lands
    // wherever the link points.
    expect(await refuses('dangling', false)).toBe('outside_root');
  });

  it('refuses writing through a symlink whose target exists', async () => {
    expect(await refuses('escape-file', false)).toBe('outside_root');
  });

  it('allows creating a file under directories that do not exist yet', async () => {
    // The write is entitled to create them, and the deepest existing ancestor
    // is what decides containment — the binding root here.
    await expect(resolveWithin(binding, 'reports/2026/out.md', false)).resolves.toContain(
      'reports/2026/out.md',
    );
  });

  it('allows creating a file that does not exist yet inside the root', async () => {
    await expect(resolveWithin(binding, 'src/new.txt', false)).resolves.toContain('src/new.txt');
  });

  it('refuses to list a single-file binding', () => {
    expect(() => {
      requireDirectory({ ...binding, singleFile: true });
    }).toThrow(HostBindingError);
  });

  it('resolves a single-file binding to the file itself', async () => {
    const fileBinding = {
      id: 'hb_one',
      root: join(root, 'allowed.txt'),
      mode: 'readwrite' as const,
      singleFile: true,
    };
    await expect(resolveWithin(fileBinding, '.', true)).resolves.toContain('allowed.txt');
    await expect(resolveWithin(fileBinding, 'sibling.txt', false)).rejects.toThrow(
      HostBindingError,
    );
  });

  it('refuses writes through a read-only binding', () => {
    expect(() => {
      requireWritable({ ...binding, mode: 'read' });
    }).toThrow(HostBindingError);
  });
});
