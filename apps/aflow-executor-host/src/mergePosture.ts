/**
 * Whether the Local PR Shepherd merges what the loop opened from a connected
 * folder (Plan 321 D6).
 *
 * A posture on the folder beside its push approval, held in the machine's
 * policy file, set at connect and changed later only from this machine, by
 * the same rule: the file holds only a posture the operator chose, and a
 * folder that chose none takes the default when the file is read. Whatever it
 * says, each merge still waits on the operator's write approval of exactly
 * that request; what `when-green` takes off the operator is the judgment.
 *
 * `when-green` needs the push approval under which a publication reviews what
 * it pushes, since the merge is on that review's verdict. The commands refuse
 * the combination either way round rather than store a posture that merges
 * nothing; a file edited into it by hand is read as it stands, and shown with
 * the reason beside it.
 */
import type { z } from 'zod';

import {
  HOST_MERGE_POSTURE_REVIEWED_PUSH,
  type HostMergePosture,
  HostMergePostureSchema,
  type HostPushApproval,
  idleMergePostureReason,
  resolveBranchPolicy,
} from '@aflow/schemas';

import type { HostPolicySchema } from './bindings.js';

type HostPolicy = z.infer<typeof HostPolicySchema>;

export const MERGE_POSTURE_VALUES: readonly HostMergePosture[] = HostMergePostureSchema.options;

/** One line per posture, in the words the CLI prints. */
export function describeMergePosture(policy: {
  readonly pushApproval: HostPushApproval;
  readonly mergePosture: HostMergePosture;
}): string {
  const idle = idleMergePostureReason(policy);
  if (idle !== undefined) return `merges nothing — ${idle}`;
  switch (policy.mergePosture) {
    case 'never':
      return 'leaves the merge to you';
    case 'when-green':
      return (
        'is merged by the shepherd, by squash and on your approval, once its required checks ' +
        "pass on its head, the publication's review approved that head and no one requests changes"
      );
  }
}

function parseMergePosture(value: string): HostMergePosture {
  const parsed = HostMergePostureSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `\`${value}\` is not a merge posture. It is one of: ${MERGE_POSTURE_VALUES.join(', ')}.`,
    );
  }
  return parsed.data;
}

function refuseUnreviewed(pushApproval: HostPushApproval, setFirst: string): void {
  throw new Error(
    `\`when-green\` merges on the verdict of the review a publication runs before it pushes, ` +
      `and under the push approval \`${pushApproval}\` no publication runs one. ${setFirst}`,
  );
}

/**
 * The merge posture a folder's policy records when it is connected: the one
 * asked for, else the one it already chose — nothing otherwise, so a change
 * of default reaches it. Refused for a folder that pushes nothing, which has
 * no pull request to merge, and `when-green` beside a push approval that runs
 * no review.
 */
export function chosenMergePosture(question: {
  readonly requested?: string | undefined;
  readonly branchPrefix: string | undefined;
  readonly current?: HostMergePosture | undefined;
  /** The push approval the folder will resolve to once connected. */
  readonly pushApproval: HostPushApproval;
}): HostMergePosture | undefined {
  if (question.branchPrefix === undefined) {
    if (question.requested !== undefined) {
      throw new Error(
        'A merge posture is a rule about the pull requests a folder opens, and this folder ' +
          'pushes nothing: it needs a branch prefix, which a git repository connected with ' +
          '`--run` takes.',
      );
    }
    return undefined;
  }
  const chosen =
    question.requested !== undefined ? parseMergePosture(question.requested) : question.current;
  if (chosen === 'when-green' && question.pushApproval !== HOST_MERGE_POSTURE_REVIEWED_PUSH) {
    refuseUnreviewed(
      question.pushApproval,
      question.requested !== undefined
        ? `Connect it with \`--push-approval ${HOST_MERGE_POSTURE_REVIEWED_PUSH}\` as well.`
        : `Connect it with \`--merge-posture never\` to push under \`${question.pushApproval}\`.`,
    );
  }
  return chosen;
}

/**
 * The policy with one folder's merge posture changed. Refused for a folder
 * this machine does not offer, for one that pushes nothing, and `when-green`
 * on one whose push approval runs no review.
 */
export function withMergePosture(
  policy: HostPolicy,
  bindingId: string,
  requested: string,
): HostPolicy {
  const mergePosture = parseMergePosture(requested);
  const binding = policy.bindings.find((b) => b.id === bindingId);
  if (binding === undefined) {
    throw new Error(`This machine offers no folder \`${bindingId}\`.`);
  }
  if (binding.branchPolicy === undefined) {
    throw new Error(
      `\`${bindingId}\` pushes nothing, so it opens no pull request to merge. Reconnect it with ` +
        '`--branch-prefix <prefix>` to let it push.',
    );
  }
  const { pushApproval } = resolveBranchPolicy(binding.branchPolicy);
  if (mergePosture === 'when-green' && pushApproval !== HOST_MERGE_POSTURE_REVIEWED_PUSH) {
    refuseUnreviewed(
      pushApproval,
      `Set it first: \`aflow harness push-approval ${bindingId} ${HOST_MERGE_POSTURE_REVIEWED_PUSH}\`.`,
    );
  }
  return {
    ...policy,
    bindings: policy.bindings.map((b) =>
      b.id === bindingId && b.branchPolicy !== undefined
        ? { ...b, branchPolicy: { ...b.branchPolicy, mergePosture } }
        : b,
    ),
  };
}

/**
 * Refuses a push approval that runs no review on a folder whose merge posture
 * is `when-green`, which would leave the posture merging nothing.
 */
export function refuseUnreviewedPushUnderWhenGreen(
  bindingId: string,
  mergePosture: HostMergePosture | undefined,
  pushApproval: HostPushApproval,
): void {
  if (mergePosture !== 'when-green' || pushApproval === HOST_MERGE_POSTURE_REVIEWED_PUSH) return;
  throw new Error(
    `\`${bindingId}\` merges \`when-green\`, on the verdict of the review a publication runs ` +
      `only under \`${HOST_MERGE_POSTURE_REVIEWED_PUSH}\`; \`${pushApproval}\` would leave it ` +
      `merging nothing. Set it first: \`aflow harness merge-posture ${bindingId} never\`.`,
  );
}
