/**
 * What inspect_session answers: a session's state, bounded.
 *
 * A long conversation names hundreds of steps, half of them the
 * `agent.control.run_step` wrappers that carry nothing of their own, so the
 * answer is the session's status, the newest few steps, what the agent last
 * said or is waiting on, and — when it failed — why. Whatever it leaves out is
 * counted, by status, with the parameter that returns it.
 */

import type { Session } from '../auth/SessionStore.js';
import type { PayloadReadClient } from './payloads.js';
import {
  decodeSessionCursor,
  encodeSessionCursor,
  seenSteps,
  stepsNotSeen,
} from './sessionCursor.js';
import { resolveSessionFailure, type SessionFailure } from './sessionFailure.js';
import {
  buildStepSummaries,
  STEP_HOT_STATE_EXPIRED,
  STEP_STATUS_NOT_READ,
  type DebugEvent,
  type SessionDebugResponse,
  type StepSummary,
} from './sessionViews.js';

export const DEFAULT_INSPECT_LAST_N_STEPS = 10;
export const CONTROL_STEP_OPERATION = 'agent.control.run_step';

export interface InspectSessionArgs {
  session_id: string;
  space_id: string;
  last_n_steps?: number | undefined;
  cursor?: string | undefined;
  status?: string[] | undefined;
  operation?: string[] | undefined;
  include_control_steps?: boolean | undefined;
}

export interface LeftOutSteps {
  count: number;
  by_status: Record<string, number>;
  why: string;
  returned_by: string;
}

export interface StepCensus {
  total: number;
  shown: number;
  left_out: LeftOutSteps[];
}

export interface InspectSessionResult {
  session_id: string;
  status: string;
  target?: unknown;
  failure?: SessionFailure;
  pending_question?: {
    step_execution_id: string;
    prompt?: string;
    response_options?: unknown;
    resume_with: string;
  };
  latest_reply?: { message: string; at?: string };
  steps: StepSummary[];
  census?: StepCensus;
  step_state?: string;
  token_usage?: { prompt: number; completion: number; total: number };
  warnings?: string[];
  cursor: string;
}

function countByStatus(steps: readonly StepSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  return counts;
}

function upper(values: string[] | undefined): Set<string> | undefined {
  return values && values.length > 0 ? new Set(values.map((v) => v.toUpperCase())) : undefined;
}

/**
 * The steps to show, and a census of the rest. Each left-out step is counted
 * once, under the first rule that left it out, in the order the rules apply.
 */
export function selectSteps(
  steps: readonly StepSummary[],
  args: Omit<InspectSessionArgs, 'session_id' | 'space_id'>,
): { shown: StepSummary[]; census?: StepCensus } {
  const cursor = decodeSessionCursor(args.cursor);
  const unseen = new Set(stepsNotSeen(cursor, steps));
  const statuses = upper(args.status);
  const operations =
    args.operation && args.operation.length > 0 ? new Set(args.operation) : undefined;
  const includeControl = args.include_control_steps === true;
  const lastN = args.last_n_steps ?? DEFAULT_INSPECT_LAST_N_STEPS;

  const groups = {
    cursor: [] as StepSummary[],
    control: [] as StepSummary[],
    status: [] as StepSummary[],
    operation: [] as StepSummary[],
  };
  const matching: StepSummary[] = [];
  for (const s of steps) {
    if (cursor && !unseen.has(s)) groups.cursor.push(s);
    else if (!includeControl && s.operation === CONTROL_STEP_OPERATION) groups.control.push(s);
    else if (statuses && !statuses.has(s.status.toUpperCase())) groups.status.push(s);
    else if (operations && (s.operation === undefined || !operations.has(s.operation)))
      groups.operation.push(s);
    else matching.push(s);
  }
  const shown = lastN >= matching.length ? matching : matching.slice(matching.length - lastN);
  const older = matching.slice(0, matching.length - shown.length);

  const left_out: LeftOutSteps[] = [];
  const add = (group: StepSummary[], why: string, returned_by: string) => {
    if (group.length > 0) {
      left_out.push({ count: group.length, by_status: countByStatus(group), why, returned_by });
    }
  };
  add(
    older,
    `older than the last ${String(lastN)} that match`,
    `last_n_steps: ${String(matching.length)}`,
  );
  add(
    groups.control,
    `${CONTROL_STEP_OPERATION} wrappers, which carry nothing of their own`,
    'include_control_steps: true',
  );
  add(groups.status, `not in status ${[...(statuses ?? [])].join(', ')}`, 'status (leave it out)');
  add(
    groups.operation,
    `not operation ${[...(operations ?? [])].join(', ')}`,
    'operation (leave it out)',
  );
  add(groups.cursor, 'already seen at the cursor', 'cursor (leave it out)');

  if (left_out.length === 0) return { shown };
  return { shown, census: { total: steps.length, shown: shown.length, left_out } };
}

function newestAgentMessage(
  events: DebugEvent[] | undefined,
): { message: string; at?: string } | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const message = events[i]?.metadata?.['agentMessage'];
    if (typeof message === 'string' && message !== '') {
      const at = events[i]?.timestamp;
      return at === undefined ? { message } : { message, at };
    }
  }
  return undefined;
}

/** The session's running total, as the newest event carrying one states it. */
function tokenUsageOf(
  events: DebugEvent[] | undefined,
): { prompt: number; completion: number; total: number } | undefined {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const summary = events?.[i]?.usageSummary;
    if (summary) {
      return {
        prompt: summary.totalPromptTokens,
        completion: summary.totalCompletionTokens,
        total: summary.totalTokens,
      };
    }
  }
  return undefined;
}

function stepStateNote(
  debug: SessionDebugResponse,
  steps: readonly StepSummary[],
): string | undefined {
  const notes: string[] = [];
  if (debug.hotState === 'expired') {
    notes.push(
      `The session's hot state has expired: its steps are those its ${String(debug.recentEvents?.length ?? 0)} ` +
        'newest events name, and earlier ones are not listed.',
    );
  }
  const notRead = steps.filter((s) => s.status === STEP_STATUS_NOT_READ).length;
  if (notRead > 0) {
    notes.push(
      `${String(notRead)} steps are ${STEP_STATUS_NOT_READ}: their status lies further back than the ` +
        `${String(debug.stepEvents?.read ?? debug.recentEvents?.length ?? 0)} events read for it.`,
    );
  }
  const expired = steps.filter((s) => s.status === STEP_HOT_STATE_EXPIRED).length;
  if (expired > 0) {
    notes.push(
      `${String(expired)} steps are ${STEP_HOT_STATE_EXPIRED}: no event left records them and no hot ` +
        'state holds them.',
    );
  }
  return notes.length > 0 ? notes.join(' ') : undefined;
}

export async function inspectSession(
  client: PayloadReadClient,
  session: Session,
  args: InspectSessionArgs,
): Promise<InspectSessionResult> {
  const debug = await client.get<SessionDebugResponse>(
    session,
    `/v1/sessions/${encodeURIComponent(args.session_id)}/debug?spaceId=${encodeURIComponent(args.space_id)}`,
  );
  const status = debug.session.status.toUpperCase();
  const steps = buildStepSummaries(debug);
  const { shown, census } = selectSteps(steps, args);

  const result: InspectSessionResult = {
    session_id: debug.session.sessionId,
    status,
    steps: shown,
    cursor: encodeSessionCursor(status, seenSteps(steps)),
  };
  if (debug.session.target) result.target = debug.session.target;

  if (status === 'FAILED') {
    result.failure = await resolveSessionFailure(client, session, args.space_id, debug);
  }

  const reply = newestAgentMessage(debug.recentEvents);
  const required = debug.session.requiredInput;
  const waitingOnChild =
    debug.session.blockedOn?.kind === 'workflow_run' ||
    debug.session.blockedOn?.kind === 'child_session';
  if (status === 'PAUSED' && required && !waitingOnChild) {
    const prompt = required.prompt ?? reply?.message;
    const options = required.missingVariables?.[0]?.responseOptions;
    result.pending_question = {
      step_execution_id: required.stepExecutionId,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(options ? { response_options: options } : {}),
      resume_with: `start_session with conversation_id "${args.session_id}", the same space_id, and input`,
    };
  }
  if (reply && result.pending_question?.prompt !== reply.message) result.latest_reply = reply;

  if (census) result.census = census;
  const note = stepStateNote(debug, steps);
  if (note !== undefined) result.step_state = note;
  const usage = tokenUsageOf(debug.recentEvents);
  if (usage) result.token_usage = usage;
  if (debug.warnings && debug.warnings.length > 0) result.warnings = debug.warnings;
  return result;
}
