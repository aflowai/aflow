/**
 * A profile's settings changed from the machine page: the request is applied
 * by the command's own writer over a temporary policy file, answered with the
 * profile as it now is or with the writer's refusal, and nothing else in this
 * executor reaches that writer — no step handler, so no operation.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stackOwnPorts } from '@aflow/lib';
import type { HostBrowserRequest, HostBrowserSetting } from '@aflow/redis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadHostPolicy } from '../bindings.js';
import { changeBrowserSetting } from '../browser/browserCommands.js';
import { answerBrowserSetting, browserSettingsInTurn } from '../browser/workspaceSettings.js';
import { CHROME } from './fixtures/fakeBrowser.js';

const STACK = stackOwnPorts({});
/** A process that has ended, as a holder that crashed holding the lock has. */
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid;

let dir: string;
let policyPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aflow-browser-settings-'));
  policyPath = join(dir, 'host-policy.json');
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      bindings: [{ id: 'hb_site', root: '/Users/op/site', mode: 'read' }],
      browsers: [{ id: 'default' }, { id: 'work', spaces: ['space-1'] }],
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function asked(
  profileId: string,
  setting: HostBrowserSetting,
): Extract<HostBrowserRequest, { kind: 'setting' }> {
  return { kind: 'setting', hostname: 'laptop', profileId, answerId: 'a'.repeat(24), setting };
}

describe('a setting asked for from the machine page', () => {
  it('is written by the command’s writer and answered with the profile as it now is', async () => {
    const posture = await answerBrowserSetting(
      asked('work', { kind: 'posture', posture: 'ask-to-act' }),
      policyPath,
      () => CHROME,
      STACK,
    );
    expect(posture).toMatchObject({
      kind: 'changed',
      profile: { id: 'work', posture: 'ask-to-act' },
    });

    await answerBrowserSetting(
      asked('work', { kind: 'unattended', choice: 'refuse' }),
      policyPath,
      () => CHROME,
      STACK,
    );
    const rule = await answerBrowserSetting(
      asked('work', { kind: 'rule', origin: 'https://mail.example.com', effect: 'deny' }),
      policyPath,
      () => CHROME,
      STACK,
    );
    expect(rule).toEqual({
      kind: 'changed',
      profile: expect.objectContaining({
        id: 'work',
        spaces: ['space-1'],
        posture: 'ask-to-act',
        unattended: false,
        rules: [{ origin: 'https://mail.example.com', effect: 'deny' }],
      }) as unknown,
    });
    expect((await loadHostPolicy(policyPath, () => CHROME)).browsers.get('work')).toEqual(
      rule.kind === 'changed' ? rule.profile : undefined,
    );

    const removed = await answerBrowserSetting(
      asked('work', { kind: 'rule_remove', origin: 'https://mail.example.com' }),
      policyPath,
      () => CHROME,
      STACK,
    );
    expect(removed).toMatchObject({ kind: 'changed', profile: { rules: [] } });
  });

  it('is refused in the writer’s own words, leaving the file as it was', async () => {
    const before = await readFile(policyPath, 'utf8');
    for (const [profileId, setting, said] of [
      ['default', { kind: 'rule', origin: 'mail.example.com', effect: 'deny' }, '*.example.com'],
      ['nope', { kind: 'posture', posture: 'read-only' }, 'no browser profile'],
      ['default', { kind: 'posture', posture: 'careful' }, 'is not a posture'],
      ['work', { kind: 'local_port', port: 'localhost:5173' }, 'is not a port'],
      ['work', { kind: 'local_port_remove', port: '5173' }, 'is not opened to port 5173'],
    ] as const) {
      const answer = await answerBrowserSetting(
        asked(profileId, setting),
        policyPath,
        () => CHROME,
        STACK,
      );
      expect(answer.kind, said).toBe('refused');
      expect(answer.kind === 'refused' ? answer.message : '', said).toContain(said);
    }
    expect(await readFile(policyPath, 'utf8')).toBe(before);
  });
});

describe('a local port asked for from the machine page', () => {
  it('is opened, listed in order once, and closed again', async () => {
    for (const port of ['8000', '5173', '5173']) {
      await answerBrowserSetting(
        asked('work', { kind: 'local_port', port }),
        policyPath,
        () => CHROME,
        STACK,
      );
    }
    expect(
      (await loadHostPolicy(policyPath, () => CHROME)).browsers.get('work')?.localPorts,
    ).toEqual([5173, 8000]);
    const closed = await answerBrowserSetting(
      asked('work', { kind: 'local_port_remove', port: '8000' }),
      policyPath,
      () => CHROME,
      STACK,
    );
    expect(closed).toMatchObject({ kind: 'changed', profile: { localPorts: [5173] } });
  });

  it('is refused when this stack serves on it, saying so, and nothing is written', async () => {
    const before = await readFile(policyPath, 'utf8');
    for (const [port, whose] of [
      ['3000', 'the API, by default'],
      ['3001', 'the web application, by default'],
      ['3100', 'the MCP server, by default'],
      ['6379', 'Redis, by default'],
      ['5433', 'Postgres, by default'],
      ['8080', 'pgAdmin, by default'],
      ['8081', 'Redis Commander, by default'],
    ] as const) {
      const answer = await answerBrowserSetting(
        asked('work', { kind: 'local_port', port }),
        policyPath,
        () => CHROME,
        STACK,
      );
      expect(answer).toEqual({
        kind: 'refused',
        message:
          `Port ${port} is this stack's own — ${whose} — and a page from it could approve the ` +
          "agent's requests, so no browser profile is opened to it.",
      });
    }
    const moved = await answerBrowserSetting(
      asked('work', { kind: 'local_port', port: '4400' }),
      policyPath,
      () => CHROME,
      stackOwnPorts({ PORT: '4400' }),
    );
    expect(moved).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('as PORT sets it') as unknown,
    });
    expect(await readFile(policyPath, 'utf8')).toBe(before);
  });
});

describe('two changes made at once', () => {
  it('both survive when the machine page asks for them together', async () => {
    const inTurn = browserSettingsInTurn(policyPath, () => CHROME, STACK);
    const answers = await Promise.all([
      inTurn(asked('default', { kind: 'posture', posture: 'read-only' })),
      inTurn(asked('work', { kind: 'local_port', port: '5173' })),
      inTurn(asked('default', { kind: 'unattended', choice: 'refuse' })),
    ]);
    expect(answers.map((answer) => answer.kind)).toEqual(['changed', 'changed', 'changed']);
    const browsers = (await loadHostPolicy(policyPath, () => CHROME)).browsers;
    expect(browsers.get('default')).toMatchObject({ posture: 'read-only', unattended: false });
    expect(browsers.get('work')).toMatchObject({ localPorts: [5173] });
  });

  it('both survive when the command and the machine page change different profiles together', async () => {
    const [byCommand, byPage] = await Promise.all([
      changeBrowserSetting(
        policyPath,
        () => CHROME,
        { kind: 'posture', profileId: 'default', posture: 'ask-to-act' },
        STACK,
      ),
      answerBrowserSetting(
        asked('work', { kind: 'local_port', port: '5173' }),
        policyPath,
        () => CHROME,
        STACK,
      ),
    ]);
    expect(byCommand.profile.posture).toBe('ask-to-act');
    expect(byPage.kind).toBe('changed');
    const browsers = (await loadHostPolicy(policyPath, () => CHROME)).browsers;
    expect(browsers.get('default')?.posture).toBe('ask-to-act');
    expect(browsers.get('work')?.localPorts).toEqual([5173]);
    expect(readdirSync(dir).sort()).toEqual(['host-policy.json']);
  });

  it('go ahead past a lock its holder left behind when it ended', async () => {
    await writeFile(`${policyPath}.lock`, String(DEAD_PID));
    const answer = await answerBrowserSetting(
      asked('work', { kind: 'local_port', port: '5173' }),
      policyPath,
      () => CHROME,
      STACK,
    );
    expect(answer.kind).toBe('changed');
    expect(readdirSync(dir).sort()).toEqual(['host-policy.json']);
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

describe('the writer of a profile’s settings', () => {
  it('is reached by the machine’s command and the workspace’s request channel alone', () => {
    const naming = (word: string): string[] =>
      sources(SRC)
        .filter((file) => readFileSync(file, 'utf8').includes(word))
        .map((file) => relative(SRC, file))
        .sort();
    expect(naming('changeBrowserSetting')).toEqual([
      'browser/browserCommands.ts',
      'browser/workspaceSettings.ts',
    ]);
    expect(naming('answerBrowserSetting')).toEqual(['browser/workspaceSettings.ts']);
    expect(naming('browserSettingsInTurn')).toEqual(['browser/workspaceSettings.ts', 'index.ts']);
  });
});
