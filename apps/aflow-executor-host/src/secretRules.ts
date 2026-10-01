/**
 * What a line that looks like a secret looks like.
 *
 * Each rule is a name, the reason it is a rule, and a test over one added line.
 * The test answers yes or no and nothing else: what matched is never returned,
 * so it cannot reach an output, a log or a store by way of a caller that
 * meant well.
 *
 * Every test is linear in the line. A line is whatever the repository holds —
 * a minified bundle is one line of a megabyte — and the scan runs on the
 * executor's own thread, so a pattern that backtracks over a long line stalls
 * every job the lane holds. No pattern repeats a run of characters it could
 * also have matched one quantifier earlier, every run a rule may enter more
 * than once is bounded, and an unbounded run is only ever entered at its first
 * character.
 */

export interface SecretRule {
  /** What a finding reports as its `pattern`. */
  readonly name: string;
  /** Why a match is worth stopping a push for. */
  readonly reason: string;
  /** Which files the rule reads; absent, every file. */
  readonly appliesTo?: (file: string) => boolean;
  readonly matches: (line: string) => boolean;
}

/** The shortest value the value rules weigh; shorter is a word, not a key. */
export const SECRET_VALUE_MIN_LENGTH = 16;
/**
 * The longest value the value rules weigh. A credential under a name is a key,
 * not a document, and the bound is what keeps the assignment pattern linear.
 */
export const SECRET_VALUE_MAX_LENGTH = 512;
/**
 * Bits per character above which a value reads as random rather than written.
 * A random 16-character alphanumeric key sits near 3.9; an English phrase or a
 * placeholder such as `your-api-key-here` stays under it.
 */
export const SECRET_VALUE_MIN_ENTROPY_BITS = 3.5;

/**
 * What an operator writes in a comment on a line they have read, to let it
 * through: the line is reported as allowed instead of found.
 */
export const SCAN_ALLOW_MARKER = 'aflow-scan: allow';
const ALLOW_COMMENT = /(?:\/\/|\/\*|#|<!--|--)\s{0,8}aflow-scan:\s{0,8}allow\b/;

/** The names a secret is kept under: secret, token, password, api key. */
const SECRET_NAME = `(?:${['secret', 'token', 'passw(?:or)?d', 'api[_-]?key'].join('|')})`;
const SECRET_NAME_PATTERN = new RegExp(SECRET_NAME, 'i');

/**
 * Words that mark a value as standing in for a secret rather than being one.
 * `test-` covers fixtures such as `test-password-123`.
 */
const PLACEHOLDER_WORDS = ['example', 'changeme', 'xxx', 'test-', 'dummy'];

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  let length = 0;
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
    length += 1;
  }
  if (length === 0) return 0;
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Where one word of a written name ends and the next begins: `_`, `-`, `:`, `.`, `/`, space, `<`, `>`, `@`. */
const WORD_SEPARATORS = /[-_:./ <>@]+/;

/**
 * How many words a run of letters and digits holds, read the way a person
 * writes a name: a digit run is a word, a capital starts one, and a run of
 * capitals is one word up to the capital that starts a lower-case word.
 */
function wordCount(segment: string): number {
  let words = 0;
  let previous: 'upper' | 'lower' | 'digit' | undefined;
  for (let i = 0; i < segment.length; i += 1) {
    const character = segment[i] ?? '';
    const kind = /[0-9]/.test(character) ? 'digit' : /[A-Z]/.test(character) ? 'upper' : 'lower';
    const nextIsLower = /[a-z]/.test(segment[i + 1] ?? '');
    const starts =
      previous === undefined ||
      (kind === 'digit') !== (previous === 'digit') ||
      (kind === 'upper' && previous === 'lower') ||
      (kind === 'upper' && previous === 'upper' && nextIsLower);
    if (starts) words += 1;
    previous = kind;
  }
  return words;
}

/**
 * A segment that reads as generated rather than written: letters and digits
 * mixed, or letters that change case too often to be words. Short segments
 * are words or abbreviations either way.
 */
function looksGenerated(segment: string): boolean {
  if (segment.length < 6) return false;
  if (/[0-9]/.test(segment) && /[A-Za-z]/.test(segment)) return true;
  return segment.length / wordCount(segment) < 3;
}

/**
 * Words joined into a name — `workflow_run_tasks`, `dispatch:run-1:task-a:1`,
 * `stripeDefaultClientSecret` — rather than a key: more than one word, and no
 * part of it generated.
 */
function readsAsWords(value: string): boolean {
  const segments = value.split(WORD_SEPARATORS).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some(looksGenerated)) return false;
  return segments.length > 1 || wordCount(segments[0] ?? '') > 1;
}

/** Mostly a run of consecutive characters, as `0123456789abcdef` is: typed, not drawn. */
function readsAsSequence(value: string): boolean {
  let consecutive = 0;
  for (let i = 1; i < value.length; i += 1) {
    if (value.charCodeAt(i) - value.charCodeAt(i - 1) === 1) consecutive += 1;
  }
  return consecutive * 2 >= value.length - 1;
}

/**
 * Base64 of printable text, as a fixture encoding a JSON header or a phrase
 * is. Base64 of random bytes almost never decodes to printable text, so this
 * leaves keys alone; a password kept base64-encoded is the case it lets by.
 */
function readsAsEncodedText(value: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
}

/**
 * A value that is something other than a secret, whatever it is called: a
 * digest or a commit sha (all hex, which takes in all digits), a URL, a path,
 * a template or a variable that builds its value from others, a placeholder,
 * words joined into a name, a typed sequence, or encoded text.
 */
export function isNonSecretValue(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /^[0-9a-f]+$/i.test(value) ||
    /^[a-z][a-z0-9+.-]{0,30}:\/\//i.test(value) ||
    /^(?:\/|\.{1,2}\/|~\/|[a-z]:\\)/i.test(value) ||
    value.includes('${') ||
    value.startsWith('$') ||
    value.startsWith('<') ||
    PLACEHOLDER_WORDS.some((word) => lower.includes(word)) ||
    readsAsWords(value) ||
    readsAsSequence(value) ||
    readsAsEncodedText(value)
  );
}

/** A value long enough and random enough to be a key, and nothing else first. */
function looksLikeSecretValue(value: string): boolean {
  return (
    value.length >= SECRET_VALUE_MIN_LENGTH &&
    value.length <= SECRET_VALUE_MAX_LENGTH &&
    !isNonSecretValue(value) &&
    shannonEntropy(value) > SECRET_VALUE_MIN_ENTROPY_BITS
  );
}

/** `.env`, `.env.<anything>` or `<anything>.env`: where `KEY=value` holds configuration. */
export function isEnvFile(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

function pattern(regex: RegExp): (line: string) => boolean {
  return (line) => regex.test(line);
}

const AWS_ACCESS_KEY_ID = /\bAKIA[0-9A-Z]{16}\b/;
const AWS_SECRET_NAMED = new RegExp(
  `aws[A-Za-z0-9_.-]{0,32}secret[A-Za-z0-9_.-]{0,32}["']?\\s{0,8}(?::=|=>|[:=])\\s{0,8}["']?` +
    `[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`,
  'i',
);
const BASE64_40 = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/;

/**
 * A secret-looking name, the rest of its identifier, an assignment, and a
 * quoted literal. Anchored on the name rather than the identifier's start, so
 * no run of identifier characters is matched twice.
 */
const SECRET_ASSIGNMENT = new RegExp(
  `${SECRET_NAME}[A-Za-z0-9_.-]{0,64}["']?\\s{0,8}(?::=|=>|[:=])\\s{0,8}` +
    `(["'\`])([^"'\`\\s]{1,${String(SECRET_VALUE_MAX_LENGTH)}})\\1`,
  'gi',
);

/** `KEY=value` as a `.env` file writes it. The key is a run that cannot contain `=`, so it is read once. */
const ENV_LINE = /^\s{0,64}(?:export\s{1,8})?([A-Za-z_][A-Za-z0-9_.]{0,127})=(.*)$/;

/** The value an `.env` line gives, without its quotes or a trailing comment. */
function envValue(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  const comment = trimmed.search(/\s#/);
  return comment === -1 ? trimmed : trimmed.slice(0, comment);
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
    matches: pattern(/-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----/),
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
    matches: pattern(/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22})/),
  },
  {
    name: 'slack-token',
    reason: 'A Slack token: it reads and posts in a workspace as its bot or user.',
    matches: pattern(/(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10}/),
  },
  {
    name: 'google-api-key',
    reason: 'A Google API key: it spends the quota and the bill of the project that owns it.',
    matches: pattern(/(?<![0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/),
  },
  {
    name: 'stripe-live-key',
    reason: 'A Stripe live key: it moves real money on the account.',
    matches: pattern(/(?<![0-9A-Za-z_])[sr]k_live_[0-9A-Za-z]{16}/),
  },
  {
    name: 'jwt',
    reason: 'A JSON Web Token: a signed credential, good until it expires.',
    // A segment's characters exclude the dot that ends it and the lookbehind
    // admits only the first character of a run, so each run is entered once.
    matches: pattern(
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8}/,
    ),
  },
  {
    name: 'env-secret',
    reason:
      'A random-looking value given in a `.env` file to a key that says secret, token, password or api key.',
    appliesTo: isEnvFile,
    matches: (line) => {
      const parsed = ENV_LINE.exec(line);
      if (parsed?.[1] === undefined || !SECRET_NAME_PATTERN.test(parsed[1])) return false;
      return looksLikeSecretValue(envValue(parsed[2] ?? ''));
    },
  },
  {
    name: 'secret-assignment',
    reason:
      'A random-looking string literal assigned to a name that says secret, token, password or api key.',
    matches: (line) => {
      for (const match of line.matchAll(SECRET_ASSIGNMENT)) {
        if (looksLikeSecretValue(match[2] ?? '')) return true;
      }
      return false;
    },
  },
];

/** What one added line holds: the first rule it matches, and whether a comment on it allows it. */
export interface LineVerdict {
  readonly rule: string;
  readonly allowed: boolean;
}

/** The first rule a line added to `file` matches, or nothing. */
export function scanLine(file: string, line: string): LineVerdict | undefined {
  const rule = SECRET_RULES.find(
    (candidate) =>
      (candidate.appliesTo === undefined || candidate.appliesTo(file)) && candidate.matches(line),
  );
  if (rule === undefined) return undefined;
  return { rule: rule.name, allowed: ALLOW_COMMENT.test(line) };
}
