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
 * the range it sends, and this process alone can have issued it.
 *
 * The range is the caller's to name, so the receipt binds its base as well as
 * its end, and the push measures its own base rather than taking one: a scan
 * of `<tip>..<tip>` read nothing of what a push of `<tip>` would carry.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { hostPushRequestHash } from '@aflow/redis';
import {
  HOST_COMMIT_RANGE_PATTERN,
  type HostCommitScanOutputSchema,
  type HostPushApproval,
  type WriteApprovalGrant,
} from '@aflow/schemas';
import type { z } from 'zod';

import { HostBindingError } from './bindings.js';

type HostCommitScanOutput = z.infer<typeof HostCommitScanOutputSchema>;

/**
 * What the scan found of the range: nothing, or nothing but lines marked
 * allowed or files it could not read whole — which the operator reads before
 * the push. A range where a rule matched gets no receipt.
 */
export type ScanOutcome = 'clean' | 'allowed' | 'unscanned';

const OUTCOMES: readonly ScanOutcome[] = ['clean', 'allowed', 'unscanned'];

/**
 * How long a receipt is good for. Long enough for an approval asked in the
 * evening to be given the next morning; past it, the commit is scanned again.
 */
export const SCAN_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

const RECEIPT_KEY = randomBytes(32);

interface ScanReceipt {
  readonly bindingId: string;
  /** The range's base, as the scan resolved it to a full sha. */
  readonly base: string;
  /** The range's last commit, as a full sha. */
  readonly sha: string;
  readonly outcome: ScanOutcome;
  readonly issuedAt: number;
}

function sign(body: string): Buffer {
  return createHmac('sha256', RECEIPT_KEY).update(body).digest();
}

export function issueScanReceipt(
  receipt: Omit<ScanReceipt, 'issuedAt'>,
  now: number = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify([receipt.bindingId, receipt.base, receipt.sha, receipt.outcome, now]),
  ).toString('base64url');
  return `${body}.${sign(body).toString('base64url')}`;
}

/** The receipt a token carries, or nothing unless this process signed it. */
function readScanReceipt(token: string): ScanReceipt | undefined {
  const [body, mac, extra] = token.split('.');
  if (body === undefined || mac === undefined || extra !== undefined) return undefined;
  const expected = sign(body);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const fields: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!Array.isArray(fields)) return undefined;
  const [bindingId, base, sha, outcome, issuedAt] = fields as unknown[];
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

/** The receipt for a scan of `bindingId`, or nothing where a rule matched. */
export function receiptForScan(
  bindingId: string,
  output: HostCommitScanOutput,
  now: number = Date.now(),
): string | undefined {
  const range = HOST_COMMIT_RANGE_PATTERN.exec(output.unflaggedRange ?? '');
  const [, base, sha] = range ?? [];
  if (base === undefined || sha === undefined) return undefined;
  const outcome: ScanOutcome = output.clean
    ? 'clean'
    : output.unscanned.length > 0
      ? 'unscanned'
      : 'allowed';
  return issueScanReceipt(
    { bindingId, base: base.toLowerCase(), sha: sha.toLowerCase(), outcome },
    now,
  );
}

/** Why a push was refused for the receipt it carried, or did not. */
export type ScanReceiptRefusal =
  | 'no_base'
  | 'no_receipt'
  | 'not_issued_here'
  | 'other_folder'
  | 'stale'
  | 'other_range'
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
  /** Where `origin/<pushBase>` is now, fetched for the purpose, as a full sha. */
  readonly measureBase: (pushBase: string) => Promise<string>;
  /** The grant an operator's approval minted for `requestHash` in this run, if any. */
  readonly approvalFor: (requestHash: string) => Promise<WriteApprovalGrant | null>;
}

function scanAgain(pushBase: string): string {
  return (
    `Nothing was pushed. Scan the range the push sends — from where \`origin/${pushBase}\` ` +
    'is now to the commit it pushes — with `host.commit.scan`, and push with the receipt it ' +
    'returns.'
  );
}

/**
 * Refuse a push that does not send, from this folder, the range a scan by this
 * executor found no secret in — from where `origin/<pushBase>` is now to the
 * commit the push names — or, where that scan did not clear it or the folder's
 * push approval is `always`, a push the operator has not approved in this run.
 *
 * Under `unless-unreviewed` a cleared range goes out with no grant: whether a
 * review cleared it is the publication skill's to establish, and nothing this
 * gate holds can verify that one ran or what it said.
 */
export async function requireScannedPush(
  push: PushUnderScan,
  now: number = Date.now(),
): Promise<void> {
  const { bindingId, pushBase } = push;
  if (pushBase === undefined) {
    throw new ScanReceiptError(
      'This push names no `pushBase`, so what it would add to `origin` cannot be measured ' +
        'against what its scan read. Nothing was pushed. Name the branch on `origin` the ' +
        'commit was made against.',
      'no_base',
    );
  }
  if (push.receipt === undefined) {
    throw new ScanReceiptError(
      'This push carries no scan receipt, so nothing says what it sends was read for secrets. ' +
        scanAgain(pushBase),
      'no_receipt',
    );
  }
  const receipt = readScanReceipt(push.receipt);
  if (receipt === undefined) {
    throw new ScanReceiptError(
      'This push carries a scan receipt this executor did not issue since it last started. ' +
        scanAgain(pushBase),
      'not_issued_here',
    );
  }
  const scanned = `\`${receipt.base}..${receipt.sha}\``;
  if (receipt.bindingId !== bindingId) {
    throw new ScanReceiptError(
      `This push carries the receipt for a scan of \`${receipt.bindingId}\`, and pushes from ` +
        `\`${bindingId}\`. ${scanAgain(pushBase)}`,
      'other_folder',
    );
  }
  if (now - receipt.issuedAt > SCAN_RECEIPT_TTL_MS || receipt.issuedAt > now) {
    throw new ScanReceiptError(
      `This push carries the receipt for a scan of ${scanned} issued at ` +
        `${new Date(receipt.issuedAt).toISOString()}, more than a day ago. ${scanAgain(pushBase)}`,
      'stale',
    );
  }
  const [source, ...more] = push.sources;
  const [refspec] = push.refspecs;
  if (source?.toLowerCase() !== receipt.sha || refspec === undefined || more.length > 0) {
    throw new ScanReceiptError(
      `This push sends ${push.sources.map((s) => `\`${s}\``).join(', ')}, and its receipt is ` +
        `for a scan of ${scanned}: a push sends the one commit its scan ended at, named by ` +
        `that commit's sha as the source of its one refspec. ${scanAgain(pushBase)}`,
      'other_range',
    );
  }
  const measured = (await push.measureBase(pushBase)).toLowerCase();
  if (measured !== receipt.base) {
    throw new ScanReceiptError(
      `\`origin/${pushBase}\` is at \`${measured}\`, so this push sends ` +
        `\`${measured}..${receipt.sha}\`, and its receipt is for a scan of ${scanned}. ` +
        scanAgain(pushBase),
      'other_range',
    );
  }
  const asksAlways = push.pushApproval === 'always';
  if (receipt.outcome === 'clean' && !asksAlways) return;

  const requestHash = hostPushRequestHash({ bindingId, refspec, receipt: push.receipt });
  const grant = await push.approvalFor(requestHash);
  if (grant?.decision === 'approved' && grant.requestHash === requestHash) return;
  const reasons = [
    ...(asksAlways ? [`The push approval of \`${bindingId}\` is \`always\``] : []),
    ...(receipt.outcome === 'unscanned'
      ? [`the scan of ${scanned} could not read all of it`]
      : receipt.outcome === 'allowed'
        ? [`the scan of ${scanned} found lines in it marked \`aflow-scan: allow\``]
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
