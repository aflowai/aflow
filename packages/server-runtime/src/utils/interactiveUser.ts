import { z } from 'zod';
import { type ActorContext, type AuthMethod, isPersonTrigger } from '@aflow/schemas';
import type { AuthUser } from '../plugins/auth.js';

/**
 * How a person signed in interactively reaches the API: the identity
 * provider's token in the hosted edition, the instance secret the local
 * edition's web server presents for its owner, and the development bypass. An
 * API key — an MCP server's, a script's — never signs in interactively,
 * whoever it belongs to, and neither does a device grant or a service principal.
 */
const INTERACTIVE_AUTH_METHODS: ReadonlySet<AuthMethod> = new Set([
  'jwt',
  'session',
  'local',
  'dev_bypass',
]);

/** Whether the request was authenticated as an interactive user, the only principal a person-only start mode admits. */
export function isInteractiveUser(authUser: AuthUser | undefined): boolean {
  return (
    authUser !== undefined &&
    !authUser.isServicePrincipal &&
    INTERACTIVE_AUTH_METHODS.has(authUser.authMethod)
  );
}

/**
 * Whether a person's principal made the request: an interactive sign-in, or an
 * API key a user holds. A service principal, a device grant and the system are
 * not. A session such a request starts, resumes or retries over REST is
 * attended (`SessionHotState.activatedByPerson`). A conversation the operator
 * starts with their own key, the MCP server's included, then carries the
 * operator's plan write authority (Plan 331, Plan 328 D6). It admits no
 * person-only start mode, which stays the rule of `isInteractiveUser`.
 */
export function isPersonPrincipal(authUser: AuthUser | undefined): boolean {
  return (
    authUser !== undefined &&
    !authUser.isServicePrincipal &&
    (INTERACTIVE_AUTH_METHODS.has(authUser.authMethod) || authUser.authMethod === 'api_key')
  );
}

/** The rule of `isInteractiveUser`, read from the actor context a route built from its request. */
export function isInteractiveActor(actor: ActorContext | undefined): boolean {
  return actor?.kind === 'human' && INTERACTIVE_AUTH_METHODS.has(actor.authMethod);
}

/**
 * The surface a run is started from. It names the surface only: whether a
 * person set the run going is the credential's (`isPersonPrincipal`), so a
 * user's `api` or `mcp` start is attended. `chat` and `voice` are a person's, so a credential that is
 * not an interactive user is refused them rather than having them rewritten: a
 * misconfigured client learns.
 */
export const StartModeSchema = z.enum(['chat', 'api', 'mcp', 'voice']);
export type StartMode = z.infer<typeof StartModeSchema>;

const MODES_WITHOUT_A_PERSON = StartModeSchema.options.filter((mode) => !isPersonTrigger(mode));

/** Why a start's mode is refused for its credential, or nothing when it is not. */
export function refusedStartMode(
  mode: StartMode,
  authUser: AuthUser | undefined,
): string | undefined {
  if (isInteractiveUser(authUser) || !isPersonTrigger(mode)) return undefined;
  return (
    `mode '${mode}' starts a run as a person in a conversation, and only someone signed in ` +
    `to the web application starts one. This credential — an API key, a service ` +
    `principal — may send mode ${MODES_WITHOUT_A_PERSON.map((m) => `'${m}'`).join(' or ')}.`
  );
}
