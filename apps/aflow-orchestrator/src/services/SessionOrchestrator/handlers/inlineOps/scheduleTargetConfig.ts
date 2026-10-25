import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  ArchivedAgentError,
  UnknownCustomAgentError,
  VersionNotFoundError,
  loadAgentTargetDefinition,
} from '@aflow/database';
import {
  agentTargetKey,
  deriveFlowInputContract,
  type PersistentAgentTarget,
  type TenantId,
} from '@aflow/schemas';

/** What a schedule hands the agent it starts. */
export interface ScheduleTargetConfig {
  target: PersistentAgentTarget | null;
  /** The pinned version, or null to start the latest published one. */
  agentVersion: string | null;
  inputTemplate: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why the agent version a schedule starts would refuse the `config` its input
 * hands it, or null when it accepts every key.
 *
 * A run meets an unknown config key only when it starts — refused, or dropped
 * unread where the version declares no state variables — and for a schedule
 * that is a firing nobody is watching. So the keys are checked against
 * the version the schedule will start when it is written. Only the keys: the
 * values may be `$schedule` / `$source` templates that resolve at fire time.
 */
export async function scheduleConfigProblem(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  schedule: ScheduleTargetConfig,
): Promise<string | null> {
  const { target, agentVersion, inputTemplate } = schedule;
  const config = isRecord(inputTemplate) ? inputTemplate['config'] : undefined;
  if (!target || !isRecord(config)) return null;
  const keys = Object.keys(config);
  if (keys.length === 0) return null;

  const which = agentVersion
    ? `version "${agentVersion}", which flowVersion pins`
    : 'its latest published version, which a schedule without flowVersion starts';
  let resolved;
  try {
    resolved = await loadAgentTargetDefinition(db, tenantId, target, agentVersion ?? 'latest');
  } catch (err) {
    if (err instanceof VersionNotFoundError) {
      return `Agent ${agentTargetKey(target)} has no version "${err.version}", which flowVersion pins: the schedule would start nothing. Pin a version the agent has, or leave flowVersion unset to start its latest published version.`;
    }
    if (err instanceof UnknownCustomAgentError || err instanceof ArchivedAgentError) {
      return `${err.message}: the schedule's config cannot be checked against an agent it cannot start.`;
    }
    throw err;
  }

  const declared = deriveFlowInputContract(resolved.definition).configVariables.map(
    (v) => v.variableId,
  );
  const unknown = keys.filter((key) => !declared.includes(key));
  if (unknown.length === 0) return null;

  const named = unknown.map((key) => `config.${key}`).join(', ');
  const agentName = resolved.definition.metadata.name;
  return (
    `${named} ${unknown.length === 1 ? 'is not a config variable' : 'are not config variables'} of agent "${agentName}" (${agentTargetKey(target)}) version "${resolved.version}" — ${which}. ` +
    `That version declares ${declared.length > 0 ? `config ${declared.join(', ')}` : 'no config variables'}, so no firing would hand ${unknown.length === 1 ? 'it' : 'them'} to the agent. ` +
    `Publish a version of the agent that declares ${unknown.join(', ')}, pin flowVersion to one that does, or remove ${unknown.length === 1 ? 'it' : 'them'} from input.config.`
  );
}
