/**
 * What a scan leaves for the push that follows it.
 *
 * A push runs as the operator's own git, and `host.process.exec` takes any
 * command a binding allows, so what keeps an unscanned commit off `origin`
 * cannot be the order of a skill's tasks: a skill written in the space could
 * push without scanning. Instead the scan issues a receipt — the folder, the
 * base and the last commit of the range, whether the scan cleared it or the
 * operator has to approve the push, and when — signed with a key this executor
 * draws when it starts and never writes down. A push carries the receipt for
 * the range it sends, and this process alone can have issued it. The folder's
 * checks are held to the same standard by the check receipt the push carries
 * beside it (`checkReceipt.ts`), read in the same step.
 *
 * The range is the caller's to name, so the receipt binds its base as well as
 * its end, and the push measures its own base rather than taking one: a scan
 * of `<tip>..<tip>` read nothing of what a push of `<tip>` would carry.
 *
 * A receipt is evidence only on the process that signed it, within its day,
 * for the range from where `origin` is. Where `origin` has moved on since, or
 * the receipt can no longer be read as this process's own, the push reads the
 * range it sends itself, in its own step: a publication then pushes what it
 * scanned instead of stranding a commit that was cleared and approved.
 */
import { hostPushRequestHash } from '@aflow/redis';
import {
  HOST_COMMIT_RANGE_PATTERN,
  type HostCommitScanOutputSchema,
  type HostPushApproval,
  type HostSandboxPosture,
  type WriteApprovalGrant,
} from '@aflow/schemas';
import type { z } from 'zod';

import { HostBindingError } from './bindings.js';
import { type PushUnderCheck, requireCheckedPush } from './checkReceipt.js';
import {
  readClaimedReceipt,
  readSignedReceipt,
  receiptExpired,
  signReceipt,
} from './receiptSigning.js';

type HostCommitScanOutput = z.infer<typeof HostCommitScanOutputSchema>;

/**
 * What the scan found of the range: nothing, or nothing but lines marked
 * allowed or files it could not read whole — which the operator reads before
 * the push. A range where a rule matched gets no receipt.
 */
export type ScanOutcome = 'clean' | 'allowed' | 'unscanned';

const OUTCOMES: readonly ScanOutcome[] = ['clean', 'allowed', 'unscanned'];

interface ScanReceipt {
  readonly bindingId: string;
  /** The range's base, as the scan resolved it to a full sha. */
  readonly base: string;
  /** The range's last commit, as a full sha. */
  readonly sha: string;
  readonly outcome: ScanOutcome;
  readonly issuedAt: number;
}

export function issueScanReceipt(
  receipt: Omit<ScanReceipt, 'issuedAt'>,
  now: number = Date.now(),
): string {
  return signReceipt('scan', [receipt.bindingId, receipt.base, receipt.sha, receipt.outcome, now]);
}

function scanReceiptOf(fields: unknown[] | undefined): ScanReceipt | undefined {
  if (fields === undefined) return undefined;
  const [bindingId, base, sha, outcome, issuedAt] = fields;
  if (
    typeof bindingId !== 'string' ||
    typeof base !== 'string' ||
    typeof sha !== 'string' ||
    !OUTCOMES.includes(outcome as ScanOutcome) ||
    typeof issuedAt !== 'number'
  ) {
    return undefined;
  }
  return { bindingId, base, sha, outcome: outcome as ScanOutcome, issuedAt };
}

/** What a scan that found no secret makes of its range. */
function outcomeOf(output: HostCommitScanOutput): ScanOutcome {
  return output.clean ? 'clean' : output.unscanned.length > 0 ? 'unscanned' : 'allowed';
}

/** The receipt for a scan of `bindingId`, or nothing where a rule matched. */
export function receiptForScan(
  bindingId: string,
  output: HostCommitScanOutput,
  now: number = Date.now(),
): string | undefined {
  const range = HOST_COMMIT_RANGE_PATTERN.exec(output.unflaggedRange ?? '');
  const [, base, sha] = range ?? [];
  if (base === undefined || sha === undefined) return undefined;
  return issueScanReceipt(
    { bindingId, base: base.toLowerCase(), sha: sha.toLowerCase(), outcome: outcomeOf(output) },
    now,
  );
}

/** Why a push was refused for the receipt it carried, or did not. */
export type ScanReceiptRefusal =
  | 'no_base'
  | 'no_receipt'
  | 'not_issued_here'
  | 'other_folder'
  | 'other_range'
  | 'base_conflicts'
  | 'secret_found'
  | 'unapproved';

export class ScanReceiptError extends HostBindingError {
  constructor(
    message: string,
    readonly refusal: ScanReceiptRefusal,
  ) {
    super(message, 'push_refused');
  }
}

/**
 * Where the gate reads the approval grants an operator's decisions minted —
 * keyed as Plan 253's write approvals are, by tenant, run and request hash.
 */
export type PushApprovalReader = (
  tenantId: string,
  runId: string,
  requestHash: string,
) => Promise<WriteApprovalGrant | null>;

/** What the gate reads of the push it is about to spawn. */
export interface PushUnderScan {
  readonly bindingId: string;
  /** The folder's push approval as it resolves now, the default for a folder that chose none. */
  readonly pushApproval: HostPushApproval;
  readonly refspecs: readonly string[];
  /** The source of each refspec, in the same order. */
  readonly sources: readonly string[];
  readonly pushBase: string | undefined;
  readonly receipt: string | undefined;
  /** The folder's checks as its policy declares them now, and the check receipt the push carries. */
  readonly checks: PushUnderCheck;
  /** What the gate reads of the folder's history to measure and, where it must, scan the push. */
  readonly history: PushHistory;
  /** The grant an operator's approval minted for `requestHash` in this run, if any. */
  readonly approvalFor: (requestHash: string) => Promise<WriteApprovalGrant | null>;
}

/** The folder's history, as the gate reads it in the push's own step. */
export interface PushHistory {
  /** Where `origin/<pushBase>` is now, fetched for the purpose, as a full sha. */
  readonly measureBase: (pushBase: string) => Promise<string>;
  /** Whether `ancestor` is `commit` or under it; false for a commit the folder does not have. */
  readonly holds: (commit: string, ancestor: string) => Promise<boolean>;
  /** The paths a merge of `sha` into `base` would leave conflicted. */
  readonly conflicts: (base: string, sha: string) => Promise<string[]>;
  /** A scan of `range` for secrets, as `host.commit.scan` reads one. */
  readonly scanSecrets: (range: string) => Promise<HostCommitScanOutput>;
}

/** What a push that cleared the gate records with it. */
export interface PushClearance {
  /** The sandbox posture its checks ran under; absent where the folder declares none. */
  readonly checkedUnder?: HostSandboxPosture;
  /** The range the push scanned in its own step, where its receipt did not cover what it sends. */
  readonly rescanned?: string;
}

/** The range a push sends and how it was cleared of secrets: by its receipt, or by a scan of its own. */
interface ScannedRange {
  /** Where `origin/<pushBase>` is now, as a full sha: the range's base. */
  readonly base: string;
  readonly range: string;
  readonly outcome: ScanOutcome;
  readonly rescanned: boolean;
}

function scanAgain(pushBase: string): string {
  return (
    `Nothing was pushed. Scan the range the push sends — from where \`origin/${pushBase}\` ` +
    'is now to the commit it pushes — with `host.commit.scan`, and push with the receipt it ' +
    'returns.'
  );
}

/** The branch a refspec's destination names, as a person names it. */
function destinationBranch(refspec: string): string {
  return refspec.slice(refspec.indexOf(':') + 1).replace(/^refs\/heads\//, '');
}

/**
 * The range the push sends, from where `origin/<pushBase>` is now, and how it
 * was cleared of secrets. The receipt clears it where this process signed it
 * within its day for exactly that range. Otherwise — `origin` moved on since
 * the scan, or the receipt is from before this process started — the range is
 * scanned here, provided the receipt's own base is one `origin` still holds:
 * a base it no longer holds was rewound, and the push would carry commits the
 * publication's scan and review read as already there.
 */
async function rangeToPush(
  push: PushUnderScan & { readonly pushBase: string; readonly receipt: string },
  claimed: ScanReceipt,
  signedHere: boolean,
  refspec: string,
  now: number,
): Promise<ScannedRange> {
  const { history, pushBase } = push;
  const measured = (await history.measureBase(pushBase)).toLowerCase();
  const range = `${measured}..${claimed.sha}`;
  const current = signedHere && !receiptExpired(claimed.issuedAt, now);
  if (current && measured === claimed.base) {
    return { base: measured, range, outcome: claimed.outcome, rescanned: false };
  }

  const moved = measured !== claimed.base;
  if (moved && !(await history.holds(measured, claimed.base))) {
    throw new ScanReceiptError(
      `\`origin/${pushBase}\` is at \`${measured}\`, so this push sends \`${range}\`, and its ` +
        `receipt is for a scan of \`${claimed.base}..${claimed.sha}\`, which starts at a commit ` +
        `\`origin/${pushBase}\` does not hold: the push would carry commits that scan read as ` +
        `already on \`origin\`. Nothing was pushed. Publish \`${destinationBranch(refspec)}\` ` +
        'again as it stands, so what it sends is scanned and reviewed from where ' +
        `\`origin/${pushBase}\` is now.`,
      'other_range',
    );
  }
  if (moved) {
    const conflicted = await history.conflicts(measured, claimed.sha);
    if (conflicted.length > 0) {
      const branch = destinationBranch(refspec);
      throw new ScanReceiptError(
        `\`origin/${pushBase}\` moved from \`${claimed.base}\` to \`${measured}\` since the ` +
          `scan, and \`${claimed.sha}\` no longer merges into it cleanly: ` +
          `${conflicted.map((path) => `\`${path}\``).join(', ')} conflict. Nothing was pushed. ` +
          `The remedy is the merge round: commission the fix from \`${branch}\` with ` +
          `\`mergeFrom: origin/${pushBase}\`, and publish it onto \`${branch}\` with the ` +
          'sha the commission reports in `merge.from` as `mergeFrom`.',
        'base_conflicts',
      );
    }
  }
  const scan = await history.scanSecrets(range);
  if (scan.unflaggedRange === undefined) {
    throw new ScanReceiptError(
      `The push scanned \`${range}\`, the range it sends, and found what looks like a ` +
        `secret. ${scan.summary} Nothing was pushed.`,
      'secret_found',
    );
  }
  return { base: measured, range, outcome: outcomeOf(scan), rescanned: true };
}

/**
 * Refuse a push that does not send, from this folder, a range found free of
 * secrets — by a scan this executor made within the day, for exactly the range
 * from where `origin/<pushBase>` is now to the commit the push names, or by the
 * push's own scan of that range where the receipt it carries is for a base
 * `origin` has moved past or was issued before this executor started; a push
 * of a commit whose folder declares checks that did not pass on it here,
 * against that base or one under it; or, where the range was not cleared or
 * the folder's push approval is `always`, a push the operator has not approved
 * in this run. A push that clears it records the posture its checks ran under,
 * and the range it scanned where it scanned one.
 *
 * The approval stays the one the operator gave for the receipt the push
 * carries: a range scanned again starts at or above the receipt's, so it adds
 * nothing the operator did not see.
 *
 * Under `unless-unreviewed` a cleared range goes out with no grant: whether a
 * review cleared it is the publication skill's to establish, and nothing this
 * gate holds can verify that one ran or what it said.
 */
export async function requireScannedPush(
  push: PushUnderScan,
  now: number = Date.now(),
): Promise<PushClearance> {
  const { bindingId, pushBase, receipt } = push;
  if (pushBase === undefined) {
    throw new ScanReceiptError(
      'This push names no `pushBase`, so what it would add to `origin` cannot be measured ' +
        'against what its scan read. Nothing was pushed. Name the branch on `origin` the ' +
        'commit was made against.',
      'no_base',
    );
  }
  if (receipt === undefined) {
    throw new ScanReceiptError(
      'This push carries no scan receipt, so nothing says what it sends was read for secrets. ' +
        scanAgain(pushBase),
      'no_receipt',
    );
  }
  const signed = scanReceiptOf(readSignedReceipt('scan', receipt));
  const claimed = signed ?? scanReceiptOf(readClaimedReceipt(receipt));
  if (claimed === undefined) {
    throw new ScanReceiptError(
      'This push carries a scan receipt that names no folder and range, so nothing says it ' +
        `sends what a scan read. ${scanAgain(pushBase)}`,
      'not_issued_here',
    );
  }
  const scanned = `\`${claimed.base}..${claimed.sha}\``;
  if (claimed.bindingId !== bindingId) {
    throw new ScanReceiptError(
      `This push carries the receipt for a scan of \`${claimed.bindingId}\`, and pushes from ` +
        `\`${bindingId}\`. ${scanAgain(pushBase)}`,
      'other_folder',
    );
  }
  const [source, ...more] = push.sources;
  const [refspec] = push.refspecs;
  if (source?.toLowerCase() !== claimed.sha || refspec === undefined || more.length > 0) {
    throw new ScanReceiptError(
      `This push sends ${push.sources.map((s) => `\`${s}\``).join(', ')}, and its receipt is ` +
        `for a scan of ${scanned}: a push sends the one commit its scan ended at, named by ` +
        `that commit's sha as the source of its one refspec. ${scanAgain(pushBase)}`,
      'other_range',
    );
  }
  const sent = await rangeToPush(
    { ...push, pushBase, receipt },
    claimed,
    signed !== undefined,
    refspec,
    now,
  );
  const checkedUnder = await requireCheckedPush(
    {
      bindingId,
      sha: claimed.sha,
      base: sent.base,
      baseHolds: (base) => push.history.holds(sent.base, base),
      ...push.checks,
    },
    now,
  );
  const clearance: PushClearance = {
    ...(checkedUnder !== undefined ? { checkedUnder } : {}),
    ...(sent.rescanned ? { rescanned: sent.range } : {}),
  };

  const asksAlways = push.pushApproval === 'always';
  if (sent.outcome === 'clean' && !asksAlways) return clearance;

  const requestHash = hostPushRequestHash({ bindingId, refspec, receipt });
  const grant = await push.approvalFor(requestHash);
  if (grant?.decision === 'approved' && grant.requestHash === requestHash) return clearance;
  const read = `\`${sent.range}\``;
  const reasons = [
    ...(asksAlways ? [`The push approval of \`${bindingId}\` is \`always\``] : []),
    ...(sent.outcome === 'unscanned'
      ? [`the scan of ${read} could not read all of it`]
      : sent.outcome === 'allowed'
        ? [`the scan of ${read} found lines in it marked \`aflow-scan: allow\``]
        : []),
  ];
  const reason = reasons.join(', and ');
  throw new ScanReceiptError(
    `${reason.charAt(0).toUpperCase()}${reason.slice(1)}, so it is pushed only once the ` +
      `operator has approved this push — \`${refspec}\` from \`${bindingId}\` with this ` +
      'receipt — in this run, and no such approval is on record. Nothing was pushed.',
    'unapproved',
  );
}
