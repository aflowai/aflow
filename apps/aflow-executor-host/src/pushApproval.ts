/**
 * When a publication from a connected folder asks before it pushes.
 *
 * A posture on the folder, held in the machine's policy file beside the branch
 * prefix it qualifies, set at connect and changed later only from this machine.
 * The file holds only a posture the operator chose; a folder that chose none
 * takes the default when the file is read.
 * Whether a given publication asks is decided by the orchestrator over the
 * posture this executor relays, so an appliance that is not honest can skip
 * the question. What it cannot do is change the posture recorded here, or move
 * a branch the prefix does not cover, or force one: those are judged on this
 * machine when the push runs.
 */
import { basename } from 'node:path';

import type { z } from 'zod';

import { type HostPushApproval, HostPushApprovalSchema, resolveBranchPolicy } from '@aflow/schemas';

import type { HostInventoryFolders } from '@aflow/redis';

import type { HostBinding, HostPolicySchema } from './bindings.js';

type HostPolicy = z.infer<typeof HostPolicySchema>;

export const PUSH_APPROVAL_VALUES: readonly HostPushApproval[] = HostPushApprovalSchema.options;

/** Why a review may stand in for the operator, in the words the CLI prints beside the posture. */
export const PUSH_SCAN_NOTE =
  'Every publication scans everything it would push for secrets first and stops, with ' +
  'nothing pushed, when it finds one — which is what lets a review stand in for your ' +
  'approval. Whatever the posture, it asks you when the scan could not read a file or ' +
  'found a line marked `aflow-scan: allow`.';

/** One line per posture, in the words the CLI prints. */
export function describePushApproval(pushApproval: HostPushApproval): string {
  switch (pushApproval) {
    case 'always':
      return 'asks before every push';
    case 'never':
      return 'pushes without asking';
    case 'unless-unreviewed':
      return 'reviews the commit and asks before the push unless the review approves it';
  }
}

function parsePushApproval(value: string): HostPushApproval {
  const parsed = HostPushApprovalSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `\`${value}\` is not a push approval. It is one of: ${PUSH_APPROVAL_VALUES.join(', ')}.`,
    );
  }
  return parsed.data;
}

/**
 * The posture a folder's policy records when it is connected: the one asked
 * for, else the one it already chose. Nothing otherwise — a folder that never
 * chose reads as the default each time it is read, so a change of default
 * reaches it. Only a folder that pushes has one, so asking for a posture on a
 * folder with no branch prefix is refused rather than recorded against nothing.
 */
export function chosenPushApproval(question: {
  readonly requested?: string | undefined;
  readonly branchPrefix: string | undefined;
  readonly current?: HostPushApproval | undefined;
}): HostPushApproval | undefined {
  if (question.branchPrefix === undefined) {
    if (question.requested !== undefined) {
      throw new Error(
        'A push approval is a rule about pushes, and this folder pushes nothing: it needs a ' +
          'branch prefix, which a git repository connected with `--run` takes.',
      );
    }
    return undefined;
  }
  if (question.requested !== undefined) return parsePushApproval(question.requested);
  return question.current;
}

/**
 * The posture a push from this folder is held to when it runs. A folder with no
 * branch policy is refused any push before this is read; should one reach it,
 * it asks.
 */
export function pushApprovalOf(binding: HostBinding): HostPushApproval {
  return binding.branchPolicy === undefined
    ? 'always'
    : resolveBranchPolicy(binding.branchPolicy).pushApproval;
}

/**
 * What the machine's inventory says about pushing folders: each one's posture
 * and the program its checks run, against the workspace it was connected for.
 * A folder recording no workspace reaches none, so it is left out rather than
 * published against nothing. The checks' arguments and the program's directory
 * stay on this machine; `host.binding.inspect` shows them to the operator.
 */
export function publishingFolders(
  bindings: ReadonlyMap<string, HostBinding>,
): HostInventoryFolders {
  return [...bindings.values()]
    .flatMap((binding) => {
      if (binding.branchPolicy === undefined || binding.spaceId === undefined) return [];
      const argv0 = binding.branchPolicy.checks?.[0];
      return [
        {
          id: binding.id,
          spaceId: binding.spaceId,
          pushApproval: resolveBranchPolicy(binding.branchPolicy).pushApproval,
          ...(argv0 !== undefined ? { checks: { program: basename(argv0) || argv0 } } : {}),
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The policy with one folder's posture changed. Refused for a folder this
 * machine does not offer, and for one that pushes nothing.
 */
export function withPushApproval(
  policy: HostPolicy,
  bindingId: string,
  requested: string,
): HostPolicy {
  const pushApproval = parsePushApproval(requested);
  const binding = policy.bindings.find((b) => b.id === bindingId);
  if (binding === undefined) {
    throw new Error(`This machine offers no folder \`${bindingId}\`.`);
  }
  if (binding.branchPolicy === undefined) {
    throw new Error(
      `\`${bindingId}\` pushes nothing, so there is no push to approve. Reconnect it with ` +
        '`--branch-prefix <prefix>` to let it push.',
    );
  }
  return {
    ...policy,
    bindings: policy.bindings.map((b) =>
      b.id === bindingId && b.branchPolicy !== undefined
        ? { ...b, branchPolicy: { ...b.branchPolicy, pushApproval } }
        : b,
    ),
  };
}
