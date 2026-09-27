/**
 * Which space a front door enters.
 *
 * The cookie is a hint that outlives what it names: a space is archived, or
 * access to it withdrawn, and the slug stays in the browser. Following it
 * unchecked lands on the access gate's 404 — on the first screen, in place of
 * the workspace the visitor does have.
 */
import { describe, expect, it } from 'vitest';

import { chooseSpaceSlug } from './enter-preferred-space.js';

describe('choosing a space to enter', () => {
  it('keeps a hint the visitor can still reach', () => {
    expect(chooseSpaceSlug('beta', ['alpha', 'beta'])).toBe('beta');
  });

  it('drops a hint that names a space they cannot', () => {
    expect(chooseSpaceSlug('archived', ['alpha', 'beta'])).toBe('alpha');
  });

  it('takes the first reachable space when nothing is hinted', () => {
    expect(chooseSpaceSlug(null, ['alpha', 'beta'])).toBe('alpha');
  });

  it('enters nothing when the visitor reaches nothing', () => {
    // An empty set is an answer, not a failure to ask: a hint here names a
    // space they have lost, and following it would 404.
    expect(chooseSpaceSlug('archived', [])).toBeNull();
    expect(chooseSpaceSlug(null, [])).toBeNull();
  });

  it('trusts the hint when the question could not be asked', () => {
    // No credential, or an API that did not answer. A hint is better than a
    // door that refuses to open.
    expect(chooseSpaceSlug('beta', null)).toBe('beta');
    expect(chooseSpaceSlug(null, null)).toBeNull();
  });
});
