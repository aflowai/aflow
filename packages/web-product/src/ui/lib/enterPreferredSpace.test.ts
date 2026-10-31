/**
 * Which space a front door enters.
 *
 * The cookie is a hint that outlives what it names: a space is archived, or
 * access to it withdrawn, and the slug stays in the browser. Following it
 * unchecked lands on the access gate's 404 — on the first screen, in place of
 * the workspace the visitor does have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));

import {
  chooseSpaceSlug,
  enterPreferredSpace,
  resolveSpaceEntry,
  type SpaceLookup,
} from './enter-preferred-space.js';

beforeEach(() => {
  redirect.mockReset();
});

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

const API = 'http://api.test';
const lookup = (answer: Response, extra: Partial<SpaceLookup> = {}): SpaceLookup => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => answer),
  );
  return { apiUrl: API, headers: async () => ({}), ...extra };
};
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('entering a space', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The owner of a local install lists another profile's space as a name only.
  it('skips a space the visitor sees as a name only', async () => {
    const entry = await resolveSpaceEntry(
      '/chat',
      lookup(
        json(200, {
          spaces: [
            { slug: 'personal-ada', myRole: null },
            { slug: 'personal', myRole: 'admin' },
          ],
        }),
      ),
    );
    expect(entry).toBe('/s/personal/chat');
  });

  it('reports the refusal code the API sent', async () => {
    const report = vi.fn();
    await resolveSpaceEntry(
      '/chat',
      lookup(json(401, { error: 'Unauthorized', code: 'PROFILE_SESSION_REQUIRED' }), { report }),
    );
    expect(report).toHaveBeenCalledWith({
      kind: 'refused',
      status: 401,
      code: 'PROFILE_SESSION_REQUIRED',
    });
  });

  it('shows what the front door answers a refusal with, in place of a space', async () => {
    const answerRefusal = vi.fn(async () => 'the picker');
    const shown = await enterPreferredSpace(
      '/chat',
      lookup(json(401, { code: 'PROFILE_SESSION_REQUIRED' }), { answerRefusal }),
    );
    expect(shown).toBe('the picker');
    expect(answerRefusal).toHaveBeenCalledWith({
      kind: 'refused',
      status: 401,
      code: 'PROFILE_SESSION_REQUIRED',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('asks nothing of the answer when the lookup succeeds', async () => {
    const answerRefusal = vi.fn(async () => 'the picker');
    await enterPreferredSpace(
      '/chat',
      lookup(json(200, { spaces: [{ slug: 'personal', myRole: 'admin' }] }), { answerRefusal }),
    );
    expect(answerRefusal).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith('/s/personal/chat');
  });
});
