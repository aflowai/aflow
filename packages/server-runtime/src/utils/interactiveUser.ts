import { z } from 'zod';
import { type ActorContext, type AuthMethod, isPersonTrigger } from '@aflow/schemas';
import type { AuthUser } from '../plugins/auth.js';

/**
 * How a person signed in interactively reaches the API: the identity
 * provider's token in the hosted edition, the instance secret the local
 * edition's web server presents for its owner, and the development bypass. An
 * API key — an MCP server's, a script's — is never a person, whoever it
 * belongs to, and neither is a device grant or a service principal.
 */
const INTERACTIVE_AUTH_METHODS: ReadonlySet<AuthMethod> = new Set([
  'jwt',
  'session',
  'local',
  'dev_bypass',
]);

/** Whether the request was authenticated as an interactive user — the only principal that counts as a person. */
export function isInteractiveUser(authUser: AuthUser | undefined): boolean {
  return (
    authUser !== undefined &&
    !authUser.isServicePrincipal &&
    INTERACTIVE_AUTH_METHODS.has(authUser.authMethod)
  );
}

/** The same rule, read from the actor context a route built from its request. */
export function isInteractiveActor(actor: ActorContext | undefined): boolean {
  return actor?.kind === 'human' && INTERACTIVE_AUTH_METHODS.has(actor.authMethod);
}

/**
 * The surface a run is started from. `chat` and `voice` are a person's, so a
 * credential that is not an interactive user is refused them rather than
 * having them rewritten: a misconfigured client learns.
 */
export const StartModeSchema = z.enum(['chat', 'api', 'mcp', 'voice']);
export type StartMode = z.infer<typeof StartModeSchema>;

const MODES_WITHOUT_A_PERSON = StartModeSchema.options.filter((mode) => !isPersonTrigger(mode));

/** Why a start's mode is refused for its credential, or nothing when it is not. */
export function refusedStartMode(mode: StartMode, interactiveUser: boolean): string | undefined {
  if (interactiveUser || !isPersonTrigger(mode)) return undefined;
  return (
    `mode '${mode}' starts a run as a person in a conversation, and only someone signed in ` +
    `to the web application starts one. This credential — an API key, a service ` +
    `principal — may send mode ${MODES_WITHOUT_A_PERSON.map((m) => `'${m}'`).join(' or ')}.`
  );
}
