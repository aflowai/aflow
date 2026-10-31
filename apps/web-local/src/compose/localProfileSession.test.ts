/**
 * The web process's half of the picker (Plan 335 P3). The front door shows the
 * picker only when the API refuses a browser for want of a profile session,
 * which an install with one profile never does. A choice becomes a session in
 * an `httpOnly` cookie only when the API issued one, and the call that asks
 * for it carries no browser mark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_BROWSER_CALLER_HEADER } from '@aflow/web-product';

import {
  PROFILE_SESSION_MAX_AGE_SEC,
  answerProfileChoice,
  readProfileChoices,
  requiresProfileChoice,
} from './localProfileSession.js';
import { INSTANCE_SECRET_ENV, PROFILE_SESSION_COOKIE } from './localWebIdentity.js';

vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));

const SECRET = 'a'.repeat(40);
const ADA = '00000000-0000-4000-8000-00000000a0a0';
const OWNER = {
  userId: '00000000-0000-4000-8000-0000000ed1c1',
  displayName: 'Local user',
  avatar: null,
  isOwner: true,
};

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env[INSTANCE_SECRET_ENV];
  process.env[INSTANCE_SECRET_ENV] = SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env[INSTANCE_SECRET_ENV];
  else process.env[INSTANCE_SECRET_ENV] = savedSecret;
});

function choice(userId: string, origin = 'http://127.0.0.1:3001'): Request {
  const form = new FormData();
  form.set('userId', userId);
  return new Request(`${origin}/profiles/choose`, { method: 'POST', body: form });
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

describe('when the front door shows the picker', () => {
  it('shows it when the API asks this browser to choose a profile', () => {
    expect(requiresProfileChoice({ status: 401, code: 'PROFILE_SESSION_REQUIRED' })).toBe(true);
    expect(requiresProfileChoice({ status: 401, code: 'PROFILE_SESSION_INVALID' })).toBe(true);
  });

  it('shows none for any other refusal', () => {
    expect(requiresProfileChoice({ status: 401, code: null })).toBe(false);
    expect(requiresProfileChoice({ status: 403, code: null })).toBe(false);
    expect(requiresProfileChoice({ status: 503, code: 'PROFILE_COUNT_UNREAD' })).toBe(false);
  });
});

describe('the profiles the picker lists', () => {
  it('are read with the instance secret and no browser mark', async () => {
    const fetchImpl = vi.fn(async () => json(200, { profiles: [OWNER] }));
    expect(await readProfileChoices(fetchImpl)).toEqual([OWNER]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/local-profiles\/picker$/);
    expect(headersOf(init)).toEqual({ authorization: `Bearer ${SECRET}` });
  });

  it('are unread when the API refuses or says something else', async () => {
    expect(await readProfileChoices(vi.fn(async () => json(401, {})))).toBeNull();
    expect(await readProfileChoices(vi.fn(async () => json(200, { nope: true })))).toBeNull();
    expect(
      await readProfileChoices(
        vi.fn(async () => {
          throw new Error('down');
        }),
      ),
    ).toBeNull();
  });
});

describe('choosing a profile', () => {
  it('keeps the issued session in an httpOnly cookie and enters the front door', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        profile: { userId: ADA, displayName: 'Ada', avatar: 'owl', isOwner: false },
        session: 'v2.issued',
      }),
    );
    const response = await answerProfileChoice(choice(ADA), fetchImpl);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3001/');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/v1/local-profiles/${ADA}/session$`));
    expect(init.method).toBe('POST');
    // The API hands a session only to a call without the browser mark.
    expect(headersOf(init)).not.toHaveProperty(LOCAL_BROWSER_CALLER_HEADER);
    expect(headersOf(init)).toEqual({ authorization: `Bearer ${SECRET}` });

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${PROFILE_SESSION_COOKIE}=`));
    expect(session).toContain(`${PROFILE_SESSION_COOKIE}=v2.issued`);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=lax/i);
    expect(session).toContain(`Max-Age=${String(PROFILE_SESSION_MAX_AGE_SEC)}`);
    expect(session).not.toMatch(/Secure/i);
    // The chosen profile keys its own preferred space.
    expect(cookies.find((c) => c.startsWith('aflow_profile='))).toContain(`aflow_profile=${ADA}`);
  });

  // One tap on a tile posts the profile's id and nothing else. That post
  // alone starts the profile.
  it('starts the profile from the tile post alone, with one bodiless call', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        profile: { userId: ADA, displayName: 'Ada', avatar: 'owl', isOwner: false },
        session: 'v2.issued',
      }),
    );
    const response = await answerProfileChoice(choice(ADA), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3001/');
    expect(
      response.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${PROFILE_SESSION_COOKIE}=v2.issued`)),
    ).toBe(true);
  });

  it('marks the cookies secure where the browser used HTTPS', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        profile: { userId: ADA, displayName: 'Ada', avatar: 'owl', isOwner: false },
        session: 'v2.issued',
      }),
    );
    const response = await answerProfileChoice(choice(ADA, 'https://localhost:3001'), fetchImpl);
    for (const cookie of response.headers.getSetCookie()) expect(cookie).toMatch(/Secure/i);
  });

  // Profiles have no PIN, so a PIN mark cookie a browser still holds is
  // cleared on its next choice, whichever profile it named.
  it('clears every PIN mark cookie the browser still holds', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        profile: { userId: ADA, displayName: 'Ada', avatar: 'owl', isOwner: false },
        session: 'v2.issued',
      }),
    );
    const request = choice(ADA, 'https://localhost:3001');
    request.headers.set(
      'cookie',
      `aflow_pin_mark_${ADA}=m1; theme=dark; aflow_pin_mark_${OWNER.userId}=m2`,
    );
    const response = await answerProfileChoice(request, fetchImpl);

    const cookies = response.headers.getSetCookie();
    for (const userId of [ADA, OWNER.userId]) {
      const cleared = cookies.find((c) => c.startsWith(`aflow_pin_mark_${userId}=`));
      expect(cleared).toMatch(new RegExp(`^aflow_pin_mark_${userId}=;`));
      expect(cleared).toContain('Max-Age=0');
      expect(cleared).toContain('Path=/');
      expect(cleared).toMatch(/Secure/i);
    }
    expect(cookies.some((c) => c.startsWith('theme='))).toBe(false);
  });

  it('clears no cookie it did not set when the browser holds no PIN mark', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        profile: { userId: ADA, displayName: 'Ada', avatar: 'owl', isOwner: false },
        session: 'v2.issued',
      }),
    );
    const response = await answerProfileChoice(choice(ADA), fetchImpl);
    expect(response.headers.getSetCookie().map((c) => c.split('=', 1)[0])).toEqual([
      PROFILE_SESSION_COOKIE,
      'aflow_profile',
    ]);
  });

  it('sets no cookie when the API issues no session, and goes back to the picker', async () => {
    const response = await answerProfileChoice(
      choice(ADA),
      vi.fn(async () => json(404, { error: 'NotFound' })),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://127.0.0.1:3001/profiles?unavailable=1');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('asks the API for nothing when the post names no profile', async () => {
    const fetchImpl = vi.fn();
    const response = await answerProfileChoice(
      new Request('http://127.0.0.1:3001/profiles/choose', { method: 'POST' }),
      fetchImpl,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
