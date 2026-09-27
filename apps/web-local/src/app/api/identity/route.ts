/**
 * What this application's identity says about the request that reached it.
 *
 * The composition's one slot, exercised end to end: every outcome the contract
 * defines maps to a distinct status, so a refusal cannot be read as a missing
 * credential and neither can be read as success. Reports the outcome and never
 * the credential.
 */
import { localWebComposition } from '@/compose/localWebIdentity';

const STATUS = {
  authorized: 200,
  unauthenticated: 401,
  refused: 403,
  unavailable: 503,
} as const;

export async function GET(request: Request): Promise<Response> {
  const { identity, entry } = localWebComposition;
  const decision = await identity.authenticateRequest(request);

  if (decision.kind !== 'authorized') {
    return Response.json(
      {
        identity: identity.name,
        outcome: decision.kind,
        reason: 'reason' in decision ? decision.reason : undefined,
      },
      { status: STATUS[decision.kind] },
    );
  }

  // Asked only once the request is authorized, and reported as a state rather
  // than a value: this route exists to prove the slot, not to hand out the
  // instance secret.
  const upstream = await identity.authorizeUpstream({ anonymousOk: false });

  return Response.json(
    { identity: identity.name, entry, outcome: decision.kind, upstream: upstream.kind },
    { status: upstream.kind === 'unavailable' ? STATUS.unavailable : STATUS.authorized },
  );
}
