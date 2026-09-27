/**
 * Rubric-judge evidence assembly (Plan 269 D8), shared by the batch grading
 * stage and the offline re-judge path so a replayed judge sees the SAME
 * evidence the original judge saw — evidence drift between the two would
 * make cross-version scorecard comparison meaningless.
 */
import type { GoldenCase, TrialExecutionState } from '@aflow/schemas';
import type { JudgeEvidence } from './judgeCall.js';
import {
  replyTextFrom,
  type GradableRunRecord,
  type GradableTaskRecord,
} from './evalTrialGrader.js';
import type { TrialRunSnapshot } from './evalBatchStore.js';

/**
 * Per-artifact cap on judge evidence (task outputs, reference output) so a
 * multi-output evidence pack stays inside one judge context window.
 */
export const JUDGE_EVIDENCE_MAX_CHARS = 6000;

/**
 * Identity of the evidence pack, folded into `judgeVersion`.
 *
 * A judge is its rubric, its model, its prompt template AND what it is shown.
 * Excluding the pause contract from task outputs changed verdicts on answers
 * that had not changed — and without this, that shift carried the same
 * judgeVersion as the batch before it, so a calibration measured on the old
 * pack would have silently kept its authority over the new one.
 *
 * Bump on any change to what the pack contains or how it is ordered.
 */
export const JUDGE_EVIDENCE_VERSION = 'reply-led-with-tool-results-1';

/**
 * Tool results are bounded twice: a cap on how many calls travel, and a
 * tighter per-body cap than other artifacts get. A run that made fifty calls
 * would otherwise push the reply out of the judge's context, and the reply is
 * the thing being judged.
 */
const MAX_TOOL_RESULTS = 12;
const TOOL_RESULT_MAX_CHARS = 1500;

export function boundJudgeEvidence(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null, null, 2);
  return text.length > JUDGE_EVIDENCE_MAX_CHARS
    ? `${text.slice(0, JUDGE_EVIDENCE_MAX_CHARS)}\n… [truncated]`
    : text;
}

export function extractRunFailureReason(failureJson: unknown): string | null {
  if (failureJson === null || failureJson === undefined) return null;
  if (typeof failureJson === 'string') return failureJson;
  if (typeof failureJson === 'object') {
    const record = failureJson as Record<string, unknown>;
    for (const key of ['message', 'reason', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    try {
      return JSON.stringify(failureJson).slice(0, 500);
    } catch {
      return null;
    }
  }
  return null;
}

/** The grader/judge view of a persisted trial run — snapshot rows, no IO. */
export function buildTrialRunRecord(
  snapshot: TrialRunSnapshot,
  campaignConfig: Record<string, unknown> | undefined,
): GradableRunRecord {
  return {
    status: snapshot.run.status as GradableRunRecord['status'],
    pausedReason: snapshot.run.pausedReason,
    pausedPayloadRef: snapshot.run.pausedPayloadRef,
    ...(snapshot.run.executionState !== null
      ? { executionState: snapshot.run.executionState as TrialExecutionState }
      : {}),
    failureReason: extractRunFailureReason(snapshot.run.failureJson),
    tasks: snapshot.tasks.map((t) => ({
      taskId: t.taskId,
      status: t.status,
      operationId: t.operationId,
      outputRef: t.outputRef,
      summary: t.summary,
      metrics: (t.metricsJson ?? null) as Record<string, unknown> | null,
      durationMs: t.durationMs,
      costCents: t.costCents,
      completedAtMs: t.completedAt?.getTime() ?? null,
    })),
    campaignConfig,
    simulationCalls: snapshot.simulationCalls,
  };
}

/** A pause contract rather than a produced result — recognised by its resume shape. */
function isPauseContract(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return 'resumeContract' in record || 'missingVariables' in record;
}

function selectRunScopeOutputTask(
  tasks: readonly GradableTaskRecord[],
): GradableTaskRecord | undefined {
  return [...tasks]
    .filter((t) => typeof t.outputRef === 'string' && t.outputRef.length > 0)
    .sort((a, b) => (a.completedAtMs ?? 0) - (b.completedAtMs ?? 0))
    .at(-1);
}

/**
 * D8 scoped evidence: the case's referenced task outputs plus the run-scope
 * output (the artifacts under judgment), the reference output when the case
 * carries one (guidance — similarity is never scored), and the run's task
 * summaries. `payloads` holds the refs the deterministic grader already
 * fetched; the run-scope output and reference are fetched on demand and
 * their absence never blocks judging.
 */
export async function buildCaseRubricJudgeEvidence(params: {
  goldenCase: GoldenCase;
  runRecord: GradableRunRecord;
  payloads: ReadonlyMap<string, unknown>;
  retrievePayload: (ref: string) => Promise<unknown>;
}): Promise<JudgeEvidence> {
  const { goldenCase, runRecord, payloads, retrievePayload } = params;

  const taskSummaries = runRecord.tasks.map((t) => ({
    taskId: t.taskId,
    status: t.status,
    ...(t.summary ? { summary: t.summary } : {}),
  }));

  const outputByRef = new Map<string, unknown>();
  for (const task of runRecord.tasks) {
    if (task.outputRef && payloads.has(task.outputRef)) {
      outputByRef.set(task.outputRef, payloads.get(task.outputRef));
    }
  }
  const runScopeTask = selectRunScopeOutputTask(runRecord.tasks);
  if (runScopeTask?.outputRef && !outputByRef.has(runScopeTask.outputRef)) {
    try {
      outputByRef.set(runScopeTask.outputRef, await retrievePayload(runScopeTask.outputRef));
    } catch {
      // Evidence stays summaries-based for this task; the judge still runs.
    }
  }
  const taskOutputs = runRecord.tasks.flatMap((t) => {
    if (!t.outputRef || !outputByRef.has(t.outputRef)) return [];
    const output = outputByRef.get(t.outputRef);
    // A paused turn's output IS its pause contract, whose prose already stands
    // above as the reply. Kept alongside it, its `missingVariables` and
    // `resumeContract` read as machinery reporting that nothing was produced,
    // and a judge shown both believes the machinery: four verdicts on answers
    // of several hundred words said no answer existed.
    if (isPauseContract(output)) return [];
    return [{ taskId: t.taskId, content: boundJudgeEvidence(output) }];
  });

  // The paused reply rides the prefetch the reply expectations already forced,
  // so judge and deterministic checks read one artifact and cannot disagree
  // about what was said.
  const reply = runRecord.pausedPayloadRef
    ? replyTextFrom(payloads.get(runRecord.pausedPayloadRef))
    : undefined;

  // What the tools told the agent, in call order. A judge asked whether a
  // reply is accurate decides it from here; without it, a correct fact it
  // cannot corroborate reads as an invention.
  const toolResults = (runRecord.simulationCalls ?? [])
    .slice(0, MAX_TOOL_RESULTS)
    .flatMap((call, index) => {
      if (!call.responseRef || !payloads.has(call.responseRef)) return [];
      const body = payloads.get(call.responseRef);
      const text = typeof body === 'string' ? body : JSON.stringify(body ?? null, null, 2);
      return [
        {
          sequence: index,
          endpointId: call.endpointId,
          status: call.responseStatus,
          body:
            text.length > TOOL_RESULT_MAX_CHARS
              ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… [truncated]`
              : text,
        },
      ];
    });

  let referenceOutput: string | undefined;
  const referenceRef = goldenCase.provenance.referenceOutputRef;
  if (referenceRef !== undefined) {
    try {
      referenceOutput = boundJudgeEvidence(await retrievePayload(referenceRef));
    } catch {
      // The reference is guidance; its absence never blocks judging.
    }
  }

  return {
    taskSummaries,
    ...(reply !== undefined ? { reply } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
    ...(taskOutputs.length > 0 ? { taskOutputs } : {}),
    ...(referenceOutput !== undefined ? { referenceOutput } : {}),
  };
}
