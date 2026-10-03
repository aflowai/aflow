/**
 * Contract: the checks a publication runs are the operator's statement about
 * the folder, held on the machine beside the push posture, written only when
 * chosen and read back from there — by the inventory, by `host.binding.inspect`
 * and by the check itself. Nothing a workspace sends can set them.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  HOST_CHECKS_TIMEOUT_MAX_MS,
  HostBindingInspectOutputSchema,
} from '@aflow/schemas';

import { HostPolicySchema, loadHostPolicy } from '../bindings.js';
import {
  checksChangeFromArgs,
  checksOf,
  describeChecks,
  keptChecks,
  withChecks,
} from '../folderChecks.js';
import { createHostHandler } from '../handlers/hostHandler.js';
import { serializePolicy, writePolicyAtomically } from '../policyFile.js';
import { publishingFolders, withPushApproval } from '../pushApproval.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';

const ARGV = ['node', 'scripts/verify-commit.mjs'];
const PRIVATE_ARGV = [
  '/Users/someone/.local/bin/verify',
  '--token=s3cr3t',
  '/Users/someone/notes/ci.env',
];

const PUSHING = {
  id: 'hb_app',
  root: '/tmp/app',
  mode: 'readwrite',
  allowsExecution: true,
  branchPolicy: { branchPrefix: 'aflow/' },
  spaceId: 'space-a',
};

const FILES_ONLY = {
  id: 'hb_notes',
  root: '/tmp/notes',
  mode: 'read',
  allowsExecution: false,
  spaceId: 'space-a',
};

function policyWith(bindings: unknown[]) {
  return HostPolicySchema.parse({ version: 1, bindings });
}

describe('harness checks — what the verb reads', () => {
  it('takes everything after `--` as the argv, as typed', () => {
    expect(checksChangeFromArgs(['--', 'node', 'scripts/verify-commit.mjs', '--fast'])).toEqual({
      kind: 'set',
      argv: ['node', 'scripts/verify-commit.mjs', '--fast'],
    });
  });

  it('takes a time in minutes beside the argv, or alone', () => {
    expect(checksChangeFromArgs(['--timeout-minutes', '45', '--', ...ARGV])).toEqual({
      kind: 'set',
      argv: ARGV,
      timeoutMs: 45 * 60_000,
    });
    expect(checksChangeFromArgs(['--timeout-minutes', '10'])).toEqual({
      kind: 'timeout',
      timeoutMs: 10 * 60_000,
    });
  });

  it('takes `--clear` alone', () => {
    expect(checksChangeFromArgs(['--clear'])).toEqual({ kind: 'clear' });
    expect(() => checksChangeFromArgs(['--clear', '--', ...ARGV])).toThrow(/takes nothing else/);
  });

  it('refuses a command with no `--` before it, an empty one, an unknown option and a time out of range', () => {
    expect(() => checksChangeFromArgs(ARGV)).toThrow(/goes after `--`/);
    expect(() => checksChangeFromArgs(['--'])).toThrow(/Nothing follows `--`/);
    expect(() => checksChangeFromArgs(['--verbose', '--', ...ARGV])).toThrow(
      /not an option of `harness checks`/,
    );
    for (const minutes of ['0', 'soon', String(HOST_CHECKS_TIMEOUT_MAX_MS / 60_000 + 1)]) {
      expect(() => checksChangeFromArgs(['--timeout-minutes', minutes, '--', ...ARGV])).toThrow(
        /a number of minutes from 1 to 120/,
      );
    }
  });
});

describe('harness checks — what the policy holds', () => {
  it('records the argv and no time when none was chosen, so the folder takes the default when read', () => {
    const updated = withChecks(policyWith([PUSHING]), 'hb_app', { kind: 'set', argv: ARGV });
    const binding = updated.bindings.find((b) => b.id === 'hb_app');
    expect(binding?.branchPolicy).toEqual({ branchPrefix: 'aflow/', checks: ARGV });
    expect(binding && checksOf(binding)).toEqual({
      argv: ARGV,
      timeoutMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
    });
  });

  it('keeps a chosen time when the argv changes, and changes the time alone', () => {
    let policy = withChecks(policyWith([PUSHING]), 'hb_app', {
      kind: 'set',
      argv: ARGV,
      timeoutMs: 600_000,
    });
    policy = withChecks(policy, 'hb_app', { kind: 'set', argv: ['make', 'check'] });
    expect(policy.bindings[0]?.branchPolicy).toMatchObject({
      checks: ['make', 'check'],
      checksTimeoutMs: 600_000,
    });
    policy = withChecks(policy, 'hb_app', { kind: 'timeout', timeoutMs: 900_000 });
    expect(policy.bindings[0]?.branchPolicy).toMatchObject({
      checks: ['make', 'check'],
      checksTimeoutMs: 900_000,
    });
  });

  it('drops both on `--clear`, and keeps the posture through every change', () => {
    let policy = withPushApproval(policyWith([PUSHING]), 'hb_app', 'never');
    policy = withChecks(policy, 'hb_app', { kind: 'set', argv: ARGV, timeoutMs: 600_000 });
    expect(policy.bindings[0]?.branchPolicy?.pushApproval).toBe('never');
    policy = withChecks(policy, 'hb_app', { kind: 'clear' });
    expect(policy.bindings[0]?.branchPolicy).toEqual({
      branchPrefix: 'aflow/',
      pushApproval: 'never',
    });
  });

  it('keeps the checks when the posture changes', () => {
    const policy = withPushApproval(
      withChecks(policyWith([PUSHING]), 'hb_app', { kind: 'set', argv: ARGV }),
      'hb_app',
      'always',
    );
    expect(policy.bindings[0]?.branchPolicy).toEqual({
      branchPrefix: 'aflow/',
      pushApproval: 'always',
      checks: ARGV,
    });
  });

  it('refuses a time for a folder that declares no checks', () => {
    expect(() =>
      withChecks(policyWith([PUSHING]), 'hb_app', { kind: 'timeout', timeoutMs: 600_000 }),
    ).toThrow(/declares no checks/);
  });

  it('refuses a folder this machine does not offer, and one that pushes nothing', () => {
    expect(() =>
      withChecks(policyWith([PUSHING]), 'hb_missing', { kind: 'set', argv: ARGV }),
    ).toThrow(/offers no folder `hb_missing`/);
    expect(() =>
      withChecks(policyWith([FILES_ONLY]), 'hb_notes', { kind: 'set', argv: ARGV }),
    ).toThrow(/pushes nothing/);
  });

  it('writes the file with only what was chosen, and reads it back the same', async () => {
    const base = await mkdtemp(join(tmpdir(), 'folder-checks-'));
    const policyPath = join(base, 'host-policy.json');
    await writePolicyAtomically(
      policyPath,
      serializePolicy(withChecks(policyWith([PUSHING]), 'hb_app', { kind: 'set', argv: ARGV })),
    );
    const written = JSON.parse(await readFile(policyPath, 'utf8')) as {
      bindings: Array<{ branchPolicy?: Record<string, unknown> }>;
    };
    expect(written.bindings[0]?.branchPolicy).toEqual({ branchPrefix: 'aflow/', checks: ARGV });
    const loaded = await loadHostPolicy(policyPath);
    expect(loaded.bindings.get('hb_app')?.branchPolicy?.checks).toEqual(ARGV);
  });

  it('keeps what a reconnected folder declared while it still pushes, and drops it with the prefix', () => {
    const current = { branchPrefix: 'aflow/', checks: ARGV, checksTimeoutMs: 600_000 };
    expect(keptChecks(current, 'aflow/')).toEqual({ checks: ARGV, checksTimeoutMs: 600_000 });
    expect(keptChecks(current, undefined)).toEqual({});
    expect(keptChecks({ branchPrefix: 'aflow/' }, 'aflow/')).toEqual({});
    expect(keptChecks(undefined, 'aflow/')).toEqual({});
  });

  it('says in one line what a publication runs, and for how long', () => {
    expect(describeChecks({ branchPrefix: 'aflow/' })).toBe('runs no checks before a push');
    expect(describeChecks({ branchPrefix: 'aflow/', checks: ARGV })).toBe(
      'runs `node scripts/verify-commit.mjs` before a push, for up to 30 min, the default',
    );
    expect(
      describeChecks({ branchPrefix: 'aflow/', checks: ARGV, checksTimeoutMs: 45 * 60_000 }),
    ).toBe('runs `node scripts/verify-commit.mjs` before a push, for up to 45 min');
  });
});

describe('the checks, as the machine publishes and shows them', () => {
  let policyPath: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'folder-checks-inspect-'));
    policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            ...PUSHING,
            branchPolicy: { branchPrefix: 'aflow/', checks: ARGV, checksTimeoutMs: 600_000 },
          },
          {
            ...PUSHING,
            id: 'hb_private',
            branchPolicy: { branchPrefix: 'aflow/', checks: PRIVATE_ARGV },
          },
          { ...PUSHING, id: 'hb_unchecked' },
          FILES_ONLY,
        ],
      }),
    );
  });

  it('puts in the inventory that each pushing folder declares checks and their program, never the arguments', async () => {
    const policy = await loadHostPolicy(policyPath);
    const folders = publishingFolders(policy.bindings);
    expect(folders).toEqual([
      {
        id: 'hb_app',
        spaceId: 'space-a',
        pushApproval: 'unless-unreviewed',
        checks: { program: 'node' },
        sandbox: 'open',
      },
      {
        id: 'hb_private',
        spaceId: 'space-a',
        pushApproval: 'unless-unreviewed',
        checks: { program: 'verify' },
        sandbox: 'open',
      },
      {
        id: 'hb_unchecked',
        spaceId: 'space-a',
        pushApproval: 'unless-unreviewed',
        sandbox: 'open',
      },
    ]);
    const published = JSON.stringify(folders);
    expect(published).not.toContain('s3cr3t');
    expect(published).not.toContain('/Users/someone');
    expect(published).not.toContain('scripts/verify-commit.mjs');
  });

  function inspectContext(bindingId: string, captured: { output?: unknown }): never {
    return {
      operationId: 'host.binding.inspect',
      spaceId: 'space-a',
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve({ bindingId }),
      writePayload: (_kind: string, data: unknown) => {
        captured.output = data;
        return Promise.resolve('inline:out');
      },
    } as never;
  }

  it('shows the checks and the time they get through host.binding.inspect', async () => {
    const captured: { output?: unknown } = {};
    const result = await createHostHandler(policyPath, noPushApprovals).execute(
      inspectContext('hb_app', captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(HostBindingInspectOutputSchema.parse(captured.output).branchPolicy).toEqual({
      branchPrefix: 'aflow/',
      pushApproval: 'unless-unreviewed',
      checks: ARGV,
      checksTimeoutMs: 600_000,
    });
  });

  it('shows no checks, and the default time, for a folder that declares none', async () => {
    const captured: { output?: unknown } = {};
    await createHostHandler(policyPath, noPushApprovals).execute(
      inspectContext('hb_unchecked', captured),
    );
    const branchPolicy = HostBindingInspectOutputSchema.parse(captured.output).branchPolicy;
    expect(branchPolicy?.checks).toBeUndefined();
    expect(branchPolicy?.checksTimeoutMs).toBe(HOST_CHECKS_TIMEOUT_DEFAULT_MS);
  });
});
