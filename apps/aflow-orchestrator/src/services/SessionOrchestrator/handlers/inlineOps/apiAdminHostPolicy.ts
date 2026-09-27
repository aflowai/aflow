import { SsrfBlockedError } from '@aflow/network-safety';
import {
  enforceIntegrationHostPolicy,
  IntegrationHostPolicyError,
  type ApiDefinitionHostSource,
} from '@aflow/cybernetic-runtime';
import type { getDatabase, CatalogGrantArtifactRef } from '@aflow/database';
import type { FlowExecutionContext } from '../../types.js';

export interface ClassifiedApiAdminError {
  code: string;
  classification: 'validation' | 'not_found' | 'internal';
  details?: { deniedHosts: string[] };
}

/** Message-content classification for agent UX, with policy denials typed first. */
export function classifyApiAdminError(err: unknown, message: string): ClassifiedApiAdminError {
  if (err instanceof IntegrationHostPolicyError) {
    return {
      code: 'INTEGRATION_HOST_NOT_ALLOWED',
      classification: 'validation',
      details: { deniedHosts: err.denial.deniedHosts },
    };
  }
  if (err instanceof SsrfBlockedError) {
    return { code: err.code, classification: 'validation' };
  }
  if (/not found/i.test(message)) {
    return { code: 'API_ADMIN_NOT_FOUND', classification: 'not_found' };
  }
  if (/invalid|must be|required|missing/i.test(message)) {
    return { code: 'API_ADMIN_VALIDATION', classification: 'validation' };
  }
  return { code: 'API_ADMIN_OP_FAILED', classification: 'internal' };
}

export async function enforceApiAdminHostPolicy(opts: {
  db: ReturnType<typeof getDatabase>;
  context: FlowExecutionContext;
  spaceId: string;
  hosts: string[];
  grantRefs: CatalogGrantArtifactRef[];
}): Promise<void> {
  await enforceIntegrationHostPolicy({
    db: opts.db,
    tenantId: opts.context.tenantId as string,
    spaceId: opts.spaceId,
    kind: 'api',
    hosts: opts.hosts,
    grantRefs: opts.grantRefs,
  });
}

/** Host-relevant fields of a patched definition JSON, shaped for the collector. */
export function patchedDefinitionHostSource(
  updatedDef: Record<string, unknown>,
): ApiDefinitionHostSource {
  return {
    ...(typeof updatedDef['baseUrl'] === 'string' ? { baseUrl: updatedDef['baseUrl'] } : {}),
    ...(typeof updatedDef['baseUrlTemplate'] === 'string'
      ? { baseUrlTemplate: updatedDef['baseUrlTemplate'] }
      : {}),
    ...(updatedDef['suggestedEgressPolicy']
      ? {
          suggestedEgressPolicy: updatedDef['suggestedEgressPolicy'] as {
            additionalHosts?: string[];
          },
        }
      : {}),
  };
}
