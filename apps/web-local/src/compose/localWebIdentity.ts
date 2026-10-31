/**
 * The local instance's identity: one credential, no directory.
 *
 * There is no login here, by design. The appliance authorizes on
 * reachability — reaching this process means standing on the operator's own
 * host — so the whole decision is whether the request arrived that way, and
 * the instance secret is attached only after it has.
 *
 * Which profile is at the keyboard is the API's decision, not this process's.
 * This process forwards the browser's profile session as it found it and marks
 * every call as a browser's. The API then refuses a browser with no session
 * once the install has a second profile (Plan 335 §8 question 7).
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import {
  LOCAL_BROWSER_CALLER_HEADER,
  LOCAL_PROFILE_SESSION_HEADER,
  refuseLocalRequest,
  type Admission,
  type ConfigViolation,
  type Environment,
  type RequestAuthorization,
  type UpstreamAuthorization,
  type WebComposition,
  type WebIdentity,
} from '@aflow/web-product';

/** Named once; the boot check and the authorizer must not disagree about it. */
export const INSTANCE_SECRET_ENV = 'PHOENIX_INSTANCE_SECRET';

/**
 * The cookie holding the browser's profile session. The API issues the value
 * when a profile is chosen, and this process only carries it.
 */
export const PROFILE_SESSION_COOKIE = 'aflow_profile_session';

export const instanceSecret = (): string => process.env[INSTANCE_SECRET_ENV]?.trim() ?? '';

/** Where this web process reaches the API. */
export const localApiUrl = (): string => process.env.API_URL || 'http://localhost:3000';

export const localWebIdentity: WebIdentity = {
  name: 'local instance identity',

  async authorizeUpstream(): Promise<UpstreamAuthorization> {
    const secret = instanceSecret();
    // Proceeding without it would reach the API with no credential at all and
    // 401 every call with nothing naming the cause. `anonymousOk` is not
    // consulted: there is no anonymous mode to fall back to, only a missing
    // secret.
    if (secret === '') {
      return {
        kind: 'unavailable',
        reason: `${INSTANCE_SECRET_ENV} is not set for this web process.`,
      };
    }
    const session = (await cookies()).get(PROFILE_SESSION_COOKIE)?.value ?? '';
    return {
      kind: 'authorized',
      header: `Bearer ${secret}`,
      headers: {
        [LOCAL_BROWSER_CALLER_HEADER]: '1',
        ...(session === '' ? {} : { [LOCAL_PROFILE_SESSION_HEADER]: session }),
      },
    };
  },

  processRequest(): Promise<Response> {
    // No session to carry and no cookies to refresh, so there is nothing to
    // decide per route: the request continues, and `admitRequest` runs at
    // the boundary where the credential is actually attached. `next()` is the
    // sentinel the framework reads as "carry on" — anything else here, a 204
    // included, would answer the request instead of letting it through.
    return Promise.resolve(NextResponse.next());
  },

  admitRequest(request: Request): Promise<Admission> {
    const url = new URL(request.url);
    const refusal = refuseLocalRequest({
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      forwardedProto: request.headers.get('x-forwarded-proto'),
      urlProtocol: url.protocol,
    });
    if (refusal !== null) return Promise.resolve({ kind: 'refused', reason: refusal });
    if (instanceSecret() === '') {
      return Promise.resolve({
        kind: 'unavailable',
        reason: `${INSTANCE_SECRET_ENV} is not set for this web process.`,
      });
    }
    return Promise.resolve({ kind: 'authorized' });
  },

  /**
   * Being admitted is being allowed to act, so the answer is whatever
   * admission already decided. Which profile acts is the API's question, which
   * it answers from the session `authorizeUpstream` forwards. A session-shaped
   * implementation here would have to return `true` and hide the boundary
   * doing the work.
   */
  authenticateRequest(request: Request): Promise<RequestAuthorization> {
    return this.admitRequest(request);
  },

  configurationViolations(env: Environment): ConfigViolation[] {
    const secret = env[INSTANCE_SECRET_ENV]?.trim() ?? '';
    if (secret !== '') return [];
    return [
      {
        key: INSTANCE_SECRET_ENV,
        message:
          'Required by the local edition — it is what this web process authenticates to the API with. Bootstrap generates one.',
      },
    ];
  },
};

/**
 * This application's composition.
 *
 * `entry: 'product'` is stated, not inferred. The local edition has nobody to
 * turn away, so its front door is the product — and asking whether an identity
 * provider happened to be configured is what made that a side effect of a
 * variable.
 */
export const localWebComposition: WebComposition = {
  identity: localWebIdentity,
  entry: 'product',
};
