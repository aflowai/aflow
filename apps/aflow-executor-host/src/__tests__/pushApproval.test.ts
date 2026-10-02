/**
 * Contract: when a publication asks before it pushes is the operator's
 * statement about the folder, held on the machine, and read back from there.
 *
 * It defaults to asking unless the publication's own review approves, it is
 * set when the folder is connected and changed later from this machine, and a
 * skill reads it through the folder's own inspect operation rather than from
 * the workspace. The policy file holds only a posture the operator chose: a
 * folder that chose none reads as the default of the day, and nothing that
 * rewrites the file writes the default in.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  HOST_PUSH_APPROVAL_DEFAULT,
  HostBindingInspectOutputSchema,
  resolveBranchPolicy,
} from '@aflow/schemas';

import { HostBindingSchema, HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { createHostHandler } from '../handlers/hostHandler.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';
import { serializePolicy, writePolicyAtomically } from '../policyFile.js';
import {
  chosenPushApproval,
  describePushApproval,
  pushApprovalOf,
  publishingFolders,
  withPushApproval,
} from '../pushApproval.js';

function policyWith(bindings: unknown[]) {
  return HostPolicySchema.parse({ version: 1, bindings });
}

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

describe('the posture a folder holds', () => {
  it("defaults to asking unless the publication's review approves", () => {
    const binding = HostBindingSchema.parse(PUSHING);
    expect(binding.branchPolicy?.pushApproval).toBeUndefined();
    expect(binding.branchPolicy && resolveBranchPolicy(binding.branchPolicy).pushApproval).toBe(
      'unless-unreviewed',
    );
    expect(HOST_PUSH_APPROVAL_DEFAULT).toBe('unless-unreviewed');
  });

  it('gives a folder whose policy names no posture the default when it is read, not when it was written', async () => {
    // A folder that never chose has none in its file, and reading the file
    // leaves it none: the default is applied where the posture is used, so
    // that folder takes whatever the default is now.
    const base = await mkdtemp(join(tmpdir(), 'push-default-'));
    const policyPath = join(base, 'host-policy.json');
    await writeFile(policyPath, JSON.stringify({ version: 1, bindings: [PUSHING] }));
    const policy = await loadHostPolicy(policyPath);
    expect(policy.bindings.get('hb_app')?.branchPolicy).toEqual({ branchPrefix: 'aflow/' });
    expect(publishingFolders(policy.bindings)).toEqual([
      { id: 'hb_app', spaceId: 'space-a', pushApproval: HOST_PUSH_APPROVAL_DEFAULT },
    ]);
  });

  it('leaves an absent posture absent when the policy is rewritten', async () => {
    // What every CLI verb does to the file: parse it, change something, write
    // it back. A folder that never chose must still never have chosen.
    const base = await mkdtemp(join(tmpdir(), 'push-rewrite-'));
    const policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({ version: 1, bindings: [PUSHING, { ...PUSHING, id: 'hb_other' }] }),
    );
    const parsed = HostPolicySchema.parse(JSON.parse(await readFile(policyPath, 'utf8')));
    await writePolicyAtomically(
      policyPath,
      serializePolicy(withPushApproval(parsed, 'hb_other', 'never')),
    );
    const written = JSON.parse(await readFile(policyPath, 'utf8')) as {
      bindings: Array<{ id: string; branchPolicy: Record<string, unknown> }>;
    };
    expect(written.bindings.map((b) => [b.id, b.branchPolicy])).toEqual([
      ['hb_app', { branchPrefix: 'aflow/' }],
      ['hb_other', { branchPrefix: 'aflow/', pushApproval: 'never' }],
    ]);
    expect(serializePolicy(HostPolicySchema.parse(JSON.parse(serializePolicy(parsed))))).toBe(
      serializePolicy(parsed),
    );
    expect(serializePolicy(parsed)).not.toContain('pushApproval');
  });

  it('keeps a posture the policy file names', () => {
    const binding = HostBindingSchema.parse({
      ...PUSHING,
      branchPolicy: {
        branchPrefix: 'aflow/',
        pushApproval: 'never',
        checksTimeoutMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
      },
    });
    expect(binding.branchPolicy?.pushApproval).toBe('never');
  });

  it('refuses a posture outside the three', () => {
    expect(
      HostBindingSchema.safeParse({
        ...PUSHING,
        branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'sometimes' },
      }).success,
    ).toBe(false);
  });

  it('holds a push to the posture the folder resolves to, and one from a folder that pushes nothing to asking', () => {
    expect(pushApprovalOf(HostBindingSchema.parse(PUSHING))).toBe(HOST_PUSH_APPROVAL_DEFAULT);
    expect(
      pushApprovalOf(
        HostBindingSchema.parse({
          ...PUSHING,
          branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'never' },
        }),
      ),
    ).toBe('never');
    expect(pushApprovalOf(HostBindingSchema.parse(FILES_ONLY))).toBe('always');
  });

  it('says what each posture does in the words the commands print', () => {
    expect(describePushApproval('always')).toBe('asks before every push');
    expect(describePushApproval('never')).toBe('pushes without asking');
    expect(describePushApproval('unless-unreviewed')).toBe(
      'reviews the commit and asks before the push unless the review approves it',
    );
  });
});

describe('connecting a folder', () => {
  it('records no posture when nothing is said, so the folder follows the default', () => {
    expect(chosenPushApproval({ branchPrefix: 'aflow/' })).toBeUndefined();
  });

  it('records the posture the command names', () => {
    expect(chosenPushApproval({ requested: 'unless-unreviewed', branchPrefix: 'aflow/' })).toBe(
      'unless-unreviewed',
    );
  });

  it('keeps the posture a reconnected folder already chose unless one is named', () => {
    expect(chosenPushApproval({ branchPrefix: 'aflow/', current: 'never' })).toBe('never');
    expect(
      chosenPushApproval({ requested: 'always', branchPrefix: 'aflow/', current: 'never' }),
    ).toBe('always');
    expect(chosenPushApproval({ branchPrefix: 'aflow/', current: undefined })).toBeUndefined();
  });

  it('records none for a folder that pushes nothing', () => {
    expect(chosenPushApproval({ branchPrefix: undefined })).toBeUndefined();
  });

  it('refuses a posture for a folder that pushes nothing', () => {
    expect(() => chosenPushApproval({ requested: 'never', branchPrefix: undefined })).toThrow(
      /pushes nothing/,
    );
  });

  it('refuses a posture that is not one of the three, naming them', () => {
    expect(() => chosenPushApproval({ requested: 'maybe', branchPrefix: 'aflow/' })).toThrow(
      'always, never, unless-unreviewed',
    );
  });
});

describe('changing it later', () => {
  it('changes only the folder named', () => {
    const before = policyWith([PUSHING, { ...PUSHING, id: 'hb_other' }]);
    const after = withPushApproval(before, 'hb_app', 'never');
    expect(after.bindings.map((b) => [b.id, b.branchPolicy?.pushApproval])).toEqual([
      ['hb_app', 'never'],
      ['hb_other', undefined],
    ]);
    expect(after.bindings[0]?.branchPolicy?.branchPrefix).toBe('aflow/');
  });

  it('refuses a folder this machine does not offer', () => {
    expect(() => withPushApproval(policyWith([PUSHING]), 'hb_missing', 'never')).toThrow(
      'offers no folder `hb_missing`',
    );
  });

  it('refuses a folder that pushes nothing', () => {
    expect(() => withPushApproval(policyWith([FILES_ONLY]), 'hb_notes', 'never')).toThrow(
      'pushes nothing',
    );
  });

  it('refuses a posture outside the three', () => {
    expect(() => withPushApproval(policyWith([PUSHING]), 'hb_app', 'later')).toThrow(
      'is not a push approval',
    );
  });
});

describe('what the machine publishes', () => {
  it('names each pushing folder with its workspace and posture, and nothing else', async () => {
    const base = await mkdtemp(join(tmpdir(), 'push-postures-'));
    const policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            ...PUSHING,
            branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'unless-unreviewed' },
          },
          FILES_ONLY,
          { ...PUSHING, id: 'hb_unowned', spaceId: undefined },
        ],
      }),
    );
    const policy = await loadHostPolicy(policyPath);
    expect(publishingFolders(policy.bindings)).toEqual([
      { id: 'hb_app', spaceId: 'space-a', pushApproval: 'unless-unreviewed' },
    ]);
  });
});

describe('host.binding.inspect', () => {
  let policyPath: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'binding-inspect-'));
    policyPath = join(base, 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          { ...PUSHING, branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'never' } },
          { ...PUSHING, id: 'hb_unchosen' },
          FILES_ONLY,
        ],
        harnesses: [
          {
            id: 'claude',
            label: 'Claude Code',
            executable: '/usr/local/bin/claude',
            model: 'opus',
            modelArgs: ['--model', '{model}'],
          },
        ],
      }),
    );
  });

  interface Captured {
    output?: unknown;
  }

  function contextFor(input: unknown, captured: Captured, spaceId = 'space-a'): never {
    return {
      operationId: 'host.binding.inspect',
      spaceId,
      runId: 'run-a',
      stepExecutionId: 'step-1',
      job: { inputRef: 'inline:x' },
      signal: new AbortController().signal,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined },
      readPayload: () => Promise.resolve(input),
      writePayload: (_kind: string, data: unknown) => {
        captured.output = data;
        return Promise.resolve('inline:out');
      },
    } as never;
  }

  it('returns the folder and its branch policy with the posture and the time its checks get, and nothing else', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath, noPushApprovals).execute(
      contextFor({ bindingId: 'hb_app' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output).toEqual({
      id: 'hb_app',
      branchPolicy: {
        branchPrefix: 'aflow/',
        pushApproval: 'never',
        checksTimeoutMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
      },
    });
  });

  it('reads a folder that never chose a posture as the default now', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath, noPushApprovals).execute(
      contextFor({ bindingId: 'hb_unchosen' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(captured.output).toEqual({
      id: 'hb_unchosen',
      branchPolicy: {
        branchPrefix: 'aflow/',
        pushApproval: HOST_PUSH_APPROVAL_DEFAULT,
        checksTimeoutMs: HOST_CHECKS_TIMEOUT_DEFAULT_MS,
      },
    });
  });

  it('answers for a folder that runs nothing, and says it pushes nothing', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath, noPushApprovals).execute(
      contextFor({ bindingId: 'hb_notes' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(HostBindingInspectOutputSchema.parse(captured.output).branchPolicy).toBeUndefined();
  });

  it('refuses another workspace naming the folder', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath, noPushApprovals).execute(
      contextFor({ bindingId: 'hb_app' }, captured, 'space-b'),
    );
    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output)).toContain('was not connected for this workspace');
  });

  it('refuses a folder the machine does not offer', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath, noPushApprovals).execute(
      contextFor({ bindingId: 'hb_missing' }, captured),
    );
    expect(result.status).toBe('FAILED');
  });
});
