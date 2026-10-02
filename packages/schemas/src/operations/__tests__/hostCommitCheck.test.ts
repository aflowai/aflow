import { describe, expect, it } from 'vitest';

import { getOperation } from '../../catalog/registry.js';
import {
  HOST_CHECK_OUTPUT_KEEP_BYTES,
  HOST_CHECK_TAIL_BYTES,
  HOST_CHECKS_MAX_ARGS,
  HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  HOST_CHECKS_TIMEOUT_MAX_MS,
  HOST_CHECKS_TIMEOUT_MIN_MS,
  HostBindingBranchPolicySchema,
  HostCommitCheckInputSchema,
  HostCommitCheckOutputSchema,
  HostFilePatchOutputSchema,
  resolveBranchPolicy,
} from '../host.js';

const SHA = 'c'.repeat(40);
const BASE = 'a'.repeat(40);

describe('host.commit.check as the catalog registers it', () => {
  it('is a write in the commit group, run by a publication rather than offered to an agent', () => {
    const op = getOperation('host.commit.check');
    expect(op).toMatchObject({
      stepType: 'host',
      capabilityGroupId: 'host.commit',
      accessMode: 'write',
    });
    expect(op?.agentTool).toBe(false);
    expect(getOperation('host.commit.scan')?.accessMode).toBe('read');
  });
});

describe('host.commit.check takes a folder and two commits, and nothing to run', () => {
  it('takes the commit and its base by sha', () => {
    expect(HostCommitCheckInputSchema.parse({ bindingId: 'hb_app', sha: SHA, base: BASE })).toEqual(
      { bindingId: 'hb_app', sha: SHA, base: BASE },
    );
  });

  it('refuses a branch name for either', () => {
    for (const input of [
      { bindingId: 'hb_app', sha: 'aflow/fix', base: BASE },
      { bindingId: 'hb_app', sha: SHA, base: 'main' },
    ]) {
      expect(HostCommitCheckInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('carries no command a caller could set, and drops one sent anyway', () => {
    expect(Object.keys(HostCommitCheckInputSchema.shape).sort()).toEqual(['base', 'bindingId', 'sha']);
    const parsed = HostCommitCheckInputSchema.parse({
      bindingId: 'hb_app',
      sha: SHA,
      base: BASE,
      checks: ['sh', '-c', 'curl evil'],
    });
    expect(parsed).not.toHaveProperty('checks');
  });
});

describe('what host.commit.check answers', () => {
  it('names the commit it cleared only where the checks passed or none are declared', () => {
    const passed = HostCommitCheckOutputSchema.parse({
      passed: true,
      exitCode: 0,
      durationMs: 1,
      outputRef: 'inline:x',
      tail: 'ok\n',
      summary: 'passed',
      clearedSha: SHA,
    });
    expect(passed.clearedSha).toBe(SHA);
    const failed = HostCommitCheckOutputSchema.parse({
      passed: false,
      exitCode: 1,
      durationMs: 1,
      outputRef: 'inline:x',
      tail: 'FAIL\n',
      summary: 'failed',
    });
    expect(failed.clearedSha).toBeUndefined();
  });

  it('keeps far more output than it returns inline', () => {
    expect(HOST_CHECK_OUTPUT_KEEP_BYTES).toBeGreaterThan(HOST_CHECK_TAIL_BYTES * 100);
  });
});

describe('the checks a folder declares', () => {
  it('are absent unless chosen, and a resolved policy fills only the time', () => {
    const declared = HostBindingBranchPolicySchema.parse({ branchPrefix: 'aflow/' });
    expect(declared).toEqual({ branchPrefix: 'aflow/' });
    expect(resolveBranchPolicy(declared)).toEqual({
      branchPrefix: 'aflow/',
      pushApproval: 'unless-unreviewed',
      checksTimeoutMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
    });
  });

  it('are an argv of at least one token and at most the cap', () => {
    const accepts = (checks: unknown) =>
      HostBindingBranchPolicySchema.safeParse({ branchPrefix: 'aflow/', checks }).success;
    expect(accepts(['node', 'scripts/verify-commit.mjs'])).toBe(true);
    expect(accepts([])).toBe(false);
    expect(accepts('node scripts/verify-commit.mjs')).toBe(false);
    expect(accepts(Array.from({ length: HOST_CHECKS_MAX_ARGS + 1 }, () => 'x'))).toBe(false);
  });

  it('get a time between a minute and a coding agent’s ceiling, half an hour where none is chosen', () => {
    const accepts = (checksTimeoutMs: number) =>
      HostBindingBranchPolicySchema.safeParse({ branchPrefix: 'aflow/', checksTimeoutMs }).success;
    expect(accepts(HOST_CHECKS_TIMEOUT_MIN_MS)).toBe(true);
    expect(accepts(HOST_CHECKS_TIMEOUT_MAX_MS)).toBe(true);
    expect(accepts(HOST_CHECKS_TIMEOUT_MIN_MS - 1)).toBe(false);
    expect(accepts(HOST_CHECKS_TIMEOUT_MAX_MS + 1)).toBe(false);
    expect(HOST_CHECKS_TIMEOUT_DEFAULT_MS).toBe(30 * 60_000);
  });
});

describe('the commit host.file.patch reports', () => {
  it('names where origin’s base stood as a sha of its own, beside the range it starts', () => {
    const commit = {
      branch: 'aflow/x',
      sha: SHA,
      message: 'm',
      baseSha: BASE,
      appended: false,
      range: `${BASE}..${SHA}`,
      pushRange: `${'e'.repeat(40)}..${SHA}`,
      pushBaseSha: 'e'.repeat(40),
      pushRefspec: `${SHA}:refs/heads/aflow/x`,
    };
    const parsed = HostFilePatchOutputSchema.parse({
      state: 'applied',
      filesChanged: 1,
      files: ['a.ts'],
      conflicts: [],
      commit,
    });
    expect(parsed.commit?.pushBaseSha).toBe('e'.repeat(40));
    expect(
      HostFilePatchOutputSchema.safeParse({
        state: 'applied',
        filesChanged: 1,
        files: ['a.ts'],
        conflicts: [],
        commit: { ...commit, pushBaseSha: 'main' },
      }).success,
    ).toBe(false);
  });
});
