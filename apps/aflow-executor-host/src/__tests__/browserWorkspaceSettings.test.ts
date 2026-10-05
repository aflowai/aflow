/**
 * A profile's settings changed from the machine page: the request is applied
 * by the command's own writer over a temporary policy file, answered with the
 * profile as it now is or with the writer's refusal, and nothing else in this
 * executor reaches that writer — no step handler, so no operation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HostBrowserRequest, HostBrowserSetting } from '@aflow/redis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadHostPolicy } from '../bindings.js';
import { answerBrowserSetting } from '../browser/workspaceSettings.js';
import { CHROME } from './fixtures/fakeBrowser.js';

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
    );
    expect(posture).toMatchObject({
      kind: 'changed',
      profile: { id: 'work', posture: 'ask-to-act' },
    });

    await answerBrowserSetting(
      asked('work', { kind: 'unattended', choice: 'refuse' }),
      policyPath,
      () => CHROME,
    );
    const rule = await answerBrowserSetting(
      asked('work', { kind: 'rule', origin: 'https://mail.example.com', effect: 'deny' }),
      policyPath,
      () => CHROME,
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
    );
    expect(removed).toMatchObject({ kind: 'changed', profile: { rules: [] } });
  });

  it('is refused in the writer’s own words, leaving the file as it was', async () => {
    const before = await readFile(policyPath, 'utf8');
    for (const [profileId, setting, said] of [
      ['default', { kind: 'rule', origin: 'mail.example.com', effect: 'deny' }, '*.example.com'],
      ['nope', { kind: 'posture', posture: 'read-only' }, 'no browser profile'],
      ['default', { kind: 'posture', posture: 'careful' }, 'is not a posture'],
    ] as const) {
      const answer = await answerBrowserSetting(
        asked(profileId, setting),
        policyPath,
        () => CHROME,
      );
      expect(answer.kind, said).toBe('refused');
      expect(answer.kind === 'refused' ? answer.message : '', said).toContain(said);
    }
    expect(await readFile(policyPath, 'utf8')).toBe(before);
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
    expect(naming('answerBrowserSetting')).toEqual(['browser/workspaceSettings.ts', 'index.ts']);
  });
});
