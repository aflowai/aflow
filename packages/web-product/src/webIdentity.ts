/**
 * How this distribution authenticates a browser and authorizes the API calls
 * it makes on that browser's behalf.
 *
 * Server-only. Nothing here may reach a client bundle: the local
 * implementation holds the instance secret, and the hosted one holds a session
 * implementation and its cookies. Navigation contributions are a separate,
 * client-safe concern and do not belong in this file.
 *
 * Every member is derived from a call site rather than proposed. The shape the
 * web app has today is already two branches — the instance secret locally, an
 * access token hosted — written out at each of four places; this is the same
 * decision made once.
 *
 * Stated in `Request` and `Response` rather than the framework's subclasses. A
 * `NextRequest` is assignable to one, everything these members read is on the
 * base type, and a contract the product shares has no business pinning the
 * product to a framework version — nor requiring one to be installed to test
 * it.
 */
/**
 * What credential a server-to-API call may carry.
 *
 * Three outcomes rather than a nullable header, because "no credential" and
 * "cannot get one" are different answers and only one of them may proceed. A
 * proxy that treats the second as the first reaches the API unauthenticated
 * and every call 401s with nothing naming the cause.
 */
export type UpstreamAuthorization =
  | { kind: 'authorized'; header: string }
  | { kind: 'anonymous' }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable'; reason: string };

/**
 * `unauthenticated` is separate for the same reason it is on
 * `RequestAuthorization`: a session that expired means the visitor has to log in
 * again, and answering that with "come back later" sends them nowhere. The
 * hosted implementation reaches it when a token refresh fails on a route that
 * does not tolerate anonymity.
 */

/** Which part of the application a request is addressed to. */
export type RouteKind = 'auth' | 'api' | 'app';

/**
 * Whether one request may proceed, for a route that authorizes itself.
 *
 * Deliberately not "does this request carry a session". The local edition has
 * none by design — it authorizes on reachability, refusing a host or origin
 * that is not its own — so an implementation answering a session-shaped
 * question would have to return `true` and hide exactly the boundary that is
 * doing the work.
 *
 * Four outcomes because callers owe four different answers. Collapsing
 * `unauthenticated` into `unavailable` tells a visitor to come back later when
 * the truth is that they need to log in; collapsing `refused` into either
 * tells an attacker which of the two it was.
 */
export type RequestAuthorization =
  | { kind: 'authorized' }
  | { kind: 'unauthenticated' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable'; reason: string };

/**
 * The answer to admission, which is narrower on purpose.
 *
 * `unauthenticated` is absent because admission does not ask who the caller is —
 * that is `authenticateRequest`. Stated as a type rather than as a convention:
 * a caller handling the three outcomes it can receive is exhaustive, where one
 * handling three of four silently admits the fourth.
 */
export type Admission = Exclude<RequestAuthorization, { kind: 'unauthenticated' }>;

export interface ConfigViolation {
  key: string;
  message: string;
}

/**
 * The environment, as a plain map.
 *
 * Not `NodeJS.ProcessEnv`: a framework that augments it to require `NODE_ENV`
 * makes a literal unassignable, so the type a contract states would decide
 * whether its own tests compile. `process.env` satisfies this.
 */
export type Environment = Readonly<Record<string, string | undefined>>;

export interface WebIdentity {
  /** Names this implementation in a boot log. */
  readonly name: string;

  /** The credential for a server-to-API call made for this request. */
  authorizeUpstream(options: { anonymousOk: boolean }): Promise<UpstreamAuthorization>;

  /**
   * Session handling for the application proxy.
   *
   * Returns the response to send, which for a session implementation carries
   * the cookie updates its middleware produced — so a caller that discards it
   * silently stops refreshing sessions.
   */
  processRequest(request: Request, route: RouteKind): Promise<Response>;

  /**
   * Whether this process may serve this request at all — admission, not identity.
   *
   * The local edition answers with reachability, which is its entire credential.
   * A hosted one admits whatever arrived: an edge and TLS sit in front, and who
   * the caller is gets settled per route by `authorizeUpstream`, which knows the
   * routes the API serves anonymously. A session gate here would turn away the
   * one route that exists for people who do not have a session yet.
   */
  admitRequest(request: Request): Promise<Admission>;

  /**
   * Who the caller is, for a route that authorizes at its own boundary.
   *
   * Separate from admission because the two questions have different answers in
   * both editions, and one member serving both forces one of them to lie: the
   * proxy must not gate on a session, and a route that compiles submitted source
   * must. The local edition has no session — being admitted is being the owner —
   * so it answers with what admission already established.
   */
  authenticateRequest(request: Request): Promise<RequestAuthorization>;

  /** What must be true for this implementation to work. */
  configurationViolations(env: Environment): ConfigViolation[];
}

/**
 * What an application composes, of which identity is one facet.
 *
 * The front door is a product decision and not the identity provider's: an
 * edition with nobody to turn away enters the product, and one that greets
 * anonymous visitors shows them what they may see. Stated by the application
 * rather than inferred, because asking whether a provider happens to be
 * configured made the front door a side effect of a variable.
 */
export interface WebComposition {
  identity: WebIdentity;
  entry: 'product' | 'marketing';
}
