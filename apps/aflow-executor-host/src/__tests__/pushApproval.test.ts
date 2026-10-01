/**
 * Contract: when a publication asks before it pushes is the operator's
 * statement about the folder, held on the machine, and read back from there.
 *
 * It defaults to asking unless a review approved the commit, it is set when the
 * folder is connected and changed later from this machine, and a skill reads it
 * through the folder's own inspect operation rather than from the workspace.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { HostBindingInspectOutputSchema } from '@aflow/schemas';

import { HostBindingSchema, HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { createHostHandler } from '../handlers/hostHandler.js';
import {
  describePushApproval,
  pushPostures,
  resolvePushApproval,
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
  it('defaults to asking unless the commit was reviewed', () => {
    const binding = HostBindingSchema.parse(PUSHING);
    expect(binding.branchPolicy?.pushApproval).toBe('unless-unreviewed');
  });

  it('keeps a posture the policy file names', () => {
    const binding = HostBindingSchema.parse({
      ...PUSHING,
      branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'never' },
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

  it('says what each posture does in the words the commands print', () => {
    expect(describePushApproval('always')).toBe('asks before every push');
    expect(describePushApproval('never')).toBe('pushes without asking');
    expect(describePushApproval('unless-unreviewed')).toContain('Local Code Review');
  });
});

describe('connecting a folder', () => {
  it('takes the default without asking when nothing is said', () => {
    expect(resolvePushApproval({ branchPrefix: 'aflow/' })).toBe('unless-unreviewed');
  });

  it('takes the posture the command names', () => {
    expect(resolvePushApproval({ requested: 'always', branchPrefix: 'aflow/' })).toBe('always');
  });

  it('keeps the posture a reconnected folder already holds unless one is named', () => {
    expect(resolvePushApproval({ branchPrefix: 'aflow/', current: 'never' })).toBe('never');
    expect(
      resolvePushApproval({ requested: 'always', branchPrefix: 'aflow/', current: 'never' }),
    ).toBe('always');
  });

  it('records none for a folder that pushes nothing', () => {
    expect(resolvePushApproval({ branchPrefix: undefined })).toBeUndefined();
  });

  it('refuses a posture for a folder that pushes nothing', () => {
    expect(() => resolvePushApproval({ requested: 'never', branchPrefix: undefined })).toThrow(
      /pushes nothing/,
    );
  });

  it('refuses a posture that is not one of the three, naming them', () => {
    expect(() => resolvePushApproval({ requested: 'maybe', branchPrefix: 'aflow/' })).toThrow(
      'always, never, unless-unreviewed',
    );
  });
});

describe('changing it later', () => {
  it('changes only the folder named', () => {
    const before = policyWith([PUSHING, { ...PUSHING, id: 'hb_other' }]);
    const after = withPushApproval(before, 'hb_app', 'always');
    expect(after.bindings.map((b) => [b.id, b.branchPolicy?.pushApproval])).toEqual([
      ['hb_app', 'always'],
      ['hb_other', 'unless-unreviewed'],
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
          { ...PUSHING, branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'always' } },
          FILES_ONLY,
          { ...PUSHING, id: 'hb_unowned', spaceId: undefined },
        ],
      }),
    );
    const policy = await loadHostPolicy(policyPath);
    expect(pushPostures(policy.bindings)).toEqual([
      { id: 'hb_app', spaceId: 'space-a', pushApproval: 'always' },
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

  it('returns the folder, its branch policy with the posture, and the harnesses', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath).execute(
      contextFor({ bindingId: 'hb_app' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    const output = HostBindingInspectOutputSchema.parse(captured.output);
    expect(output).toEqual({
      id: 'hb_app',
      root: '/tmp/app',
      mode: 'readwrite',
      allowsExecution: true,
      branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'never' },
      harnesses: [{ id: 'claude', label: 'Claude Code', model: 'opus' }],
    });
    // What an id runs is the machine's business.
    expect(JSON.stringify(captured.output)).not.toContain('/usr/local/bin/claude');
  });

  it('answers for a folder that runs nothing, and says it pushes nothing', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath).execute(
      contextFor({ bindingId: 'hb_notes' }, captured),
    );
    expect(result.status).toBe('SUCCEEDED');
    expect(HostBindingInspectOutputSchema.parse(captured.output).branchPolicy).toBeUndefined();
  });

  it('refuses another workspace naming the folder', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath).execute(
      contextFor({ bindingId: 'hb_app' }, captured, 'space-b'),
    );
    expect(result.status).toBe('FAILED');
    expect(JSON.stringify(captured.output)).toContain('was not connected for this workspace');
  });

  it('refuses a folder the machine does not offer', async () => {
    const captured: Captured = {};
    const result = await createHostHandler(policyPath).execute(
      contextFor({ bindingId: 'hb_missing' }, captured),
    );
    expect(result.status).toBe('FAILED');
  });
});
