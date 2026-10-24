import { getDatabase } from '@aflow/database';
import { loadRunById } from '@aflow/cybernetic-runtime';
import { getRunAccessGrant } from '@aflow/redis';
import type { RunAccessGrant } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepError } from './helpers.js';
import { establishRunAccessGrant } from '../../helpers/workflowGrantGate.js';

type ScheduleAuthority =
  | { kind: 'granted'; grant: RunAccessGrant; sessionId: string }
  | { kind: 'none' }
  | { kind: 'refused'; code: string; message: string };

/**
 * Whose schedule this is: the grant of the session the work runs for. A
 * workflow task's own session is synthetic and holds none, so a task acts with
 * the grant of the session that started its run, as `workflow.run.start` does.
 */
async function resolveScheduleAuthority(
  args: InlineHandlerArgs,
  spaceId: string,
): Promise<ScheduleAuthority> {
  const { context } = args;
  if (args.workflowExecution === undefined) {
    const grant = await getRunAccessGrant(args.redis, context.tenantId, context.runId);
    return grant ? { kind: 'granted', grant, sessionId: context.runId } : { kind: 'none' };
  }
  const db = getDatabase();
  const run = await loadRunById(db, context.tenantId, spaceId, args.workflowExecution.runId);
  const sessionId = run?.sessionId;
  if (!sessionId) return { kind: 'none' };
  const established = await establishRunAccessGrant({
    db,
    redis: args.redis,
    tenantId: context.tenantId,
    sessionId,
  });
  switch (established.kind) {
    case 'granted':
      return { kind: 'granted', grant: established.grant, sessionId };
    case 'ungoverned':
      return { kind: 'none' };
    case 'authority_revoked':
      return {
        kind: 'refused',
        code: 'RUN_ACCESS_REVOKED',
        message: `The access this run executes under is no longer held — ${established.detail}. No schedule was written.`,
      };
    case 'authority_unavailable':
      return {
        kind: 'refused',
        code: 'RUN_ACCESS_UNAVAILABLE',
        message: `The access this run executes under could not be established — ${established.detail}. No schedule was written; this does not mean the access was withdrawn.`,
      };
  }
}

const NO_CREDENTIAL_OWNER_MESSAGE =
  'Schedules run as their creator, and this session has no user identity to inherit — ' +
  'a run started by this schedule would fail as soon as it needs credentials. ' +
  'Create the schedule from a session started by a user.';

/** Refuses the step unless a grant was established; returns the grant where one was. */
export async function requireScheduleAuthority(
  args: InlineHandlerArgs,
  spaceId: string,
  startTime: number,
): Promise<{ grant: RunAccessGrant; sessionId: string } | null> {
  const authority = await resolveScheduleAuthority(args, spaceId);
  if (authority.kind === 'granted') return authority;
  if (authority.kind === 'none') {
    await emitStepError(
      args,
      'SCHEDULE_NO_CREDENTIAL_OWNER',
      NO_CREDENTIAL_OWNER_MESSAGE,
      startTime,
      'validation',
    );
  } else {
    await emitStepError(
      args,
      authority.code,
      authority.message,
      startTime,
      'permission',
      authority.code === 'RUN_ACCESS_UNAVAILABLE',
    );
  }
  return null;
}

export function definitionCreatedBy(context: InlineHandlerArgs['context']): string | null {
  const custom = context.agentDefinition.metadata.custom as Record<string, unknown> | undefined;
  const createdBy = custom?.['createdBy'];
  return typeof createdBy === 'string' ? createdBy : null;
}
