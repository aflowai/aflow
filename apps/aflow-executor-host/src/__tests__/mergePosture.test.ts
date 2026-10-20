/**
 * Contract (Plan 321 D6): whether the Local PR Shepherd merges what the loop
 * opened from a folder is the operator's statement about the folder, held on
 * the machine beside its push approval, `never` unless chosen. `when-green`
 * merges on the verdict of the review a publication runs only under the push
 * approval `unless-unreviewed`, so the commands refuse it beside any other —
 * in either order — rather than store a posture that merges nothing.
 */
import { describe, expect, it } from 'vitest';

import { HOST_MERGE_POSTURE_DEFAULT, resolveBranchPolicy } from '@aflow/schemas';

import { HostBindingSchema, HostPolicySchema } from '../bindings.js';
import { checksChangeFromArgs, withChecks } from '../folderChecks.js';
import { chosenMergePosture, describeMergePosture, withMergePosture } from '../mergePosture.js';
import { serializePolicy } from '../policyFile.js';
import { publishingFolders, withPushApproval } from '../pushApproval.js';

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

describe('the merge posture a folder holds', () => {
  it('is never unless chosen, applied when read and never written in', () => {
    expect(HOST_MERGE_POSTURE_DEFAULT).toBe('never');
    const binding = HostBindingSchema.parse(PUSHING);
    expect(binding.branchPolicy?.mergePosture).toBeUndefined();
    expect(binding.branchPolicy && resolveBranchPolicy(binding.branchPolicy).mergePosture).toBe(
      'never',
    );
    expect(serializePolicy(policyWith([PUSHING]))).not.toContain('mergePosture');
  });

  it('is published with the push approval, for the machine block and the folder list', () => {
    const policy = withMergePosture(policyWith([PUSHING]), 'hb_app', 'when-green');
    const bindings = new Map(policy.bindings.map((b) => [b.id, b]));
    expect(publishingFolders(bindings)).toMatchObject([
      { id: 'hb_app', pushApproval: 'unless-unreviewed', mergePosture: 'when-green' },
    ]);
  });

  it('says what it does, and why a posture edited by hand into the refused combination merges nothing', () => {
    expect(describeMergePosture({ pushApproval: 'unless-unreviewed', mergePosture: 'never' })).toBe(
      'leaves the merge to you',
    );
    expect(
      describeMergePosture({ pushApproval: 'unless-unreviewed', mergePosture: 'when-green' }),
    ).toMatch(/by squash and on your approval/);
    expect(describeMergePosture({ pushApproval: 'always', mergePosture: 'when-green' })).toMatch(
      /^merges nothing — the push approval is `always`, which runs no review/,
    );
  });
});

describe('connecting a folder', () => {
  it('records none when nothing is said, and the one named', () => {
    expect(
      chosenMergePosture({ branchPrefix: 'aflow/', pushApproval: 'unless-unreviewed' }),
    ).toBeUndefined();
    expect(
      chosenMergePosture({
        requested: 'when-green',
        branchPrefix: 'aflow/',
        pushApproval: 'unless-unreviewed',
      }),
    ).toBe('when-green');
  });

  it('keeps the posture a reconnected folder already chose unless one is named', () => {
    expect(
      chosenMergePosture({
        branchPrefix: 'aflow/',
        current: 'when-green',
        pushApproval: 'unless-unreviewed',
      }),
    ).toBe('when-green');
    expect(
      chosenMergePosture({
        requested: 'never',
        branchPrefix: 'aflow/',
        current: 'when-green',
        pushApproval: 'always',
      }),
    ).toBe('never');
  });

  it.each(['always', 'never'] as const)(
    'refuses when-green beside the push approval %s, naming the one to set first',
    (pushApproval) => {
      expect(() =>
        chosenMergePosture({ requested: 'when-green', branchPrefix: 'aflow/', pushApproval }),
      ).toThrow(/--push-approval unless-unreviewed/);
    },
  );

  it('refuses a reconnect to a push approval that runs no review while the folder merges when-green', () => {
    expect(() =>
      chosenMergePosture({ branchPrefix: 'aflow/', current: 'when-green', pushApproval: 'never' }),
    ).toThrow(/--merge-posture never/);
  });

  it('refuses a posture for a folder that pushes nothing, and one outside the two', () => {
    expect(() =>
      chosenMergePosture({
        requested: 'never',
        branchPrefix: undefined,
        pushApproval: 'unless-unreviewed',
      }),
    ).toThrow(/pushes nothing/);
    expect(() =>
      chosenMergePosture({
        requested: 'always',
        branchPrefix: 'aflow/',
        pushApproval: 'unless-unreviewed',
      }),
    ).toThrow('never, when-green');
  });
});

describe('changing it later', () => {
  it('changes only the folder named, and keeps its push approval and checks', () => {
    const before = policyWith([
      {
        ...PUSHING,
        branchPolicy: {
          branchPrefix: 'aflow/',
          pushApproval: 'unless-unreviewed',
          checks: ['yarn'],
        },
      },
      { ...PUSHING, id: 'hb_other' },
    ]);
    const after = withMergePosture(before, 'hb_app', 'when-green');
    expect(after.bindings.map((b) => [b.id, b.branchPolicy?.mergePosture])).toEqual([
      ['hb_app', 'when-green'],
      ['hb_other', undefined],
    ]);
    expect(after.bindings[0]?.branchPolicy).toMatchObject({
      pushApproval: 'unless-unreviewed',
      checks: ['yarn'],
    });
  });

  it('refuses `harness merge-posture <folder> when-green` under the push approval always', () => {
    const always = policyWith([
      { ...PUSHING, branchPolicy: { branchPrefix: 'aflow/', pushApproval: 'always' } },
    ]);
    expect(() => withMergePosture(always, 'hb_app', 'when-green')).toThrow(
      'Set it first: `aflow harness push-approval hb_app unless-unreviewed`',
    );
    expect(withMergePosture(always, 'hb_app', 'never').bindings[0]?.branchPolicy).toMatchObject({
      mergePosture: 'never',
    });
  });

  it.each(['always', 'never'])(
    'refuses `harness push-approval <folder> %s` under when-green, naming the merge posture to set first',
    (pushApproval) => {
      const merging = withMergePosture(policyWith([PUSHING]), 'hb_app', 'when-green');
      expect(() => withPushApproval(merging, 'hb_app', pushApproval)).toThrow(
        'Set it first: `aflow harness merge-posture hb_app never`',
      );
      expect(
        withPushApproval(merging, 'hb_app', 'unless-unreviewed').bindings[0]?.branchPolicy,
      ).toMatchObject({ mergePosture: 'when-green', pushApproval: 'unless-unreviewed' });
    },
  );

  it('refuses a folder this machine does not offer, and one that pushes nothing', () => {
    expect(() => withMergePosture(policyWith([PUSHING]), 'hb_missing', 'never')).toThrow(
      'offers no folder `hb_missing`',
    );
    expect(() => withMergePosture(policyWith([FILES_ONLY]), 'hb_notes', 'never')).toThrow(
      'pushes nothing',
    );
  });

  it('survives a change of the checks', () => {
    const merging = withMergePosture(policyWith([PUSHING]), 'hb_app', 'when-green');
    const checked = withChecks(merging, 'hb_app', checksChangeFromArgs(['--', 'yarn', 'verify']));
    expect(checked.bindings[0]?.branchPolicy?.mergePosture).toBe('when-green');
    const cleared = withChecks(checked, 'hb_app', checksChangeFromArgs(['--clear']));
    expect(cleared.bindings[0]?.branchPolicy?.mergePosture).toBe('when-green');
  });
});
