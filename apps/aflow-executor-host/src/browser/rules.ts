/**
 * What a profile's posture and origin rules let a run do on a page (D7).
 *
 * Decided on the origin of the page — read from the page, and from the frame
 * the element is in, at the moment of the action for an action, and the
 * destination for a navigation — never on
 * anything the request says about where it is. Of the rules that match, the
 * most restrictive holds, so a broad `deny` cannot be narrowed by a narrower
 * `allow` written beside it.
 */
import {
  type BrowserApprovalAskedBy,
  type BrowserOriginRule,
  type BrowserProfile,
  browserOriginPatternMatchesHost,
  browserOriginPatternMatchesUrl,
  parseBrowserOriginPattern,
} from '@aflow/schemas';

import { BrowserDriverError } from './errors.js';

type Effect = BrowserOriginRule['effect'];

const RESTRICTION: Readonly<Record<Effect, number>> = { allow: 0, ask: 1, deny: 2 };

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
      'origin_asks',
      `Browser profile \`${profile.id}\` asks the operator before acting on pages at ${origin} ` +
        `(rule \`${rule.origin}\`), and does not load pages there: its egress proxy serves ` +
        'every page of the profile at once, so it cannot let the one page an operator approved ' +
        'reach that site without letting the others. Rules are set on the machine.',
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

/**
 * Navigation runs under every posture; only a `deny` or `ask` rule on the
 * destination stops it. An `ask` refuses rather than asks (D7, as built): a
 * connection to the site cannot be tied to the page an approval named.
 */
export function assertNavigationAllowed(profile: BrowserProfile, destination: URL): void {
  const rule = ruleForUrl(profile, destination);
  if (rule !== undefined && rule.effect !== 'allow') {
    throw refusedByRule(profile, rule, destination.origin, 'opening pages at');
  }
}

/** Whether an action runs at once or waits for the operator, and what made it wait. */
export type ActionGate =
  | { readonly verdict: 'run' }
  | { readonly verdict: 'ask'; readonly askedBy: BrowserApprovalAskedBy };

const RUNS: ActionGate = { verdict: 'run' };

/**
 * An interaction, gated on where the page is now and on the frame the element
 * belongs to, when that frame is from another origin. An \`allow\` rule lifts
 * the posture for its own origin only, so a rule for a page does not reach an
 * embedded site. A refusal throws; an ask is returned, for the caller to put
 * to the operator once the element and value are known.
 */
export function gateAction(profile: BrowserProfile, pageUrl: URL, frameUrl?: URL): ActionGate {
  const onPage = gateActionAt(profile, pageUrl, `The page is at ${pageUrl.origin}.`);
  if (frameUrl === undefined || frameUrl.origin === pageUrl.origin) return onPage;
  const inFrame = gateActionAt(
    profile,
    frameUrl,
    `The element is inside a frame from ${frameUrl.origin}, on a page at ${pageUrl.origin}; ` +
      'what the rules allow on the page does not reach a frame from another origin.',
  );
  return inFrame.verdict === 'ask' ? inFrame : onPage;
}

function gateActionAt(profile: BrowserProfile, url: URL, where: string): ActionGate {
  const rule = ruleForUrl(profile, url);
  if (rule !== undefined) {
    if (rule.effect === 'allow') return RUNS;
    if (rule.effect === 'ask')
      return { verdict: 'ask', askedBy: { kind: 'rule', rule: rule.origin } };
    throw refusedByRule(profile, rule, url.origin, 'acting on pages at');
  }
  if (profile.posture === 'read-only') {
    throw new BrowserDriverError(
      'posture_refused',
      `Browser profile \`${profile.id}\` is read-only: it opens, moves and reads pages but does ` +
        `not act on them. ${where} The posture is set on the machine.`,
      { origin: url.origin, posture: profile.posture },
    );
  }
  if (profile.posture === 'ask-to-act') return { verdict: 'ask', askedBy: { kind: 'posture' } };
  return RUNS;
}

/**
 * An action that would ask, from a caller that cannot wait for the answer: a
 * coding harness's call through its relay runs inside the harness's turn,
 * which no Action Center item can pause.
 */
export function askUnanswerable(profile: BrowserProfile, origin: string): BrowserDriverError {
  return new BrowserDriverError(
    'ask_unanswerable',
    `Browser profile \`${profile.id}\` asks the operator before acting on pages at ${origin}, ` +
      'and a coding harness cannot wait for an answer, so nothing was done. A harness acts on ' +
      'the ephemeral profile, or on a profile whose posture and rules let it act without asking.',
    { origin, profileId: profile.id },
  );
}

/**
 * Why the egress proxy refuses connections to `host`, or nothing. A `deny`
 * reaches the connection so that no redirect, subresource or script gets
 * there either. `ask` is held to the same: the proxy serves every page of the
 * profile, and a connection says nothing of which page made it, so admitting
 * the site for the one page an operator approved would admit it for all.
 */
export function ruleRefusingHost(profile: BrowserProfile, host: string): string | undefined {
  const rule = strictest(profile.rules, (candidate) => {
    const pattern = parseBrowserOriginPattern(candidate.origin);
    return pattern !== undefined && browserOriginPatternMatchesHost(pattern, host);
  });
  if (rule === undefined || rule.effect === 'allow') return undefined;
  return `${host} is under the operator's rule \`${rule.origin}\` (${rule.effect})`;
}
