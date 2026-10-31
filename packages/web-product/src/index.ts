/**
 * @aflow/web-product — the web product, shared by every application that
 * composes it.
 *
 * An application here is a Next entry point and nothing more: route files, a
 * proxy, a configuration wrapper, and the providers its edition has. What the
 * product *is* lives in this package, so the two applications cannot drift
 * into two products.
 *
 * Everything here has to be safe in a browser bundle: an application's client
 * components import this entry, and a Next build follows it. The artifact
 * compiler is therefore `@aflow/web-product/compiler` and not part of this —
 * it reaches for esbuild, which is a native binary a client build cannot bundle,
 * and the failure arrives as `Unknown module type` naming neither.
 *
 * @packageDocumentation
 */

export { allowsAnonymous, clientIpOf, proxyToApi, upstreamHeaders } from './bffTransport.js';
export { ACTIVE_PROFILE_COOKIE, PREFERRED_SPACE_COOKIE } from './preferredSpaceCookie.js';
export {
  LOCAL_PROFILE_CHOICE_FIELD,
  LOCAL_PROFILE_CHOICE_PATH,
  LOCAL_PROFILE_PICKER_PATH,
  LOCAL_PROFILE_PIN_ERROR_PARAM,
  LOCAL_PROFILE_PIN_FIELD,
  LOCAL_PROFILE_UNLOCK_PARAM,
  localProfileUnlockHref,
} from './localProfilePicker.js';
export type { LocalProfilePinError } from './localProfilePicker.js';
export type { TransportConfig } from './bffTransport.js';

export {
  RECOVERY_MARKER,
  createSessionRecovery,
  provesAuthenticated,
  readRefusalCode,
} from './session/recovery.js';
export { PROXY_RESPONSE_HEADER } from './proxyResponseHeader.js';
export type {
  BlockedSession,
  RecoveryAction,
  RecoveryHost,
  SessionRecovery,
} from './session/recovery.js';

export { refuseLocalRequest } from './localRequestGuard.js';
export {
  LOCAL_BROWSER_CALLER_HEADER,
  LOCAL_PROFILE_SESSION_HEADER,
  LocalProfileChoicesResponseSchema,
  LocalProfileSessionResponseSchema,
  isLocalProfilePinRefusal,
  showsLocalProfilePicker,
} from '@aflow/schemas';
export type { LocalProfileChoice } from '@aflow/schemas';

export type { LocalRequest } from './localRequestGuard.js';

export type {
  Admission,
  ConfigViolation,
  Environment,
  RequestAuthorization,
  RouteKind,
  UpstreamAuthorization,
  WebComposition,
  WebIdentity,
} from './webIdentity.js';
