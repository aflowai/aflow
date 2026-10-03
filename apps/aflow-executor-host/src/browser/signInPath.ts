/**
 * Path segments a sign-in's own pages are commonly under. A page that asks for
 * nothing but has not left them — "check your phone", "approve on your device"
 * — is a sign-in still under way.
 */
export const SIGN_IN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'login',
  'signin',
  'sign-in',
  'session',
  'sessions',
  'two-factor',
  '2fa',
  'mfa',
  'verify',
  'challenge',
  'otp',
  'authorize',
  'oauth',
  'sso',
]);

/**
 * Whether any segment of the address's path is one of `SIGN_IN_PATH_SEGMENTS`,
 * read without case, an extension or a version number: `/users/sign_in`,
 * `/login.php` and `/oauth2/authorize` all are.
 */
export function onSignInPath(address: string): boolean {
  let path: string;
  try {
    path = new URL(address).pathname;
  } catch {
    return false;
  }
  return path
    .toLowerCase()
    .split('/')
    .map((segment) =>
      segment
        .replace(/\.[a-z]+$/, '')
        .replace(/(?<=[a-z])\d+$/, '')
        .replaceAll('_', '-'),
    )
    .some((segment) => SIGN_IN_PATH_SEGMENTS.has(segment));
}
