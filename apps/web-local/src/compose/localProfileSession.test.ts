/**
 * The web process's half of the picker (Plan 335 P3). The front door shows the
 * picker only when the API refuses a browser for want of a profile session,
 * which an install with one profile never does. A choice becomes a session in
 * an `httpOnly` cookie only when the API issued one, and the call that asks
 * for it carries no browser mark.
 *
 * Plan 335 P4: a locked profile's PIN goes to the API with the choice, and a
 * refused PIN returns to that profile's prompt with no cookie set.
 * A throttled PIN carries its wait to the prompt, and a PIN mark keys the
 * browser's own count of wrong PINs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_BROWSER_CALLER_HEADER } from '@aflow/web-product';

import {
  PROFILE_SESSION_MAX_AGE_SEC,
  answerProfileChoice,
  pinMarkCookie,
  readProfileChoices,
  requiresProfileChoice,
  unlockingFrom,
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
  hasPin: false,
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

function choice(
  userId: string,
  origin = 'http://127.0.0.1:3001',
  pin?: string,
  cookie?: string,
): Request {
  const form = new FormData();
  form.set('userId', userId);
  if (pin !== undefined) form.set('pin', pin);
  return new Request(`${origin}/profiles/choose`, {
    method: 'POST',
    body: form,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
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
        profile: { userId: ADA, displayName: 'Ada', avatar: 'owl', isOwner: false, hasPin: false },
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

  it('marks the cookies secure where the browser used HTTPS', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        profile: { userId: ADA, displayName: 'Ada', avatar: 'owl', isOwner: false, hasPin: false },
        session: 'v2.issued',
      }),
    );
    const response = await answerProfileChoice(choice(ADA, 'https://localhost:3001'), fetchImpl);
    for (const cookie of response.headers.getSetCookie()) expect(cookie).toMatch(/Secure/i);
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

describe('choosing a locked profile', () => {
  const LOCKED = {
    userId: ADA,
    displayName: 'Ada',
    avatar: 'owl' as const,
    isOwner: false,
    hasPin: true,
  };

  it('sends the PIN to the API in the body, with no browser mark', async () => {
    const fetchImpl = vi.fn(async () => json(200, { profile: LOCKED, session: 'v2.issued' }));
    const response = await answerProfileChoice(choice(ADA, undefined, '2468'), fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ pin: '2468' });
    expect(headersOf(init)).toEqual({
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    });
    expect(
      response.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${PROFILE_SESSION_COOKIE}=v2.issued`)),
    ).toBe(true);
  });

  it.each([
    ['PROFILE_PIN_REQUIRED', 401, 'required'],
    ['PROFILE_PIN_INCORRECT', 401, 'incorrect'],
    ['PROFILE_PIN_THROTTLED', 429, 'throttled'],
  ] as const)('returns %s to the PIN prompt and sets no cookie', async (code, status, error) => {
    const response = await answerProfileChoice(
      choice(ADA, undefined, '0000'),
      vi.fn(async () => json(status, { error: 'Unauthorized', code })),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `http://127.0.0.1:3001/profiles?unlock=${ADA}&pin=${error}`,
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('carries the wait a throttled PIN was answered with to the prompt', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000 * 1000);
    try {
      const response = await answerProfileChoice(
        choice(ADA, undefined, '0000'),
        vi.fn(async () => {
          const refused = json(429, { error: 'TooManyRequests', code: 'PROFILE_PIN_THROTTLED' });
          refused.headers.set('retry-after', '240');
          return refused;
        }),
      );
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.searchParams.get('pin')).toBe('throttled');
      expect(location.searchParams.get('until')).toBe(String(1_000_000_000 + 240));
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the PIN mark a right PIN returns, and sends it back with the next PIN', async () => {
    const issued = vi.fn(async () =>
      json(200, { profile: LOCKED, session: 'v2.issued', pinMark: 'm1.mark' }),
    );
    const first = await answerProfileChoice(choice(ADA, undefined, '2468'), issued);
    const mark = first.headers.getSetCookie().find((c) => c.startsWith(`${pinMarkCookie(ADA)}=`));
    expect(mark).toContain(`${pinMarkCookie(ADA)}=m1.mark`);
    expect(mark).toMatch(/HttpOnly/i);

    const again = vi.fn(async () => json(401, { code: 'PROFILE_PIN_INCORRECT' }));
    await answerProfileChoice(
      choice(ADA, undefined, '0000', `other=1; ${pinMarkCookie(ADA)}=m1.mark`),
      again,
    );
    const [, init] = again.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ pin: '0000', pinMark: 'm1.mark' });
  });

  it('sends no PIN mark without a PIN', async () => {
    const fetchImpl = vi.fn(async () => json(401, { code: 'PROFILE_PIN_REQUIRED' }));
    await answerProfileChoice(
      choice(ADA, undefined, undefined, `${pinMarkCookie(ADA)}=m1.mark`),
      fetchImpl,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('counts the remaining wait from the time in the URL', () => {
    expect(unlockingFrom([OWNER, LOCKED], ADA, 'throttled', '1240', 1000)).toEqual({
      profile: LOCKED,
      error: { error: 'throttled', retryAfterSec: 240 },
    });
    expect(unlockingFrom([OWNER, LOCKED], ADA, 'throttled', '1000', 1000)).toEqual({
      profile: LOCKED,
      error: null,
    });
    for (const until of [undefined, 'soon', ['1240']]) {
      expect(unlockingFrom([OWNER, LOCKED], ADA, 'throttled', until, 1000)).toEqual({
        profile: LOCKED,
        error: { error: 'throttled', retryAfterSec: null },
      });
    }
  });

  it('asks the PIN only for a profile that has one', () => {
    const open = { ...LOCKED, hasPin: false };
    expect(unlockingFrom([OWNER, LOCKED], ADA, undefined)).toEqual({
      profile: LOCKED,
      error: null,
    });
    expect(unlockingFrom([OWNER, LOCKED], ADA, 'incorrect')).toEqual({
      profile: LOCKED,
      error: { error: 'incorrect', retryAfterSec: null },
    });
    expect(unlockingFrom([OWNER, LOCKED], ADA, 'made-up')).toEqual({
      profile: LOCKED,
      error: null,
    });
    expect(unlockingFrom([OWNER, open], ADA, undefined)).toBeNull();
    expect(unlockingFrom([OWNER, LOCKED], undefined, undefined)).toBeNull();
  });
});
