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
 *
 * A locked profile's tile opens the PIN prompt instead of posting (Plan 335
 * P4). The prompt posts here with the PIN, and the API decides whether it is
 * right. A refused PIN returns to the prompt and sets no cookie.
 */
import { NextResponse } from 'next/server';

import {
  ACTIVE_PROFILE_COOKIE,
  LOCAL_PROFILE_CHOICE_FIELD,
  LOCAL_PROFILE_PICKER_PATH,
  LOCAL_PROFILE_PIN_FIELD,
  LocalProfileChoicesResponseSchema,
  LocalProfileSessionResponseSchema,
  isLocalProfilePinRefusal,
  localProfileUnlockHref,
  readRefusalCode,
  type LocalProfileChoice,
  type LocalProfilePinError,
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

const PIN_ERROR_VALUES: readonly LocalProfilePinError[] = ['required', 'incorrect', 'throttled'];

/**
 * The locked profile a picker URL asks the PIN for, and why it asks again.
 * Null when the URL names no profile, or one with no PIN, so the tiles show.
 */
export function unlockingFrom(
  profiles: readonly LocalProfileChoice[],
  unlock: string | string[] | undefined,
  error: string | string[] | undefined,
): { profile: LocalProfileChoice; error: LocalProfilePinError | null } | null {
  const profile = profiles.find((p) => p.userId === unlock && p.hasPin);
  if (profile === undefined) return null;
  const known = PIN_ERROR_VALUES.find((value) => value === error);
  return { profile, error: known ?? null };
}

export type ProfileSessionOutcome =
  | { kind: 'issued'; userId: string; session: string }
  /** The profile is locked, and the PIN was missing, wrong, or tried too often. */
  | { kind: 'pin'; error: LocalProfilePinError }
  | null;

const PIN_ERRORS: Record<string, LocalProfilePinError> = {
  PROFILE_PIN_REQUIRED: 'required',
  PROFILE_PIN_INCORRECT: 'incorrect',
  PROFILE_PIN_THROTTLED: 'throttled',
};

/**
 * The session the API issued for the chosen profile, the reason a locked
 * profile's PIN let nothing through, or null when it issued none for any
 * other reason.
 */
export async function issueProfileSession(
  userId: string,
  pin: string | undefined,
  fetchImpl: Fetch = fetch,
): Promise<ProfileSessionOutcome> {
  const headers = secretHeaders();
  if (headers === null) return null;
  try {
    const response = await fetchImpl(
      `${localApiUrl()}/v1/local-profiles/${encodeURIComponent(userId)}/session`,
      pin === undefined
        ? { method: 'POST', headers, cache: 'no-store' }
        : {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin }),
            cache: 'no-store',
          },
    );
    if (!response.ok) {
      const code = await readRefusalCode(response);
      return isLocalProfilePinRefusal(code)
        ? { kind: 'pin', error: PIN_ERRORS[code] ?? 'required' }
        : null;
    }
    const parsed = LocalProfileSessionResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    return { kind: 'issued', userId: parsed.data.profile.userId, session: parsed.data.session };
  } catch {
    return null;
  }
}

/**
 * Answers a tile's post: the session and the chosen profile in cookies, then
 * the front door, which enters that profile's preferred space.
 *
 * A refused PIN goes back to that profile's PIN prompt with the reason. Any
 * other refused choice goes back to the picker with a notice. Either way the
 * browser keeps whatever session it held.
 */
export async function answerProfileChoice(
  request: Request,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const userId = form?.get(LOCAL_PROFILE_CHOICE_FIELD);
  const pin = form?.get(LOCAL_PROFILE_PIN_FIELD);
  const issued =
    typeof userId === 'string'
      ? await issueProfileSession(userId, typeof pin === 'string' ? pin : undefined, fetchImpl)
      : null;
  if (issued?.kind === 'pin' && typeof userId === 'string') {
    return NextResponse.redirect(
      new URL(localProfileUnlockHref(userId, issued.error), request.url),
      303,
    );
  }
  if (issued?.kind !== 'issued') {
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
  return response;
}

function browserUsedHttps(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded !== undefined && forwarded !== '') return forwarded === 'https';
  return new URL(request.url).protocol === 'https:';
}
