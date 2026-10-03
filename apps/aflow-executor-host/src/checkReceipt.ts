/**
 * What a check leaves for the push that follows it.
 *
 * Whether a folder's declared checks ran before its push cannot rest on the
 * order of a skill's tasks: a copy of the skill without the check, or any
 * workflow that scans and then pushes, would push unchecked. So the check
 * issues a receipt, as the scan does and signed with the same key — the
 * folder, the commit, the base, the checks it ran, the sandbox posture they ran
 * under, whether they passed, and when — and the push of a folder that
 * declares checks carries the one for exactly the commit it sends, against the
 * base it measures, under the checks and the posture the folder declares as it
 * pushes. A check run `open` says nothing about a folder the operator has since
 * made `confined`.
 *
 * The receipt names the checks by a hash of their argv rather than the argv,
 * and carries nothing of what they printed: it is evidence of an outcome, and
 * the output is the check's result to report.
 */
import { createHash } from 'node:crypto';

import { type HostSandboxPosture, HostSandboxPostureSchema } from '@aflow/schemas';

import { HostBindingError } from './bindings.js';
import { readSignedReceipt, receiptExpired, signReceipt } from './receiptSigning.js';

/** What the checks did on the commit. A check that ran out of time failed. */
export type CheckOutcome = 'passed' | 'failed';

const OUTCOMES: readonly CheckOutcome[] = ['passed', 'failed'];

/** How much of a sha a person reads in a sentence. */
export const SHORT_SHA_LENGTH = 12;

interface CheckReceipt {
  readonly bindingId: string;
  /** The commit checked, as a full sha. */
  readonly sha: string;
  /** What it was measured against, as a full sha. */
  readonly base: string;
  /** {@link checksArgvHash} of the argv that ran. */
  readonly checks: string;
  readonly outcome: CheckOutcome;
  /** The sandbox posture the checks ran under. */
  readonly sandbox: HostSandboxPosture;
  readonly issuedAt: number;
}

/** The checks' argv as one value, token boundaries kept: `["a b"]` is not `["a", "b"]`. */
export function checksArgvHash(argv: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(argv)).digest('base64url');
}

export function issueCheckReceipt(
  receipt: {
    readonly bindingId: string;
    readonly sha: string;
    readonly base: string;
    readonly argv: readonly string[];
    readonly outcome: CheckOutcome;
    readonly sandbox: HostSandboxPosture;
  },
  now: number = Date.now(),
): string {
  return signReceipt('check', [
    receipt.bindingId,
    receipt.sha.toLowerCase(),
    receipt.base.toLowerCase(),
    checksArgvHash(receipt.argv),
    receipt.outcome,
    receipt.sandbox,
    now,
  ]);
}

function readCheckReceipt(token: string): CheckReceipt | undefined {
  const fields = readSignedReceipt('check', token);
  if (fields === undefined) return undefined;
  const [bindingId, sha, base, checks, outcome, sandbox, issuedAt] = fields;
  const posture = HostSandboxPostureSchema.safeParse(sandbox);
  if (
    typeof bindingId !== 'string' ||
    typeof sha !== 'string' ||
    typeof base !== 'string' ||
    typeof checks !== 'string' ||
    !OUTCOMES.includes(outcome as CheckOutcome) ||
    !posture.success ||
    typeof issuedAt !== 'number'
  ) {
    return undefined;
  }
  return {
    bindingId,
    sha,
    base,
    checks,
    outcome: outcome as CheckOutcome,
    sandbox: posture.data,
    issuedAt,
  };
}

/** Why a push was refused for the check receipt it carried, or did not. */
export type CheckReceiptRefusal =
  | 'checks_undeclared'
  | 'no_check_receipt'
  | 'check_not_issued_here'
  | 'check_other_folder'
  | 'check_stale'
  | 'check_other_commit'
  | 'check_other_base'
  | 'check_other_checks'
  | 'check_other_posture'
  | 'check_failed';

export class CheckReceiptError extends HostBindingError {
  constructor(
    message: string,
    readonly refusal: CheckReceiptRefusal,
  ) {
    super(message, 'push_refused');
  }
}

/** What the push gate reads of the folder's checks and the receipt the push carries. */
export interface PushUnderCheck {
  /** The folder's checks as its policy declares them now; absent where it declares none. */
  readonly argv: readonly string[] | undefined;
  readonly receipt: string | undefined;
  /** The folder's sandbox posture as its policy declares it now. */
  readonly posture: HostSandboxPosture;
}

/**
 * Refuse a push from a folder that declares checks unless it carries the
 * receipt of those checks passing here on exactly the commit it sends, against
 * the base the push measured, under the posture the folder declares as it
 * pushes — and a push from one that declares none that carries a receipt
 * anyway, since nothing the folder asks for can be what it attests to. Answers the posture the checks ran under, which the push records,
 * or nothing where the folder declares none.
 */
export function requireCheckedPush(
  push: PushUnderCheck & {
    readonly bindingId: string;
    /** The source of the push's one refspec, as a full sha. */
    readonly sha: string;
    /** Where `origin/<pushBase>` is now, as a full sha. */
    readonly base: string;
  },
  now: number = Date.now(),
): HostSandboxPosture | undefined {
  const { bindingId, argv } = push;
  if (argv === undefined) {
    if (push.receipt === undefined) return undefined;
    throw new CheckReceiptError(
      `\`${bindingId}\` declares no checks, so a push from it needs no check receipt, and ` +
        'this push carries one. Nothing was pushed. Send the push without `check.receipt`.',
      'checks_undeclared',
    );
  }
  const command = `\`${argv.join(' ')}\``;
  const short = push.sha.slice(0, SHORT_SHA_LENGTH);
  const checkAgain =
    `Nothing was pushed. Run the folder's checks on \`${push.sha}\` against \`${push.base}\` ` +
    'with `host.commit.check`, and push with the receipt it returns once they pass.';
  if (push.receipt === undefined) {
    throw new CheckReceiptError(
      `\`${bindingId}\` declares checks, ${command}, and this push carries no check receipt, ` +
        `so nothing says they passed on ${short}. ${checkAgain}`,
      'no_check_receipt',
    );
  }
  const receipt = readCheckReceipt(push.receipt);
  if (receipt === undefined) {
    throw new CheckReceiptError(
      'This push carries a check receipt this executor did not issue since it last started. ' +
        checkAgain,
      'check_not_issued_here',
    );
  }
  if (receipt.bindingId !== bindingId) {
    throw new CheckReceiptError(
      `This push carries the receipt for a check of \`${receipt.bindingId}\`, and pushes from ` +
        `\`${bindingId}\`. ${checkAgain}`,
      'check_other_folder',
    );
  }
  if (receiptExpired(receipt.issuedAt, now)) {
    throw new CheckReceiptError(
      `This push carries a check receipt issued at ${new Date(receipt.issuedAt).toISOString()}, ` +
        `more than a day ago. ${checkAgain}`,
      'check_stale',
    );
  }
  if (receipt.sha !== push.sha.toLowerCase()) {
    throw new CheckReceiptError(
      `This push sends \`${push.sha}\`, and its check receipt is for the checks run on ` +
        `\`${receipt.sha}\`. ${checkAgain}`,
      'check_other_commit',
    );
  }
  if (receipt.base !== push.base.toLowerCase()) {
    throw new CheckReceiptError(
      `This push is measured against \`${push.base}\`, and its check receipt is for checks run ` +
        `on ${short} against \`${receipt.base}\`. ${checkAgain}`,
      'check_other_base',
    );
  }
  if (receipt.checks !== checksArgvHash(argv)) {
    throw new CheckReceiptError(
      `\`${bindingId}\` declares ${command} as its checks, and its check receipt is for other ` +
        `checks: they changed after these ran on ${short}. ${checkAgain}`,
      'check_other_checks',
    );
  }
  if (receipt.sandbox !== push.posture) {
    throw new CheckReceiptError(
      `\`${bindingId}\` runs its checks \`${push.posture}\`, and its check receipt is for checks ` +
        `run \`${receipt.sandbox}\` on ${short}: the posture changed after they ran. ${checkAgain}`,
      'check_other_posture',
    );
  }
  if (receipt.outcome !== 'passed') {
    throw new CheckReceiptError(
      `The checks of \`${bindingId}\`, ${command}, failed on ${short}, and a commit is pushed ` +
        `only once they pass on it. ${checkAgain}`,
      'check_failed',
    );
  }
  return receipt.sandbox;
}
