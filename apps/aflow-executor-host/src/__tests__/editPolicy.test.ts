/**
 * The policy file is read, changed and written only through `editPolicy`,
 * which holds its lock throughout: changes of different kinds made at once
 * all survive, and waiters on a lock its holder left behind enter one at a
 * time.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stackOwnPorts } from '@aflow/lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { changeBrowserSetting } from '../browser/browserCommands.js';
import { withHarnessConcurrency } from '../harnessConcurrency.js';
import { withKeepAwake } from '../keepAwake.js';
import { editPolicy } from '../policyFile.js';
import { CHROME } from './fixtures/fakeBrowser.js';

/** A process that has ended, as a holder that crashed holding the lock has. */
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid;

let dir: string;
let policyPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-edit-policy-'));
  policyPath = join(dir, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [{ id: 'hb_site', root: '/Users/op/site', mode: 'read' }],
      browsers: [{ id: 'default' }, { id: 'work' }],
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A harness setting, changed as `aflow harness` changes it. */
async function harnessSetting(
  change: (policy: ReturnType<typeof HostPolicySchema.parse>) => object,
): Promise<object> {
  return await editPolicy(policyPath, (current) => change(HostPolicySchema.parse(current)));
}

describe('changes of different kinds made at once', () => {
  it('all survive: browser settings beside harness settings', async () => {
    await Promise.all([
      changeBrowserSetting(
        policyPath,
        () => CHROME,
        { kind: 'posture', profileId: 'default', posture: 'read-only' },
        stackOwnPorts({}),
      ),
      harnessSetting((policy) => withHarnessConcurrency(policy, '3')),
      changeBrowserSetting(
        policyPath,
        () => CHROME,
        { kind: 'local_port', profileId: 'work', port: '5173' },
        stackOwnPorts({}),
      ),
      harnessSetting((policy) => withKeepAwake(policy, 'never')),
    ]);
    const policy = await loadHostPolicy(policyPath, () => CHROME);
    expect(policy.maxConcurrentHarnessRuns).toBe(3);
    expect(policy.keepAwake).toBe('never');
    expect(policy.browsers.get('default')?.posture).toBe('read-only');
    expect(policy.browsers.get('work')?.localPorts).toEqual([5173]);
    expect([...policy.bindings.keys()]).toEqual(['hb_site']);
    expect(await readdir(dir)).toEqual(['host-policy.json']);
  });
});

describe('a lock its holder left behind when it ended', () => {
  it('is taken over by one waiter at a time, however many find it', async () => {
    await writeFile(`${policyPath}.lock`, String(DEAD_PID));
    let inside = 0;
    let most = 0;
    let entered = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await editPolicy(policyPath, async () => {
          inside += 1;
          entered += 1;
          most = Math.max(most, inside);
          await new Promise((resolve) => setTimeout(resolve, 25));
          inside -= 1;
          return undefined;
        });
      }),
    );
    expect(entered).toBe(8);
    expect(most).toBe(1);
    expect(await readdir(dir)).toEqual(['host-policy.json']);
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(at: string): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(at, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('the policy file’s writer', () => {
  it('is editPolicy alone: nothing else calls writePolicyAtomically', () => {
    const helper = /export async function editPolicy[\s\S]*?\n}\n/;
    const naming = sources(SRC).filter((file) => {
      const outside = readFileSync(file, 'utf8')
        .replace(helper, '')
        .replace('export async function writePolicyAtomically(', '');
      return /\bwritePolicyAtomically\b/.test(outside);
    });
    expect(naming.map((file) => relative(SRC, file))).toEqual([]);
    const policyFile = readFileSync(join(SRC, 'policyFile.ts'), 'utf8');
    expect(helper.exec(policyFile)?.[0]).toContain('writePolicyAtomically(');
  });
});
