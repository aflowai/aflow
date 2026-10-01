/**
 * What a scan leaves for the push that follows it.
 *
 * A push runs as the operator's own git, and `host.process.exec` takes any
 * command a binding allows, so what keeps an unscanned commit off `origin`
 * cannot be the order of a skill's tasks: a skill written in the space could
 * push without scanning. Instead the scan issues a receipt — the folder, the
 * last commit of the range, whether the scan cleared it or the operator has to
 * approve it, and when — signed with a key this executor draws when it starts
 * and never writes down. A push carries the receipt for the commit it sends,
 * and this process alone can have issued it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { HostCommitScanOutputSchema } from '@aflow/schemas';
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
    JSON.stringify([receipt.bindingId, receipt.sha, receipt.outcome, now]),
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
  const [bindingId, sha, outcome, issuedAt] = fields as unknown[];
  if (
    typeof bindingId !== 'string' ||
    typeof sha !== 'string' ||
    !OUTCOMES.includes(outcome as ScanOutcome) ||
    typeof issuedAt !== 'number'
  ) {
    return undefined;
  }
  return { bindingId, sha, outcome: outcome as ScanOutcome, issuedAt };
}

/** The receipt for a scan of `bindingId`, or nothing where a rule matched. */
export function receiptForScan(
  bindingId: string,
  output: HostCommitScanOutput,
  now: number = Date.now(),
): string | undefined {
  const sha = output.unflaggedRange?.split('..')[1];
  if (sha === undefined) return undefined;
  const outcome: ScanOutcome = output.clean
    ? 'clean'
    : output.unscanned.length > 0
      ? 'unscanned'
      : 'allowed';
  return issueScanReceipt({ bindingId, sha, outcome }, now);
}

/** Why a push was refused for the receipt it carried, or did not. */
export type ScanReceiptRefusal =
  'no_receipt' | 'not_issued_here' | 'other_folder' | 'stale' | 'other_commit' | 'unapproved';

export class ScanReceiptError extends HostBindingError {
  constructor(
    message: string,
    readonly refusal: ScanReceiptRefusal,
  ) {
    super(message, 'push_refused');
  }
}

const SCAN_AGAIN =
  'Nothing was pushed. Scan the range the push sends with `host.commit.scan` and push ' +
  'with the receipt it returns.';

/** What a push says about its scan: the receipt, and the approval of it where one was given. */
export interface PushScan {
  readonly receipt: string;
  readonly approvedReceipt?: string | undefined;
}

/**
 * Refuse a push that does not send, from this folder, the commit a scan by
 * this executor found no secret in — or, where that scan did not clear it,
 * one the operator has not approved.
 */
export function requireScanReceipt(
  bindingId: string,
  sources: readonly string[],
  scan: PushScan | undefined,
  now: number = Date.now(),
): void {
  if (scan === undefined) {
    throw new ScanReceiptError(
      'This push carries no scan receipt, so nothing says what it sends was read for secrets. ' +
        SCAN_AGAIN,
      'no_receipt',
    );
  }
  const receipt = readScanReceipt(scan.receipt);
  if (receipt === undefined) {
    throw new ScanReceiptError(
      'This push carries a scan receipt this executor did not issue since it last started. ' +
        SCAN_AGAIN,
      'not_issued_here',
    );
  }
  if (receipt.bindingId !== bindingId) {
    throw new ScanReceiptError(
      `This push carries the receipt for a scan of \`${receipt.bindingId}\`, and pushes from ` +
        `\`${bindingId}\`. ${SCAN_AGAIN}`,
      'other_folder',
    );
  }
  if (now - receipt.issuedAt > SCAN_RECEIPT_TTL_MS || receipt.issuedAt > now) {
    throw new ScanReceiptError(
      `This push carries the receipt for a scan of \`${receipt.sha}\` issued at ` +
        `${new Date(receipt.issuedAt).toISOString()}, more than a day ago. ${SCAN_AGAIN}`,
      'stale',
    );
  }
  const [source, ...more] = sources;
  if (source?.toLowerCase() !== receipt.sha || more.length > 0) {
    throw new ScanReceiptError(
      `This push sends ${sources.map((s) => `\`${s}\``).join(', ')}, and its receipt is for ` +
        `\`${receipt.sha}\`: a push sends the one commit its scan read, named by that ` +
        `commit's sha as the source of its one refspec. ${SCAN_AGAIN}`,
      'other_commit',
    );
  }
  if (scan.approvedReceipt !== undefined && scan.approvedReceipt !== scan.receipt) {
    throw new ScanReceiptError(
      `This push carries an approval of another scan than the one of \`${receipt.sha}\` it ` +
        'sends. Nothing was pushed.',
      'unapproved',
    );
  }
  if (receipt.outcome !== 'clean' && scan.approvedReceipt === undefined) {
    const why =
      receipt.outcome === 'unscanned'
        ? 'could not read all of it'
        : 'found lines in it marked `aflow-scan: allow`';
    throw new ScanReceiptError(
      `The scan of \`${receipt.sha}\` ${why}, so it is pushed only once the operator has ` +
        'approved that scan, and this push carries no approval of it. Nothing was pushed.',
      'unapproved',
    );
  }
}
