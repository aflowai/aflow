/**
 * Watcher — interval-polls session and workflow-run reads so MCP callers can
 * follow long-running work instead of guessing when to re-check.
 *
 * A watch concludes (`done: true`) when the requested `until` condition is
 * reached OR when the watched thing enters a state it cannot leave without
 * external action (terminal, or a pause that needs input) — waiting past that
 * point can never succeed. `done: false` means the wait timed out; the
 * response then carries a `continuation` with the exact tool + args for the
 * next call, so callers chain watches with zero thought.
 */

import type { Session } from '../auth/SessionStore.js';
import { ApiError } from './ApiClient.js';
import {
  buildStepSummaries,
  type SessionDebugResponse,
  type SessionRunStatusView,
  type StepSummary,
} from './sessionViews.js';
import { log } from '../util/logger.js';

export interface ToolContinuation {
  tool: 'watch_session' | 'watch_run';
  args: Record<string, unknown>;
}

export interface WatchHttpClient {
  get<T>(session: Session, path: string): Promise<T>;
}

export type WatchSessionUntil = 'update' | 'pause' | 'terminal';
export type WatchRunUntil = 'pause' | 'terminal';

export interface WatchSessionArgs {
  session_id: string;
  space_id: string;
  until?: WatchSessionUntil | undefined;
  timeout_seconds?: number | undefined;
  cursor?: string | undefined;
}

export interface WatchRequiredInput {
  step_execution_id: string;
  prompt?: string | undefined;
  response_options?:
    { type: string; options: Array<{ value: string; label?: string }> } | undefined;
}

export interface WatchSessionResult {
  session_id: string;
  status: string;
  new_steps: StepSummary[];
  required_input?: WatchRequiredInput | undefined;
  done: boolean;
  cursor: string;
  continuation?: ToolContinuation | undefined;
  note?: string | undefined;
}

export interface WatchRunArgs {
  run_id: string;
  space_id: string;
  until?: WatchRunUntil | undefined;
  timeout_seconds?: number | undefined;
}

export interface WatchRunTask {
  task_id: string;
  status: string;
  label?: string | undefined;
}

export interface WatchRunResult {
  run: { run_id: string; status: string; paused_reason?: string | undefined };
  tasks: WatchRunTask[];
  resume_contract?: unknown;
  done: boolean;
  continuation?: ToolContinuation | undefined;
  note?: string | undefined;
}

interface WorkflowRunDetailView {
  run: { runId: string; status: string; pausedReason?: string | undefined };
  tasks?: Array<{ taskId: string; status: string; label?: string | undefined }> | undefined;
  resumeContract?: unknown;
}

/**
 * Step statuses keyed by step id: the diff survives the debug view switching
 * between hot-state and event-derived step lists (counts are not comparable
 * across modes), and re-delivers steps whose status changed in place.
 */
interface SessionWatchCursor {
  v: 2;
  steps: Record<string, string>;
  status: string;
}

export const DEFAULT_WATCH_TIMEOUT_SECONDS = 60;
export const MAX_WATCH_TIMEOUT_SECONDS = 240;
const DEFAULT_POLL_INTERVAL_MS = 2500;

const SESSION_TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const RUN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

function encodeCursor(cursor: SessionWatchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64');
}

/** Unreadable/foreign cursors watch from the beginning — resends steps rather than losing them. */
function decodeCursor(raw: string | undefined): SessionWatchCursor | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const steps = obj['steps'];
      if (
        obj['v'] === 2 &&
        typeof obj['status'] === 'string' &&
        steps !== null &&
        typeof steps === 'object' &&
        !Array.isArray(steps) &&
        Object.values(steps).every((s) => typeof s === 'string')
      ) {
        return { v: 2, steps: steps as Record<string, string>, status: obj['status'] };
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Steps the caller has not seen in their current status — new ids and in-place transitions. */
function diffSteps(baseline: SessionWatchCursor | undefined, steps: StepSummary[]): StepSummary[] {
  if (!baseline) return steps;
  return steps.filter((s) => baseline.steps[s.step_id] !== s.status);
}

function lightSignal(run: SessionRunStatusView): string {
  return [run.status, run.updatedAt ?? '', run.currentStepId ?? ''].join('|');
}

function sessionBlockedOnChild(
  status: string,
  blockedOn: SessionRunStatusView['blockedOn'],
): boolean {
  if (status === 'WAITING_ON_CHILD') return true;
  return (
    status === 'PAUSED' &&
    (blockedOn?.kind === 'workflow_run' || blockedOn?.kind === 'child_session')
  );
}

function clampTimeoutSeconds(requested: number | undefined): number {
  return Math.min(requested ?? DEFAULT_WATCH_TIMEOUT_SECONDS, MAX_WATCH_TIMEOUT_SECONDS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Watcher {
  constructor(
    private readonly client: WatchHttpClient,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  async watchSession(session: Session, args: WatchSessionArgs): Promise<WatchSessionResult> {
    const until = args.until ?? 'update';
    const timeoutSeconds = clampTimeoutSeconds(args.timeout_seconds);
    const deadline = Date.now() + timeoutSeconds * 1000;
    const sq = `spaceId=${encodeURIComponent(args.space_id)}`;
    const statusPath = `/v1/sessions/${args.session_id}?${sq}`;
    const debugPath = `/v1/sessions/${args.session_id}/debug?${sq}`;
    const baseline = decodeCursor(args.cursor);

    let lastRun: SessionRunStatusView | undefined;
    let steps: StepSummary[] | undefined;
    let lastSignal: string | undefined;
    let inspectedSignal: string | undefined;

    for (;;) {
      try {
        const run = await this.client.get<SessionRunStatusView>(session, statusPath);
        lastRun = run;
        lastSignal = lightSignal(run);
        const status = run.status.toUpperCase();

        const isTerminal = SESSION_TERMINAL_STATUSES.includes(status);
        const isInputPause = status === 'PAUSED' && !sessionBlockedOnChild(status, run.blockedOn);

        if (isTerminal || isInputPause) {
          steps = (await this.tryFetchSteps(session, debugPath, args.session_id)) ?? steps;
          return this.buildSessionResult(args, until, timeoutSeconds, baseline, run, steps, true);
        }

        if (until === 'update') {
          const statusChanged = baseline !== undefined && status !== baseline.status;
          if (statusChanged || lastSignal !== inspectedSignal) {
            const fetched = await this.tryFetchSteps(session, debugPath, args.session_id);
            if (fetched) {
              steps = fetched;
              inspectedSignal = lastSignal;
              if (statusChanged || diffSteps(baseline, fetched).length > 0) {
                return this.buildSessionResult(
                  args,
                  until,
                  timeoutSeconds,
                  baseline,
                  run,
                  steps,
                  true,
                );
              }
            } else if (statusChanged) {
              // The transition alone qualifies — a failing step read must not
              // hold the watch to timeout.
              return this.buildSessionResult(
                args,
                until,
                timeoutSeconds,
                baseline,
                run,
                steps,
                true,
              );
            }
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw err;
        log('warn', 'watch_session_poll_error', {
          session_id: args.session_id,
          error: String(err),
        });
      }

      if (Date.now() + this.pollIntervalMs >= deadline) {
        if (lastRun && (steps === undefined || lastSignal !== inspectedSignal)) {
          steps = (await this.tryFetchSteps(session, debugPath, args.session_id)) ?? steps;
        }
        return this.buildSessionResult(
          args,
          until,
          timeoutSeconds,
          baseline,
          lastRun,
          steps,
          false,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /** The debug read is heavyweight server-side — called only when the light status read moves or the watch concludes. */
  private async tryFetchSteps(
    session: Session,
    debugPath: string,
    sessionId: string,
  ): Promise<StepSummary[] | undefined> {
    try {
      const debug = await this.client.get<SessionDebugResponse>(session, debugPath);
      return buildStepSummaries(debug);
    } catch (err) {
      log('warn', 'watch_session_poll_error', { session_id: sessionId, error: String(err) });
      return undefined;
    }
  }

  private buildSessionResult(
    args: WatchSessionArgs,
    until: WatchSessionUntil,
    timeoutSeconds: number,
    baseline: SessionWatchCursor | undefined,
    run: SessionRunStatusView | undefined,
    steps: StepSummary[] | undefined,
    done: boolean,
  ): WatchSessionResult {
    const status = run?.status.toUpperCase() ?? 'UNKNOWN';
    const newSteps = steps ? diffSteps(baseline, steps) : [];
    // Without a step read, keep the baseline step map (diffs still deliver on
    // the next successful read) but acknowledge any observed status — the same
    // transition must not re-trigger the next call.
    const cursor = encodeCursor({
      v: 2,
      steps: steps
        ? Object.fromEntries(steps.map((s) => [s.step_id, s.status]))
        : (baseline?.steps ?? {}),
      status: run ? status : (baseline?.status ?? status),
    });

    const result: WatchSessionResult = {
      session_id: args.session_id,
      status,
      new_steps: newSteps,
      done,
      cursor,
    };

    if (
      run &&
      status === 'PAUSED' &&
      !sessionBlockedOnChild(status, run.blockedOn) &&
      run.requiredInput
    ) {
      const respOpts = run.requiredInput.missingVariables?.[0]?.responseOptions;
      result.required_input = {
        step_execution_id: run.requiredInput.stepExecutionId,
        ...(run.requiredInput.prompt !== undefined ? { prompt: run.requiredInput.prompt } : {}),
        ...(respOpts ? { response_options: respOpts } : {}),
      };
      result.note =
        `Session is paused awaiting input. Resume with start_session using ` +
        `conversation_id "${args.session_id}" (include space_id and input).`;
    }

    if (!done) {
      result.continuation = {
        tool: 'watch_session',
        args: {
          session_id: args.session_id,
          space_id: args.space_id,
          until,
          timeout_seconds: timeoutSeconds,
          cursor,
        },
      };
      result.note =
        `Nothing conclusive after ${String(timeoutSeconds)}s — the session continues server-side. ` +
        `Call watch_session again with the continuation args to keep following.`;
    }

    return result;
  }

  async watchRun(session: Session, args: WatchRunArgs): Promise<WatchRunResult> {
    const until = args.until ?? 'pause';
    const timeoutSeconds = clampTimeoutSeconds(args.timeout_seconds);
    const deadline = Date.now() + timeoutSeconds * 1000;
    const path = `/v1/spaces/${encodeURIComponent(args.space_id)}/workflow-runs/${encodeURIComponent(args.run_id)}`;

    let snapshot: WorkflowRunDetailView | undefined;

    for (;;) {
      try {
        snapshot = await this.client.get<WorkflowRunDetailView>(session, path);
        const status = snapshot.run.status.toLowerCase();

        // A paused run needs an operator/agent decision and a terminal run is
        // final — either concludes the watch regardless of `until`.
        if (status === 'paused' || RUN_TERMINAL_STATUSES.includes(status)) {
          return this.buildRunResult(args, until, timeoutSeconds, snapshot, true);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) throw err;
        log('warn', 'watch_run_poll_error', { run_id: args.run_id, error: String(err) });
      }

      if (Date.now() + this.pollIntervalMs >= deadline) {
        return this.buildRunResult(args, until, timeoutSeconds, snapshot, false);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private buildRunResult(
    args: WatchRunArgs,
    until: WatchRunUntil,
    timeoutSeconds: number,
    snapshot: WorkflowRunDetailView | undefined,
    done: boolean,
  ): WatchRunResult {
    const status = snapshot?.run.status.toLowerCase() ?? 'unknown';

    const result: WatchRunResult = {
      run: {
        run_id: args.run_id,
        status,
        ...(snapshot?.run.pausedReason !== undefined
          ? { paused_reason: snapshot.run.pausedReason }
          : {}),
      },
      tasks: (snapshot?.tasks ?? []).map((t) => ({
        task_id: t.taskId,
        status: t.status,
        ...(t.label !== undefined ? { label: t.label } : {}),
      })),
      done,
    };

    if (status === 'paused' && snapshot?.resumeContract !== undefined) {
      result.resume_contract = snapshot.resumeContract;
      result.note =
        'Run is paused — apply resume_contract.suggestedResumeCall via run_operation to resume it.';
    }

    if (!done) {
      result.continuation = {
        tool: 'watch_run',
        args: {
          run_id: args.run_id,
          space_id: args.space_id,
          until,
          timeout_seconds: timeoutSeconds,
        },
      };
      result.note =
        `Run still in progress after ${String(timeoutSeconds)}s. ` +
        `Call watch_run again with the continuation args to keep following.`;
    }

    return result;
  }
}
