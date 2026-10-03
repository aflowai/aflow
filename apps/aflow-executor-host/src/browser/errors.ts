export type BrowserFailureKind =
  | 'page_gone'
  | 'unknown_profile'
  | 'profile_invalid'
  | 'profile_not_for_space'
  | 'appliance_origin'
  | 'origin_denied'
  | 'posture_refused'
  | 'ask_unavailable'
  | 'stale_ref'
  | 'credential_field'
  | 'field_unchecked'
  | 'action_failed'
  | 'no_browser'
  | 'launch_failed'
  | 'navigation_failed'
  | 'open_uncertain'
  | 'observation_failed'
  | 'window_shown'
  | 'window_failed'
  | 'handoff_not_posted'
  | 'no_site'
  | 'screenshot_too_large'
  | 'script_refused';

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
