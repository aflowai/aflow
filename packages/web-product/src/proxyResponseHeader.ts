/**
 * Marks a response the proxy produced instead of forwarding.
 *
 * The transport answers for itself in several places — it could not obtain an
 * upstream credential, the token provider threw, the request was not admitted —
 * and none of those reached the API. They therefore say nothing about whether
 * this caller's credential is good, which is the opposite of what their status
 * codes suggest: the proxy's own 503 means it could not get a credential, while
 * the API's `NotAdmitted` 503 means it got one and the caller is simply not
 * admitted yet.
 *
 * Session recovery has to tell those apart. Reading a proxy failure as proof of
 * authentication clears the attempt marker, which lets the next expiry spend a
 * fresh automatic redirect and rebuilds the loop the marker exists to stop.
 *
 * Its own module because both halves of the package need the name and neither
 * should import the other: the transport runs on the server, and the coordination
 * it feeds runs in the browser.
 */
export const PROXY_RESPONSE_HEADER = 'x-phoenix-proxy-response';
