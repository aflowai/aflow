/**
 * Contract: the loopback ports a harness's ephemeral browser may load are
 * declared on the machine, default to none, and one of this stack's own is
 * refused at declaration, as a profile's is (Plan 320 D12, D19, F47).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { harnessStackPortRefusal, parseLocalPorts } from '../browserLocalPorts.js';
import { HarnessProfileSchema } from '../harnessProfiles.js';

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HARNESS_CLI = join(REPO_ROOT, 'apps/aflow-executor-host/src/harness-cli.ts');

describe('a harness’s browser ports', () => {
  it('are none by default, and only whole port numbers are taken', () => {
    expect(
      HarnessProfileSchema.parse({ id: 'claude', executable: 'claude' }).browserLocalPorts,
    ).toEqual([]);
    expect(parseLocalPorts(['5173', '8080'])).toEqual({ ok: true, ports: [5173, 8080] });
    for (const word of ['0', '65536', '51.73', '-1', 'localhost:5173', '']) {
      expect(parseLocalPorts([word]), word).toEqual({ ok: false, word });
    }
    expect(() =>
      HarnessProfileSchema.parse({ id: 'claude', executable: 'claude', browserLocalPorts: [0] }),
    ).toThrow();
  });

  it('refuse this stack’s ports by default, naming each, and pass any other', () => {
    const refusal = harnessStackPortRefusal('claude', [5173, 3001], {});
    expect(refusal).toBeDefined();
    expect(refusal?.split('\n')).toHaveLength(1);
    expect(refusal).toContain(
      "Port 3001 is this stack's own — the web application, by default — and a page from it " +
        "could approve the agent's requests, so `claude`'s browser is not given it",
    );
    expect(refusal).toContain('preview: true');
    expect(refusal).not.toContain('5173');
    expect(harnessStackPortRefusal('claude', [3000], {})).toContain('the API, by default');
    expect(harnessStackPortRefusal('claude', [8080], {})).toContain('pgAdmin, by default');
    expect(harnessStackPortRefusal('claude', [5173, 8000], {})).toBeUndefined();
  });

  it('refuse the API port the environment names for this stack', () => {
    const env = { AFLOW_API_URL: 'http://127.0.0.1:4100' };
    expect(harnessStackPortRefusal('claude', [4100], env)).toContain('as AFLOW_API_URL sets it');
    expect(harnessStackPortRefusal('claude', [4100], {})).toBeUndefined();
  });
});

describe('aflow harness browser-ports', () => {
  let dir: string;
  let path: string;
  const POLICY = {
    version: 1,
    bindings: [],
    harnesses: [{ id: 'claude', executable: '/bin/true', browserLocalPorts: [5173] }],
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'harness-browser-ports-'));
    path = join(dir, 'host-policy.json');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function browserPorts(
    ...ports: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        [
          '--conditions=ts-source',
          '--import',
          'tsx',
          HARNESS_CLI,
          'browser-ports',
          'claude',
          ...ports,
        ],
        { cwd: REPO_ROOT, env: { ...process.env, PHOENIX_HOST_POLICY_PATH: path } },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  const declared = async (): Promise<number[]> =>
    (JSON.parse(await readFile(path, 'utf8')) as typeof POLICY).harnesses[0]?.browserLocalPorts ??
    [];

  it('refuses this stack’s own port and writes nothing', async () => {
    await writeFile(path, JSON.stringify(POLICY));
    const ran = await browserPorts('8000', '3001');
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain("Port 3001 is this stack's own");
    expect(ran.stderr).toContain('nothing was changed');
    expect(await declared()).toEqual([5173]);
  }, 60_000);

  it('declares any other port', async () => {
    await writeFile(path, JSON.stringify(POLICY));
    const ran = await browserPorts('8000');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('now loads ports 5173, 8000');
    expect(await declared()).toEqual([5173, 8000]);
  }, 60_000);
});
