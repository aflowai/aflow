/**
 * Contract: what the plan says Phase 1 must do, asserted against the code that
 * does it rather than against a description of it.
 *
 * These are the acceptance criteria in the plan's own words — a read-only
 * binding refuses writes, a single-file binding replaces its file without
 * creating a sibling, an unpaired machine gives an actionable error rather than
 * a fake success. Each was written by hand during the phase; a test is what
 * keeps them true.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeAll } from 'vitest';

import { HostBindingError, requireWritable, resolveWithin, type HostBinding } from '../bindings.js';
import { compileSandboxPolicy } from '../sandboxPolicy.js';

let root: string;

beforeAll(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'phase1-')), 'project');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'one.txt'), 'original');
});

describe('phase 1 acceptance', () => {
  it('refuses a write through a read-only binding', () => {
    const readOnly: HostBinding = {
      id: 'hb',
      root,
      mode: 'read',
      allowsExecution: false,
      singleFile: false,
    };
    expect(() => {
      requireWritable(readOnly);
    }).toThrow(HostBindingError);
  });

  it('replaces a single-file binding without creating a sibling', async () => {
    const single: HostBinding = {
      id: 'hb_one',
      root: join(root, 'one.txt'),
      mode: 'readwrite',
      allowsExecution: false,
      singleFile: true,
    };
    // Any path resolves to the file itself, so a write cannot land beside it.
    const resolved = await resolveWithin(single, '.', true);
    expect(resolved).toContain('one.txt');
    await writeFile(resolved, 'replaced');
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('replaced');
    await expect(resolveWithin(single, 'sibling.txt', false)).rejects.toThrow(HostBindingError);
  });

  it('gives a read-only binding no writable root beyond scratch', () => {
    const policy = compileSandboxPolicy(
      {
        id: 'hb',
        root,
        mode: 'read',
        allowsExecution: true,
        singleFile: false,
        spaceId: 'space-test',
      },
      { home: '/Users/probe', scratchDir: '/tmp/scratch' },
    );
    expect(policy.filesystem.allowWrite).toEqual(['/tmp/scratch']);
    expect(policy.filesystem.denyRead).toContain('/Users/probe');
  });
});
