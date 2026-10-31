/**
 * The web process's half of the profile picker (Plan 335 P3).
 *
 * The picker is the only path that issues a profile session. A tile posts the
 * chosen profile here, this process asks the API for its session with the
 * instance secret, and the session goes into an `httpOnly` cookie. The API
 * answers that request only when it carries no browser mark, so the session
 * never passes through the proxy that a script in the page can call.
 *
 * Which profile the browser chose is also kept in a second cookie. It keys the
 * preferred space, so each profile lands in its own space, and authorizes
 * nothing.
 */
import { NextResponse } from 'next/server';

import {
  ACTIVE_PROFILE_COOKIE,
  LOCAL_PROFILE_CHOICE_FIELD,
  LOCAL_PROFILE_PICKER_PATH,
  LocalProfileChoicesResponseSchema,
  LocalProfileSessionResponseSchema,
  type LocalProfileChoice,
} from '@aflow/web-product';

import { isProfileSessionRefusal } from '@/compose/localRecovery';
import { instanceSecret, localApiUrl, PROFILE_SESSION_COOKIE } from '@/compose/localWebIdentity';

/**
 * A session lasts until the person switches profile or the browser clears it
 * (Plan 335 D1). This is the longest a browser keeps a cookie.
 */
export const PROFILE_SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 400;

/** The query the picker reads when a choice could not be completed. */
export const CHOICE_FAILED_PARAM = 'unavailable';

export const CHOICE_FAILED_MESSAGE =
  'That profile could not be opened. It may have been removed. Choose a profile again.';

type Fetch = typeof fetch;

/** The instance secret alone. A call made with it carries no browser mark. */
function secretHeaders(): Record<string, string> | null {
  const secret = instanceSecret();
  return secret === '' ? null : { Authorization: `Bearer ${secret}` };
}

/** Whether the API refused a browser because it must choose a profile first. */
export function requiresProfileChoice(refusal: { status: number; code: string | null }): boolean {
  return refusal.status === 401 && isProfileSessionRefusal(refusal.code);
}

/** The profiles a browser chooses from, the owner first, or null when the API did not say. */
export async function readProfileChoices(
  fetchImpl: Fetch = fetch,
): Promise<LocalProfileChoice[] | null> {
  const headers = secretHeaders();
  if (headers === null) return null;
  try {
    const response = await fetchImpl(`${localApiUrl()}/v1/local-profiles/picker`, {
      headers,
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const parsed = LocalProfileChoicesResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.profiles : null;
  } catch {
    return null;
  }
}

/** The session the API issued for the chosen profile, or null when it issued none. */
export async function issueProfileSession(
  userId: string,
  fetchImpl: Fetch = fetch,
): Promise<{ userId: string; session: string } | null> {
  const headers = secretHeaders();
  if (headers === null) return null;
  try {
    const response = await fetchImpl(
      `${localApiUrl()}/v1/local-profiles/${encodeURIComponent(userId)}/session`,
      { method: 'POST', headers, cache: 'no-store' },
    );
    if (!response.ok) return null;
    const parsed = LocalProfileSessionResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    return { userId: parsed.data.profile.userId, session: parsed.data.session };
  } catch {
    return null;
  }
}

/**
 * Answers a tile's post: the session and the chosen profile in cookies, then
 * the front door, which enters that profile's preferred space.
 *
 * A choice the API refused goes back to the picker with a notice, and the
 * browser keeps whatever session it held.
 */
export async function answerProfileChoice(
  request: Request,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const userId = form?.get(LOCAL_PROFILE_CHOICE_FIELD);
  const issued = typeof userId === 'string' ? await issueProfileSession(userId, fetchImpl) : null;
  if (issued === null) {
    const back = new URL(LOCAL_PROFILE_PICKER_PATH, request.url);
    back.searchParams.set(CHOICE_FAILED_PARAM, '1');
    return NextResponse.redirect(back, 303);
  }

  const response = NextResponse.redirect(new URL('/', request.url), 303);
  const cookie = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // The appliance serves loopback over plain HTTP unless a terminator sits
    // in front of it, so the scheme the browser used decides.
    secure: browserUsedHttps(request),
    maxAge: PROFILE_SESSION_MAX_AGE_SEC,
  } as const;
  response.cookies.set(PROFILE_SESSION_COOKIE, issued.session, cookie);
  response.cookies.set(ACTIVE_PROFILE_COOKIE, issued.userId, cookie);
  for (const name of stalePinMarkCookies(request)) {
    response.cookies.set(name, '', { ...cookie, maxAge: 0 });
  }
  return response;
}

const STALE_PIN_MARK_PREFIX = 'aflow_pin_mark_';

/**
 * The PIN mark cookies this browser still holds. Profiles have no PIN, so
 * nothing reads them, and a browser would otherwise keep each one for up to
 * `PROFILE_SESSION_MAX_AGE_SEC`.
 */
function stalePinMarkCookies(request: Request): string[] {
  const names = new Set<string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const name = part.split('=', 1)[0]?.trim() ?? '';
    if (name.startsWith(STALE_PIN_MARK_PREFIX)) names.add(name);
  }
  return [...names];
}

function browserUsedHttps(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded !== undefined && forwarded !== '') return forwarded === 'https';
  return new URL(request.url).protocol === 'https:';
}
