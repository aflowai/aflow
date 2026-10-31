/**
 * What a push records where `origin/<pushBase>` moved between its scan and the
 * push, and git merged it into the commit without conflict: the push merged it
 * and sent the merge (Plan 339 D3).
 */
import { z } from 'zod';

/**
 * A commit as git names it in full, SHA-1 or SHA-256, as the executor's merge
 * reads it: every sha here is one the push read or made itself.
 */
export const HOST_FULL_SHA_PATTERN = /^[0-9a-f]{40,64}$/;

const FullShaSchema = z.string().regex(HOST_FULL_SHA_PATTERN);

export const HostPushBaseMergeSchema = z
  .object({
    baseMoved: z.literal(true),
    scannedBase: FullShaSchema.describe(
      'Where `origin/<pushBase>` was when the scan read the range.',
    ),
    base: FullShaSchema.describe(
      'Where it was at the push: the base merged, the merge commit’s second parent.',
    ),
    branchCommit: FullShaSchema.describe(
      'The commit the scan ended at, the merge commit’s first parent.',
    ),
    commit: FullShaSchema.describe('The merge commit the push sent to the branch.'),
    localBranch: z
      .enum(['moved', 'absent', 'elsewhere', 'checked_out', 'failed'])
      .optional()
      .describe(
        "The folder's own branch once the push landed: `moved` to the merge, so the next " +
          'publication onto it appends to what `origin` holds, or left where it was because ' +
          'the folder has no such branch (`absent`), it was no longer at `branchCommit` ' +
          '(`elsewhere`), a checkout has it open (`checked_out`) or git could not move it ' +
          '(`failed`).',
      ),
  })
  .describe(
    'Present where `origin/<pushBase>` moved since the scan and merged into the commit with ' +
      'no conflict: the push merged it, `--no-ff` under the operator’s commit identity, and ' +
      'pushed the merge in place of the commit.',
  );

export const HostPushCheckedMergeSchema = z
  .object({
    checked: FullShaSchema.describe('The commit the folder’s checks passed on.'),
    base: FullShaSchema.describe('The base the merge merged.'),
    commit: FullShaSchema.describe('The merge commit the push sent.'),
  })
  .describe(
    'Present where the push sent a merge from a folder that declares checks: the check ' +
      'receipt for `checked` was accepted for `commit`, whose first parent is `checked` and ' +
      'whose second is `base`. The checks did not run on the merge itself.',
  );
