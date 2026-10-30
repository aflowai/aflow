/**
 * The two headers that tell a local-edition API who is at the keyboard
 * (Plan 335 P1).
 *
 * Both ride beside the instance secret, and the API reads them only with it.
 * The web process sets them and the browser cannot: the web forwards a fixed
 * list of browser headers, and neither of these is on it.
 */

/** The profile session the browser holds, which names one local user. */
export const LOCAL_PROFILE_SESSION_HEADER = 'x-aflow-profile-session';

/**
 * Set by the web process on every call it makes for a browser.
 *
 * A caller holding the bare secret sends nothing. That absence is what
 * separates a script such as `yarn mcp:setup` from a browser that has lost its
 * profile session.
 */
export const LOCAL_BROWSER_CALLER_HEADER = 'x-aflow-browser-caller';
