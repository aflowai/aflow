/**
 * What a profile's posture and origin rules let a run do on a page (D7).
 *
 * Decided on the origin of the page — read from the page at the moment of the
 * action for an action, and the destination for a navigation — never on
 * anything the request says about where it is. Of the rules that match, the
 * most restrictive holds, so a broad `deny` cannot be narrowed by a narrower
 * `allow` written beside it.
 */
import {
  type BrowserOriginRule,
  type BrowserProfile,
  browserOriginPatternMatchesHost,
  browserOriginPatternMatchesUrl,
  parseBrowserOriginPattern,
} from '@aflow/schemas';

import { BrowserDriverError } from './errors.js';

type Effect = BrowserOriginRule['effect'];

const RESTRICTION: Readonly<Record<Effect, number>> = { allow: 0, ask: 1, deny: 2 };

const ASKING_NOT_AVAILABLE =
  'Asking the operator before a browser action is not available yet, so this is refused rather ' +
  'than paused.';

function strictest(
  rules: readonly BrowserOriginRule[],
  matches: (rule: BrowserOriginRule) => boolean,
): BrowserOriginRule | undefined {
  let held: BrowserOriginRule | undefined;
  for (const rule of rules) {
    if (!matches(rule)) continue;
    if (held === undefined || RESTRICTION[rule.effect] > RESTRICTION[held.effect]) held = rule;
  }
  return held;
}

function ruleForUrl(profile: BrowserProfile, url: URL): BrowserOriginRule | undefined {
  return strictest(profile.rules, (rule) => {
    const pattern = parseBrowserOriginPattern(rule.origin);
    return pattern !== undefined && browserOriginPatternMatchesUrl(pattern, url);
  });
}

function refusedByRule(
  profile: BrowserProfile,
  rule: BrowserOriginRule,
  origin: string,
  doing: string,
): BrowserDriverError {
  if (rule.effect === 'ask') {
    return new BrowserDriverError(
      'ask_unavailable',
      `Browser profile \`${profile.id}\` asks the operator before ${doing} ${origin} (rule ` +
        `\`${rule.origin}\`). ${ASKING_NOT_AVAILABLE}`,
      { origin, rule: rule.origin },
    );
  }
  return new BrowserDriverError(
    'origin_denied',
    `Browser profile \`${profile.id}\` does not allow ${doing} ${origin}: the operator's rule ` +
      `\`${rule.origin}\` denies it. Rules are set on the machine.`,
    { origin, rule: rule.origin },
  );
}

/** Navigation runs under every posture; only a `deny` or `ask` rule on the destination stops it. */
export function assertNavigationAllowed(profile: BrowserProfile, destination: URL): void {
  const rule = ruleForUrl(profile, destination);
  if (rule !== undefined && rule.effect !== 'allow') {
    throw refusedByRule(profile, rule, destination.origin, 'opening pages at');
  }
}

/** An interaction, gated on where the page is now. An `allow` rule lifts the posture for its origin. */
export function assertActionAllowed(profile: BrowserProfile, pageUrl: URL): void {
  const rule = ruleForUrl(profile, pageUrl);
  if (rule !== undefined) {
    if (rule.effect === 'allow') return;
    throw refusedByRule(profile, rule, pageUrl.origin, 'acting on pages at');
  }
  if (profile.posture === 'read-only') {
    throw new BrowserDriverError(
      'posture_refused',
      `Browser profile \`${profile.id}\` is read-only: it opens, moves and reads pages but does ` +
        `not act on them. The page is at ${pageUrl.origin}. The posture is set on the machine.`,
      { origin: pageUrl.origin, posture: profile.posture },
    );
  }
  if (profile.posture === 'ask-to-act') {
    throw new BrowserDriverError(
      'ask_unavailable',
      `Browser profile \`${profile.id}\` asks the operator before every action on a page. ` +
        ASKING_NOT_AVAILABLE,
      { origin: pageUrl.origin, posture: profile.posture },
    );
  }
}

/**
 * Why the egress proxy refuses connections to `host`, or nothing. A `deny`
 * reaches the connection so that no redirect, subresource or script gets
 * there either; `ask` is held to the same until asking exists.
 */
export function ruleRefusingHost(profile: BrowserProfile, host: string): string | undefined {
  const rule = strictest(profile.rules, (candidate) => {
    const pattern = parseBrowserOriginPattern(candidate.origin);
    return pattern !== undefined && browserOriginPatternMatchesHost(pattern, host);
  });
  if (rule === undefined || rule.effect === 'allow') return undefined;
  return `${host} is under the operator's rule \`${rule.origin}\` (${rule.effect})`;
}
