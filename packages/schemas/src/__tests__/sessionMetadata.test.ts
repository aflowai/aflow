import { describe, it, expect } from 'vitest';
import {
  CLERK_AUTO,
  CLERK_SPACE_DEFAULT,
  DEFAULT_CYBERNETIC_MODEL,
  DirectiveModelDefaultsSchema,
  SESSION_FALLBACK_TITLE_MAX,
  deriveFallbackSessionTitle,
  evaluateSessionMetadataEligibility,
  isSubstantiveRequest,
  normalizeSessionLabel,
  resolveClerkAssignment,
  resolveClerkReasoning,
  resolveRoleModel,
  clerkCandidateRefs,
} from '../index.js';

describe('deterministic conversation names', () => {
  it('keeps a short request whole', () => {
    expect(deriveFallbackSessionTitle('Investigate the missing invoices')).toBe(
      'Investigate the missing invoices',
    );
  });

  it('cuts a long request on a word boundary and stores no ellipsis', () => {
    const long =
      'Summarize every support ticket we received last quarter and group them by root cause please';
    const title = deriveFallbackSessionTitle(long)!;
    expect(title.length).toBeLessThanOrEqual(SESSION_FALLBACK_TITLE_MAX);
    // The UI owns truncation of whatever it is given; a stored ellipsis would
    // be truncated a second time.
    expect(title.endsWith('\u2026')).toBe(false);
    expect(long.startsWith(title)).toBe(true);
  });

  it('strips the characters that make a one-line label misbehave', () => {
    // A bidi override surviving into a list row renders as something other
    // than what it says.
    expect(normalizeSessionLabel('Refund\u202e flow  fix')).toBe('Refund flow fix');
  });

  it('has nothing to say about an empty request', () => {
    expect(deriveFallbackSessionTitle('')).toBeNull();
    expect(deriveFallbackSessionTitle(null)).toBeNull();
    expect(deriveFallbackSessionTitle('   ')).toBeNull();
  });
});

describe('substantive request detection', () => {
  it('reads a greeting as no subject, in several languages', () => {
    for (const greeting of [
      'hi',
      'Hello!',
      'hey',
      'salut',
      '\u4f60\u597d',
      '\u043f\u0440\u0438\u0432\u0435\u0442',
    ]) {
      expect(isSubstantiveRequest(greeting), greeting).toBe(false);
    }
  });

  it('reads anything with a subject as substantive', () => {
    expect(isSubstantiveRequest('hi, can you look at the invoices?')).toBe(true);
    expect(isSubstantiveRequest('Analyse le rapport trimestriel')).toBe(true);
  });
});

describe('metadata eligibility', () => {
  const SPACE = '11111111-1111-4111-8111-111111111111';

  it('names a conversation someone has spoken in', () => {
    expect(
      evaluateSessionMetadataEligibility({ spaceId: SPACE, lastActivityAt: Date.now() }),
    ).toEqual({ eligible: true });
  });

  it('leaves a Runner, a schedule and a delegated brief alone', () => {
    // None of them acquire an activity clock, which is the whole gate - no
    // enumeration of session kinds is maintained anywhere.
    expect(evaluateSessionMetadataEligibility({ spaceId: SPACE, lastActivityAt: null })).toEqual({
      eligible: false,
      reason: 'no_human_activity',
    });
  });

  it('excludes an evaluation replay outright', () => {
    expect(
      evaluateSessionMetadataEligibility({
        spaceId: SPACE,
        lastActivityAt: Date.now(),
        trigger: 'eval',
      }),
    ).toEqual({ eligible: false, reason: 'eval' });
  });

  it('has nowhere to resolve a model for a session with no space', () => {
    expect(
      evaluateSessionMetadataEligibility({ spaceId: null, lastActivityAt: Date.now() }),
    ).toEqual({ eligible: false, reason: 'no_space' });
  });
});

describe('Clerk assignment', () => {
  it('reads an unset Clerk as auto, not as the space default', () => {
    // The whole point of the role: inheriting would put a reasoning-tier model
    // on every two-sentence summary.
    expect(resolveClerkAssignment({ default: 'sonnet' })).toEqual({ mode: 'auto' });
    expect(resolveClerkAssignment(undefined)).toEqual({ mode: 'auto' });
    expect(resolveClerkAssignment({ default: 'sonnet', clerk: CLERK_AUTO })).toEqual({
      mode: 'auto',
    });
  });

  it('resolves the space-default mode to the actual default', () => {
    expect(resolveClerkAssignment({ default: 'sonnet', clerk: CLERK_SPACE_DEFAULT })).toEqual({
      mode: 'space_default',
      model: 'sonnet',
    });
    expect(
      resolveClerkAssignment({ default: DEFAULT_CYBERNETIC_MODEL, clerk: CLERK_SPACE_DEFAULT }),
    ).toEqual({ mode: 'space_default', model: DEFAULT_CYBERNETIC_MODEL });
  });

  it('passes an explicit model through', () => {
    expect(resolveClerkAssignment({ default: 'sonnet', clerk: 'haiku' })).toEqual({
      mode: 'explicit',
      model: 'haiku',
    });
  });

  it('keeps the Clerk out of the role chain every other role walks', () => {
    // `resolveRoleModel` cannot be called with 'clerk' at the type level; this
    // pins the behaviour that type is protecting.
    const defaults = DirectiveModelDefaultsSchema.parse({ default: 'sonnet', clerk: 'haiku' });
    expect(resolveRoleModel(defaults, 'helmsman')).toBe('sonnet');
    expect(resolveClerkAssignment(defaults)).toEqual({ mode: 'explicit', model: 'haiku' });
  });

  it('defaults Clerk reasoning off, independently of the space default', () => {
    expect(resolveClerkReasoning({ default: 'high' })).toBe('off');
    expect(resolveClerkReasoning({ default: 'high', clerk: 'low' })).toBe('low');
  });
});

describe('Clerk candidates', () => {
  it('names the curated economical model for each provider, best first', () => {
    expect(clerkCandidateRefs('fireworks')).toEqual(['glm-flash']);
    expect(clerkCandidateRefs('google')).toEqual(['flash-lite', 'flash']);
  });

  it('knows nothing about a provider with no curated candidate', () => {
    expect(clerkCandidateRefs('runware')).toEqual([]);
  });
});
