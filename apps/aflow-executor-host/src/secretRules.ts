/**
 * What a line that looks like a secret looks like.
 *
 * Each rule is a name, the reason it is a rule, and a test over one added line.
 * The test answers yes or no and nothing else: what matched is never returned,
 * so it cannot reach an output, a log or a store by way of a caller that
 * meant well.
 */

export interface SecretRule {
  /** What a finding reports as its `pattern`. */
  readonly name: string;
  /** Why a match is worth stopping a push for. */
  readonly reason: string;
  readonly matches: (line: string) => boolean;
}

/** The shortest value the generic assignment rule weighs; shorter is a word, not a key. */
export const GENERIC_SECRET_MIN_LENGTH = 16;
/**
 * Bits per character above which a value reads as random rather than written.
 * A random 16-character alphanumeric key sits near 3.9; an English phrase or a
 * placeholder such as `your-api-key-here` stays under it.
 */
export const GENERIC_SECRET_MIN_ENTROPY_BITS = 3.5;
/** The shortest `.env` value treated as a credential rather than a flag or a port. */
export const ENV_SECRET_MIN_LENGTH = 8;

/** The names a secret is kept under: secret, token, password, api key. */
const SECRET_NAME = `(?:${['secret', 'token', 'passw(?:or)?d', 'api[_-]?key'].join('|')})`;

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(value: string): number {
  const characters = [...value];
  if (characters.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of characters) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / characters.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function pattern(regex: RegExp): (line: string) => boolean {
  return (line) => regex.test(line);
}

const AWS_ACCESS_KEY_ID = /\bAKIA[0-9A-Z]{16}\b/;
const AWS_SECRET_NAMED = new RegExp(
  `aws[A-Za-z0-9_.-]*secret[A-Za-z0-9_.-]*["']?\\s*(?::=|=>|[:=])\\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`,
  'i',
);
const BASE64_40 = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/;

const GENERIC_ASSIGNMENT = new RegExp(
  `[A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*["']?\\s*(?::=|=>|[:=])\\s*(["'\`])([^"'\`\\s]+)\\1`,
  'gi',
);

/** `KEY=value` as a `.env` file writes it: an upper-case key, no spaces around `=`. */
const ENV_LINE =
  /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSW(?:OR)?D|API_?KEY)[A-Z0-9_]*=["']?([^\s"'#]*)/;

/**
 * A `.env` value that names where a secret comes from rather than holding one:
 * a reference to another variable, a `<placeholder>`, or words alone.
 */
function isEnvPlaceholder(value: string): boolean {
  return value.startsWith('$') || value.startsWith('<') || /^[A-Za-z_-]*$/.test(value);
}

/**
 * Ordered most specific first, because a line reports the first rule it
 * matches: a token with a known shape is named by its shape rather than by the
 * generic rules that would also catch it.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    name: 'private-key',
    reason: 'A private key block: whoever holds it can sign or decrypt as its owner.',
    matches: pattern(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/),
  },
  {
    name: 'aws-secret-access-key',
    reason: 'An AWS secret access key: with its key id it signs requests as that account.',
    matches: (line) =>
      AWS_SECRET_NAMED.test(line) || (AWS_ACCESS_KEY_ID.test(line) && BASE64_40.test(line)),
  },
  {
    name: 'aws-access-key-id',
    reason: 'An AWS access key id: half of a credential, and the half that says whose.',
    matches: pattern(AWS_ACCESS_KEY_ID),
  },
  {
    name: 'github-token',
    reason: 'A GitHub token: it acts on repositories as the account that issued it.',
    matches: pattern(/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/),
  },
  {
    name: 'slack-token',
    reason: 'A Slack token: it reads and posts in a workspace as its bot or user.',
    matches: pattern(/\bxox[abprs]-[A-Za-z0-9-]{10,}/),
  },
  {
    name: 'google-api-key',
    reason: 'A Google API key: it spends the quota and the bill of the project that owns it.',
    matches: pattern(/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/),
  },
  {
    name: 'stripe-live-key',
    reason: 'A Stripe live key: it moves real money on the account.',
    matches: pattern(/\b[sr]k_live_[0-9A-Za-z]{16,}\b/),
  },
  {
    name: 'jwt',
    reason: 'A JSON Web Token: a signed credential, good until it expires.',
    matches: pattern(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/),
  },
  {
    name: 'secret-assignment',
    reason:
      'A random-looking string assigned to a name that says secret, token, password or api key.',
    matches: (line) => {
      for (const match of line.matchAll(GENERIC_ASSIGNMENT)) {
        const value = match[2] ?? '';
        if (
          value.length >= GENERIC_SECRET_MIN_LENGTH &&
          shannonEntropy(value) > GENERIC_SECRET_MIN_ENTROPY_BITS
        ) {
          return true;
        }
      }
      return false;
    },
  },
  {
    name: 'env-secret',
    reason: 'A `.env` line giving a value to a key that says secret, token, password or api key.',
    matches: (line) => {
      const value = ENV_LINE.exec(line)?.[1] ?? '';
      return value.length >= ENV_SECRET_MIN_LENGTH && !isEnvPlaceholder(value);
    },
  },
];

/** The name of the first rule an added line matches, or nothing. */
export function matchingRule(line: string): string | undefined {
  return SECRET_RULES.find((rule) => rule.matches(line))?.name;
}
