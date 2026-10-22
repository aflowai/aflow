/**
 * The Plan 269 D7 authority boundary for eval-plane ground truth: golden-case
 * writes and eval labels are operator-only. A service-principal (agent)
 * caller carries a userId too, so presence checks do not exclude it — every
 * route that mints ground truth must reject it here regardless of its space
 * grants.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export function requireOperatorPrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
): { userId: string } | null {
  const authUser = request.authUser;
  if (!authUser || authUser.isServicePrincipal) {
    void reply.status(403).send({
      error: 'operator_only',
      message:
        'This is an operator-only surface. Agents read golden datasets via eval.dataset.* and draft cases via eval.case.promote; every dataset write is a human decision.',
    });
    return null;
  }
  return { userId: authUser.userId };
}
