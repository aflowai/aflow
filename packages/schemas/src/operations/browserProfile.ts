/**
 * A browser profile, as the machine that holds it declares it.
 *
 * Read by the host executor from its own policy file and relayed in the host
 * inventory. A workspace addresses a profile by id and can introduce none,
 * move none and change none: every field here is the operator's, written on
 * the machine.
 */
import { z } from 'zod';

/**
 * A profile id names a directory under the host directory, so it is held to
 * characters no path can climb out of.
 */
export const BrowserProfileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, {
  message:
    'A browser profile id is 1 to 64 letters, digits, `-` or `_`, starting with a letter or ' +
    'digit — it names the directory the profile keeps its sign-ins in.',
});

export const DEFAULT_BROWSER_PROFILE_ID = 'default';

export const BrowserPostureSchema = z
  .enum(['autonomous', 'ask-to-act', 'read-only'])
  .describe(
    '`autonomous`: navigation, reading and interaction run without asking. ' +
      '`ask-to-act`: reading and navigation run; every interaction waits for the operator. ' +
      '`read-only`: interaction is refused.',
  );
export type BrowserPosture = z.infer<typeof BrowserPostureSchema>;

/**
 * What an origin rule names: one origin exactly, or a host and every name
 * under it. Parsed in one place so the policy file is refused on the same
 * reading the executor later matches pages with.
 */
export type BrowserOriginPattern =
  | { readonly kind: 'origin'; readonly origin: string; readonly host: string }
  | { readonly kind: 'host_and_subdomains'; readonly host: string };

const HOST_LABELS =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const BROWSER_ORIGIN_PATTERN_HELP =
  'An origin rule names an exact origin such as `https://mail.example.com` — scheme, host and ' +
  'an optional port, with nothing after — or a host with a leading wildcard such as ' +
  '`*.example.com`, which matches example.com and every name under it on any scheme and port.';

/** The host as a pattern compares it: lower case, no trailing dot, no IPv6 brackets. */
export function normalizeBrowserHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[(.*)\]$/, '$1');
}

export function parseBrowserOriginPattern(pattern: string): BrowserOriginPattern | undefined {
  if (pattern.startsWith('*.')) {
    const host = pattern.slice(2).toLowerCase();
    return HOST_LABELS.test(host) ? { kind: 'host_and_subdomains', host } : undefined;
  }
  // Scheme and authority, nothing after, and no credentials in the authority.
  if (!/^https?:\/\/[^/?#@\s]+\/?$/i.test(pattern)) return undefined;
  let url: URL;
  try {
    url = new URL(pattern);
  } catch {
    return undefined;
  }
  return { kind: 'origin', origin: url.origin, host: normalizeBrowserHost(url.hostname) };
}

function hostMatches(pattern: BrowserOriginPattern, host: string): boolean {
  const candidate = normalizeBrowserHost(host);
  if (pattern.kind === 'origin') return candidate === pattern.host;
  return candidate === pattern.host || candidate.endsWith(`.${pattern.host}`);
}

/** Whether a page at `url` is one the pattern names. */
export function browserOriginPatternMatchesUrl(pattern: BrowserOriginPattern, url: URL): boolean {
  if (pattern.kind === 'origin') return url.origin === pattern.origin;
  return hostMatches(pattern, url.hostname);
}

/**
 * Whether a connection to `host`, on any port, reaches what the pattern names.
 * A connection carries no scheme, so an exact-origin pattern answers for its
 * whole host here: what a page cannot be opened at, it cannot fetch from.
 */
export function browserOriginPatternMatchesHost(
  pattern: BrowserOriginPattern,
  host: string,
): boolean {
  return hostMatches(pattern, host);
}

export const BrowserOriginRuleSchema = z.object({
  origin: z
    .string()
    .refine((value) => parseBrowserOriginPattern(value) !== undefined, {
      message: BROWSER_ORIGIN_PATTERN_HELP,
    })
    .describe(
      'An exact origin, such as `https://mail.example.com`, or a host with a leading wildcard, ' +
        'such as `*.example.com`, which also matches example.com itself.',
    ),
  effect: z
    .enum(['allow', 'ask', 'deny'])
    .describe(
      'What navigating to or acting on a page at this origin does, over the posture. `deny` ' +
        'also refuses every connection to its host, so no redirect, subresource or script ' +
        'reaches it. Where several rules match, the most restrictive one holds.',
    ),
});
export type BrowserOriginRule = z.infer<typeof BrowserOriginRuleSchema>;

/** Minutes a page, and then a browser with no pages, may sit untouched before it is closed. */
export const DEFAULT_BROWSER_IDLE_MINUTES = 30;

/** Minutes a hand-off waits for the operator before it returns `timed_out`. */
export const DEFAULT_BROWSER_HANDOFF_MINUTES = 15;

export const BrowserProfileSchema = z.object({
  id: BrowserProfileIdSchema,
  spaces: z
    .union([z.literal('all'), z.array(z.string().min(1))])
    .default('all')
    .describe('The spaces that may use this profile: `all`, or a list of space ids.'),
  posture: BrowserPostureSchema.default('autonomous'),
  rules: z.array(BrowserOriginRuleSchema).default([]),
  window: z
    .enum(['hidden', 'visible'])
    .default('hidden')
    .describe('`hidden` runs the browser headless; `visible` gives it a window on this machine.'),
  // A job does not yet carry whether a person started its run, so a profile
  // closed to unattended runs would be one this machine cannot keep closed.
  unattended: z
    .boolean()
    .default(true)
    .refine((value) => value, {
      message:
        '`unattended: false` is not enforced yet: this machine cannot tell a run someone ' +
        'started by hand from a scheduled or triggered one, so a profile cannot promise to ' +
        'refuse the second. Remove the setting; every run that may use the profile may use it ' +
        'unattended.',
    })
    .describe(
      'Whether a run nobody started by hand — a schedule, a trigger — may use it. Only `true` ' +
        'is accepted until that is enforced.',
    ),
  idleMinutes: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_BROWSER_IDLE_MINUTES)
    .describe(
      'A page nothing has touched for this long is closed, and a browser left with no pages ' +
        'for this long is stopped. Its sign-ins stay on disk.',
    ),
  handoffMinutes: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_BROWSER_HANDOFF_MINUTES)
    .describe(
      'How long a hand-off waits for the operator in the window before the run goes on without ' +
        'them.',
    ),
});
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;
