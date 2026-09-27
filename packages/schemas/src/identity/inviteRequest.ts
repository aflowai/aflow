/**
 * The public request-access submission contract.
 *
 * Shared rather than duplicated because both ends enforce it: the web form
 * validates before submit, the API validates the body. Two copies drift, and
 * the drift is invisible until a visitor sees a green field rejected with a
 * 400 — a form that lies about its own rules on the one page that carries the
 * whole trust argument.
 */
import { z } from 'zod';

/** A backstop against a paste of a whole document, not a concision rule. */
export const USE_CASE_MAX_LENGTH = 2000;

export const INVITE_REQUEST_REFERRALS = [
  'A friend or colleague',
  'GitHub',
  'X / Twitter',
  'LinkedIn',
  'Hacker News',
  'Reddit',
  'Kaggle',
  'A search engine',
  'Somewhere else',
] as const;

export const InviteRequestReferralSchema = z.enum(INVITE_REQUEST_REFERRALS);
export type InviteRequestReferral = z.infer<typeof InviteRequestReferralSchema>;

/**
 * Mail domains where a dot in the local part is provably not significant, so
 * `f.o.o@` and `foo@` reach one inbox. Enumerated rather than guessed: every
 * other provider is treated as dot-significant, because collapsing an address
 * that a provider does distinguish would deduplicate two different people.
 */
const DOT_INSENSITIVE_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The form used for the pending-unique index and the per-email rate-limit
 * window — never for delivery. The address as typed is stored separately and
 * is what any invite is actually sent to.
 *
 * Plus-tag stripping applies to every domain. As an identity rule that is not
 * universally correct (a provider may treat `+` literally), but this value is
 * only ever a dedupe key, and two distinct people on one domain colliding on a
 * plus-tagged local part is not a shape that occurs.
 */
export function canonicalizeEmail(email: string): string {
  const lowered = email.trim().toLowerCase();
  const at = lowered.lastIndexOf('@');
  if (at <= 0 || at === lowered.length - 1) return lowered;

  let local = lowered.slice(0, at);
  const domain = lowered.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (DOT_INSENSITIVE_MAIL_DOMAINS.has(domain)) local = local.replaceAll('.', '');

  return local === '' ? lowered : `${local}@${domain}`;
}

/**
 * Names reserved by RFC 2606 / RFC 6761, plus mDNS `.local`, so they can never
 * hold a real mailbox. An address here cannot be replied to, which makes it a
 * request nobody can act on: approving it would mint an invite that bounces.
 * Refusing it at the door is what keeps it out of the queue, out of the admins'
 * inboxes, and off the sending reputation.
 */
const UNDELIVERABLE_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);
const UNDELIVERABLE_TLDS = ['test', 'example', 'invalid', 'localhost', 'local'];

export function isUndeliverableAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return true;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (UNDELIVERABLE_DOMAINS.has(domain)) return true;
  // Matched as a whole label, so a registrable domain that merely ends in the
  // reserved word (`example.company`) is still real mail.
  return UNDELIVERABLE_TLDS.some((tld) => domain === tld || domain.endsWith(`.${tld}`));
}

/**
 * Decides whether the admin queue may render a submitted link as an anchor.
 * The link is free text on the way in, so this is the XSS control that keeps a
 * `javascript:`/`data:` href out of the DOM; anything it rejects is shown as
 * plain text instead of being refused at submit time.
 */
export function linkLooksPublic(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.hostname.includes('.');
}

/**
 * Prepends the scheme a person leaves off when they paste a profile from the
 * address bar. Rejecting `github.com/ada` over a missing `https://` is the
 * kind of pedantry that loses a request we wanted.
 *
 * The scheme is added only when it yields a link the queue would actually
 * render. The field takes free text, so an answer like "my blog, ada.example.com"
 * arrives here too, and prefixing that stores prose the requester never wrote.
 */
export function normalizeLinkInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  const prefixed = `https://${trimmed}`;
  return linkLooksPublic(prefixed) ? prefixed : trimmed;
}

/**
 * An optional free-text answer. A blank field arrives as `''` from a form and
 * means "not answered", so it collapses to absent rather than storing an empty
 * string that reads as an answer in the admin queue.
 */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? undefined : value))
    .optional();
}

/**
 * The address is the only answer the flow cannot run without — every other
 * field helps the decision but never blocks the request.
 */
export const InviteRequestSubmissionSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .refine((value) => !isUndeliverableAddress(value), 'Use an address that can receive mail.'),
  name: optionalText(120),
  /** Anything public that gives a sense of the person — the trust anchor. */
  link: optionalText(500),
  /** One line: "CS student", "independent researcher", "designer at a studio". */
  occupation: optionalText(160),
  useCase: optionalText(USE_CASE_MAX_LENGTH),
  referral: InviteRequestReferralSchema.optional(),
  /**
   * Honeypot. Hidden offscreen and absent from every real submission, so any
   * value at all identifies an automated form filler. Never stored.
   */
  subject: z.string().max(200).optional(),
  /** Cloudflare Turnstile token; required wherever Turnstile is configured. */
  turnstileToken: z.string().max(2048).optional(),
});
export type InviteRequestSubmission = z.infer<typeof InviteRequestSubmissionSchema>;
