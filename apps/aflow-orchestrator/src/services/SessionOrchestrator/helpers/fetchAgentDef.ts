import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ZodError } from 'zod';
import type { TenantId, SessionAgentTarget, AgentDefinition } from '@aflow/schemas';
import { AgentDefinitionSchema, agentTargetKey } from '@aflow/schemas';
import { loadAgentTargetDefinition } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';

/**
 * Thrown when a stored agent definition fails schema validation.
 * This is a definition-level error (the agent is broken), not an input error.
 */
export class AgentDefinitionInvalidError extends Error {
  readonly targetKey: string;
  readonly version: string;
  readonly validationErrors: string[];

  constructor(target: SessionAgentTarget, version: string, zodError: ZodError) {
    const issues = zodError.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    const key = agentTargetKey(target);
    super(`Agent "${key}" (v${version}) has an invalid definition: ${issues.join('; ')}`);
    this.name = 'AgentDefinitionInvalidError';
    this.targetKey = key;
    this.version = version;
    this.validationErrors = issues;
  }
}

export async function fetchAgentDef(
  db: PostgresJsDatabase,
  payloadStore: PayloadStore,
  tenantId: string,
  target: SessionAgentTarget,
  agentVersion: string,
): Promise<AgentDefinition> {
  // Inline-agent: read the persisted definition payload directly. The
  // orchestrator's startRun is responsible for ensuring `definitionRef` is
  // a real PayloadStore ref (not a `pending:<runId>` placeholder) by this
  // point in the run lifecycle.
  if (target.kind === 'inline-agent') {
    const stored = await payloadStore.retrieve(target.definitionRef as never);
    try {
      return AgentDefinitionSchema.parse(stored);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new AgentDefinitionInvalidError(target, agentVersion, err);
      }
      throw err;
    }
  }

  // Platform-role + custom-agent: delegate to the centralized resolver
  // (handles registry-vs-DB branching, archive guard, version not-found, and
  // slug-history-aware overrides for custom agents).
  try {
    const resolved = await loadAgentTargetDefinition(
      db,
      tenantId as TenantId,
      target,
      agentVersion || 'latest',
    );
    return resolved.definition;
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AgentDefinitionInvalidError(target, agentVersion, err);
    }
    throw err;
  }
}
