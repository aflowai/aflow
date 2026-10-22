/**
 * The operator-only authority boundary. A service-principal (agent) caller
 * carries a userId too, so presence checks do not exclude it — every route
 * whose write must be a person's own rejects it here regardless of its space
 * grants, and the principal it returns is the one the write is stamped with.
 * The eval plane's ground truth (Plan 269 D7) is the founding case; the
 * operator's plan writes (Plan 322 P3.2) are the other, since a Runner's API
 * calls must not reach the plan it serves (D3).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

const EVAL_PLANE_OPERATOR_ONLY =
  'This is an operator-only surface. Agents read golden datasets via eval.dataset.* and draft cases via eval.case.promote; every dataset write is a human decision.';

export function requireOperatorPrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  refusal: string = EVAL_PLANE_OPERATOR_ONLY,
): { userId: string } | null {
  const authUser = request.authUser;
  if (!authUser || authUser.isServicePrincipal) {
    void reply.status(403).send({ error: 'operator_only', message: refusal });
    return null;
  }
  return { userId: authUser.userId };
}
