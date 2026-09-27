/**
 * The local instance's identity: one owner, one credential, no directory.
 *
 * There is no session here, by design. The appliance authorizes on
 * reachability — reaching this process means standing on the operator's own
 * host — so the whole decision is whether the request arrived that way, and
 * the instance secret is attached only after it has.
 */
import { NextResponse } from 'next/server';

import {
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

const instanceSecret = (): string => process.env[INSTANCE_SECRET_ENV]?.trim() ?? '';

export const localWebIdentity: WebIdentity = {
  name: 'local instance identity',

  authorizeUpstream(): Promise<UpstreamAuthorization> {
    const secret = instanceSecret();
    // Proceeding without it would reach the API with no credential at all and
    // 401 every call with nothing naming the cause. `anonymousOk` is not
    // consulted: there is no anonymous mode to fall back to, only a missing
    // secret.
    if (secret === '') {
      return Promise.resolve({
        kind: 'unavailable',
        reason: `${INSTANCE_SECRET_ENV} is not set for this web process.`,
      });
    }
    return Promise.resolve({ kind: 'authorized', header: `Bearer ${secret}` });
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
   * There is no session to find: being admitted is being the owner, so the answer
   * is whatever admission already decided. A session-shaped implementation here
   * would have to return `true` and hide the boundary doing the work.
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
