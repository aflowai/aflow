import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPairedEnv } from '../pairedEnv.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-paired-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the credential pairing wrote', () => {
  it('is read, quotes and all, as `pair` writes it', async () => {
    await writeFile(join(dir, 'host.env'), "REDIS_URL='redis://hostexec:pw@127.0.0.1:6379'\n");
    const env: NodeJS.ProcessEnv = {};
    expect(loadPairedEnv(dir, env).applied).toEqual(['REDIS_URL']);
    expect(env['REDIS_URL']).toBe('redis://hostexec:pw@127.0.0.1:6379');
  });

  it('names a paired value the environment shadowed, rather than skipping it quietly', async () => {
    // Pointed at another instance's Redis the executor starts cleanly, claims
    // nothing, and looks from the appliance exactly like a lane that is down.
    // A root `.env` loaded alongside it is enough to cause that, which is why
    // the root script for this executor deliberately loads none.
    await writeFile(join(dir, 'host.env'), "REDIS_URL='redis://127.0.0.1:6380'\n");
    const env: NodeJS.ProcessEnv = { REDIS_URL: 'redis://127.0.0.1:6379' };
    const result = loadPairedEnv(dir, env);
    expect(result.applied).toEqual([]);
    expect(result.shadowed).toEqual(['REDIS_URL']);
    expect(env['REDIS_URL']).toBe('redis://127.0.0.1:6379');
  });

  it('does not override what the operator already set', async () => {
    // Running against something other than what was paired with is a choice
    // they are allowed to make, and the file should not silently undo it.
    await writeFile(join(dir, 'host.env'), "REDIS_URL='redis://from-file'\n");
    const env: NodeJS.ProcessEnv = { REDIS_URL: 'redis://from-operator' };
    expect(loadPairedEnv(dir, env).applied).toEqual([]);
    expect(env['REDIS_URL']).toBe('redis://from-operator');
  });

  it('treats an empty value as unset, so a blank var does not win', async () => {
    await writeFile(join(dir, 'host.env'), 'REDIS_URL=redis://from-file\n');
    const env: NodeJS.ProcessEnv = { REDIS_URL: '' };
    loadPairedEnv(dir, env);
    expect(env['REDIS_URL']).toBe('redis://from-file');
  });

  it('reports nothing when the machine is not paired', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadPairedEnv(dir, env).applied).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });

  it('ignores comments and blank lines rather than failing on them', async () => {
    await writeFile(join(dir, 'host.env'), '# written by pair\n\nREDIS_URL=redis://x\n');
    const env: NodeJS.ProcessEnv = {};
    expect(loadPairedEnv(dir, env).applied).toEqual(['REDIS_URL']);
  });

  it('names what it set without carrying the value', async () => {
    // The return feeds a startup log line; a credential must not ride along.
    await writeFile(join(dir, 'host.env'), "REDIS_URL='redis://hostexec:secret@h'\n");
    // Asserted across the whole result rather than one field: both halves reach
    // a log line, and a credential must not ride along in either.
    expect(JSON.stringify(loadPairedEnv(dir, {}))).not.toContain('secret');
  });
});
