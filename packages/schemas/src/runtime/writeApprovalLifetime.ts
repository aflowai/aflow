/**
 * How long a request for approval stands (Plan 253, Plan 320 D7): a grant lives
 * this long, and so does the host's record of which request a browser call was
 * parked on; the page that call waits to act on is held open for as long.
 */
export const WRITE_APPROVAL_GRANT_TTL_SECONDS = 3600;

/** `WRITE_APPROVAL_GRANT_TTL_SECONDS` as a person reads it: "an hour", "90 minutes". */
export function writeApprovalLifetimeWords(): string {
  const minutes = Math.round(WRITE_APPROVAL_GRANT_TTL_SECONDS / 60);
  if (minutes % 60 !== 0) return `${String(minutes)} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? 'an hour' : `${String(hours)} hours`;
}
