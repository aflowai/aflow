/**
 * The key a receipt this executor issues is signed with, and how it is read
 * back.
 *
 * Drawn when the executor starts and never written down, so a receipt is good
 * only on the process that issued it. Every kind of receipt is signed with it,
 * the kind folded into what is signed: a scan's receipt never reads as a
 * check's, whatever its fields happen to hold.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** What a receipt attests to. */
export type ReceiptKind = 'scan' | 'check';

/**
 * How long a receipt is good for. Long enough for an approval asked in the
 * evening to be given the next morning; past it, the commit is read again.
 */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

const RECEIPT_KEY = randomBytes(32);

function sign(kind: ReceiptKind, body: string): Buffer {
  return createHmac('sha256', RECEIPT_KEY).update(`${kind}\n${body}`).digest();
}

export function signReceipt(
  kind: ReceiptKind,
  fields: ReadonlyArray<string | number | null>,
): string {
  const body = Buffer.from(JSON.stringify(fields)).toString('base64url');
  return `${body}.${sign(kind, body).toString('base64url')}`;
}

/** The fields a token carries, or nothing unless this process signed it as `kind`. */
export function readSignedReceipt(kind: ReceiptKind, token: string): unknown[] | undefined {
  const [body, mac, extra] = token.split('.');
  if (body === undefined || mac === undefined || extra !== undefined) return undefined;
  const expected = sign(kind, body);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  const fields: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return Array.isArray(fields) ? (fields as unknown[]) : undefined;
}

/** Whether a receipt issued at `issuedAt` is past its day, or dated after now. */
export function receiptExpired(issuedAt: number, now: number): boolean {
  return now - issuedAt > RECEIPT_TTL_MS || issuedAt > now;
}
