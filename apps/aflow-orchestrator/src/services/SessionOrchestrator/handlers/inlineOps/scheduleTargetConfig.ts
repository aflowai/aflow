import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  ArchivedAgentError,
  UnknownCustomAgentError,
  VersionNotFoundError,
  loadAgentTargetDefinition,
  type AgentScheduleRow,
} from '@aflow/database';
import {
  agentTargetKey,
  deriveFlowInputContract,
  projectTargetColumns,
  type AgentDefinition,
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

/** What a stored schedule hands the agent it starts. */
export function scheduleTargetConfig(row: AgentScheduleRow): ScheduleTargetConfig {
  return {
    target:
      row.action === 'start_run' && row.targetKind !== null
        ? (projectTargetColumns(row, 'persistent') as PersistentAgentTarget)
        : null,
    agentVersion: row.agentVersion,
    inputTemplate: row.inputTemplate,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configKeys(inputTemplate: unknown): string[] {
  const config = isRecord(inputTemplate) ? inputTemplate['config'] : undefined;
  return isRecord(config) ? Object.keys(config) : [];
}

/**
 * The version a schedule starts, as the refusal names it. Only a schedule
 * created through the REST API carries a pin: agent.schedule.create takes
 * none, so the remedy offered to an agent is never to pin one.
 */
function startedVersion(version: string, pinned: boolean): string {
  return pinned
    ? `version "${version}", which this schedule pins`
    : `version "${version}", its latest published version — what a schedule with no pinned version starts at each firing`;
}

function remedy(unknown: string[], pinned: boolean): string {
  const them = unknown.length === 1 ? 'it' : 'them';
  const names = unknown.join(', ');
  return pinned
    ? `A pinned schedule always starts that version: remove ${them} from the schedule's input.config, or replace the schedule with one from agent.schedule.create — which pins no version, so it starts the agent's latest published version — once a published version declares ${names}.`
    : `Publish a version of the agent that declares ${names}, or remove ${them} from the schedule's input.config.`;
}

/**
 * Why `definition` would not read the config `inputTemplate` hands it, or null
 * when it declares every key. Only the keys: the values may be `$schedule` /
 * `$source` templates that resolve at fire time.
 *
 * A run meets an unknown config key only when it starts — refused, or dropped
 * unread where the version declares no state variables — and for a schedule
 * that is a firing nobody is watching, so the schedule checks it first.
 */
export function undeclaredConfigProblem(params: {
  target: PersistentAgentTarget;
  definition: AgentDefinition;
  version: string;
  pinned: boolean;
  inputTemplate: unknown;
}): string | null {
  const { target, definition, version, pinned, inputTemplate } = params;
  const declared = deriveFlowInputContract(definition).configVariables.map((v) => v.variableId);
  const unknown = configKeys(inputTemplate).filter((key) => !declared.includes(key));
  if (unknown.length === 0) return null;

  const named = unknown.map((key) => `config.${key}`).join(', ');
  return (
    `${named} ${unknown.length === 1 ? 'is not a config variable' : 'are not config variables'} of agent "${definition.metadata.name}" (${agentTargetKey(target)}) ${startedVersion(version, pinned)}. ` +
    `That version declares ${declared.length > 0 ? `config ${declared.join(', ')}` : 'no config variables'}, so no firing would hand ${unknown.length === 1 ? 'it' : 'them'} to the agent. ` +
    remedy(unknown, pinned)
  );
}

/** Why a schedule's target cannot be loaded at all, for the errors that say so. */
export function unloadableTargetProblem(
  err: unknown,
  target: PersistentAgentTarget,
): string | null {
  if (err instanceof VersionNotFoundError) {
    return `Agent ${agentTargetKey(target)} has no version "${err.version}", which this schedule pins, so it starts nothing. Replace it with a schedule from agent.schedule.create, which pins no version and starts the agent's latest published version.`;
  }
  if (err instanceof UnknownCustomAgentError || err instanceof ArchivedAgentError) {
    return err.message;
  }
  return null;
}

/**
 * Why the agent version a schedule will start — its pin, or the latest
 * published version — would not read the config the schedule hands it, or
 * null when it reads every key.
 */
export async function scheduleConfigProblem(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  schedule: ScheduleTargetConfig,
): Promise<string | null> {
  const { target, agentVersion, inputTemplate } = schedule;
  if (!target || configKeys(inputTemplate).length === 0) return null;

  let resolved;
  try {
    resolved = await loadAgentTargetDefinition(db, tenantId, target, agentVersion ?? 'latest');
  } catch (err) {
    const problem = unloadableTargetProblem(err, target);
    if (problem === null) throw err;
    return problem;
  }
  return undeclaredConfigProblem({
    target,
    definition: resolved.definition,
    version: resolved.version,
    pinned: agentVersion !== null,
    inputTemplate,
  });
}
