export type BrowserFailureKind =
  | 'page_gone'
  | 'unknown_profile'
  | 'profile_not_for_space'
  | 'appliance_origin'
  | 'origin_denied'
  | 'posture_refused'
  | 'ask_unavailable'
  | 'stale_ref'
  | 'credential_field'
  | 'action_failed'
  | 'no_browser'
  | 'launch_failed'
  | 'navigation_failed'
  | 'observation_failed';

/** A refusal or failure the driver can name, carried to the step as its own code. */
export class BrowserDriverError extends Error {
  constructor(
    readonly kind: BrowserFailureKind,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'BrowserDriverError';
  }
}
