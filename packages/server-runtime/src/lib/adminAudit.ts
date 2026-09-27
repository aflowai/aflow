/**
 * Recording an administrative action in the audit log.
 *
 * Shared rather than local to one route file, because the rows are written in
 * every edition — the tenant-wide reader is the compliance surface and is
 * enterprise, but attribution for who changed what is not something an
 * appliance does without.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

export function recordAdminAudit(
  fastify: FastifyInstance,
  request: FastifyRequest,
  tenant: { tenantId: string; tenantRole?: string },
  action: string,
  target: { resourceType: string; resourceId?: string },
  details?: Record<string, unknown>,
): void {
  if (!fastify.audit || !request.authUser) return;
  fastify.audit.record({
    actor: {
      userId: request.authUser.userId,
      kind: request.authUser.isServicePrincipal ? 'service_principal' : 'human',
      authMethod: request.authUser.authMethod,
      tenantId: tenant.tenantId,
      ...(tenant.tenantRole !== undefined ? { tenantRole: tenant.tenantRole } : {}),
    },
    category: 'admin',
    action,
    outcome: 'success',
    target: { ...target, tenantId: tenant.tenantId },
    ...(details !== undefined ? { details } : {}),
    request: { method: request.method, path: request.url },
  });
}
