import { MEMORY_READ_BUDGET_CHARS } from '@aflow/memory-paths';
import { getOperation } from '@aflow/schemas';

/**
 * Arguments a tool requires to DIFFER on every call, so that a replay can be
 * told from a fresh attempt. They are the opposite of identity: including them
 * in the loop signature makes every repeat look novel.
 *
 * A Runner sent the identical draft_patch 130 times, each with a fresh
 * `mutationId`, and the repeat detector counted one consecutive call every
 * time. Extend this set when a new op adds a replay key.
 */
const REPLAY_KEY_ARG_NAMES: ReadonlySet<string> = new Set(['mutationId']);

export const SOFT_WARNING_IDENTICAL_CONSECUTIVE = 3;
export const HARD_PAUSE_IDENTICAL_CONSECUTIVE = 5;
export const SIGNATURE_WINDOW = 8;

/**
 * The same-target read rule counts reads of one stored target over the last
 * SAME_TARGET_WINDOW turns, whatever their jsonPath, view or version. A read
 * carrying a window argument pages the target and is not counted.
 */
export const SOFT_WARNING_SAME_TARGET_READS = 8;
export const HARD_PAUSE_SAME_TARGET_READS = 12;
export const SAME_TARGET_WINDOW = 16;

export interface SignatureCall {
  toolId: string;
  args?: unknown;
}

/** Maps a decision's toolId to the operation it runs. Defaults to the toolId itself. */
export type ResolveCallOperation = (toolId: string) => string | undefined;

const toolIdIsOperation: ResolveCallOperation = (toolId) => toolId;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readDottedPath(record: Record<string, unknown>, dottedPath: string): unknown {
  let cursor: unknown = record;
  for (const segment of dottedPath.split('.')) {
    const level = asRecord(cursor);
    if (!level) return undefined;
    cursor = level[segment];
  }
  return cursor;
}

function declaredReadTargetArgs(
  operationId: string | undefined,
): Readonly<Record<string, readonly string[]>> | undefined {
  return operationId === undefined ? undefined : getOperation(operationId)?.readTargetArgs;
}

function readsOneWindow(operationId: string, record: Record<string, unknown>): boolean {
  const windowArgs = getOperation(operationId)?.readWindowArgs ?? [];
  return windowArgs.some((arg) => readDottedPath(record, arg) !== undefined);
}

/** The arguments that identify one call: every argument except replay keys. */
export function signatureArgs(args: unknown): Record<string, unknown> {
  const record = asRecord(args) ?? {};
  return Object.fromEntries(Object.entries(record).filter(([k]) => !REPLAY_KEY_ARG_NAMES.has(k)));
}

/** What the identical-call rule compares one turn's tool calls against the last. */
export function buildCallSignature(calls: readonly SignatureCall[]): string {
  return calls
    .map((c) => `${c.toolId}:${JSON.stringify(signatureArgs(c.args))}`)
    .sort()
    .join('|');
}

/**
 * The stored target one call reads, as its operation declares it in
 * `readTargetArgs`, keyed by operation. Undefined for a call that reads no
 * declared target, names none of the declared parts, or reads one window of
 * the target through an argument in `readWindowArgs`.
 */
export function readTargetKey(operationId: string | undefined, args: unknown): string | undefined {
  const declared = declaredReadTargetArgs(operationId);
  if (operationId === undefined || !declared) return undefined;
  const record = asRecord(args) ?? {};
  if (readsOneWindow(operationId, record)) return undefined;
  const target: Record<string, unknown> = {};
  for (const [part, paths] of Object.entries(declared)) {
    for (const path of paths) {
      const value = readDottedPath(record, path);
      if (value !== undefined) {
        target[part] = value;
        break;
      }
    }
  }
  if (Object.keys(target).length === 0) return undefined;
  return `${operationId}:${JSON.stringify(target)}`;
}

/** The stored targets one turn's calls read, one entry per read. */
export function readTargetKeys(
  calls: readonly SignatureCall[],
  resolveOperation: ResolveCallOperation = toolIdIsOperation,
): string[] {
  return calls.flatMap((c) => {
    const key = readTargetKey(resolveOperation(c.toolId), c.args);
    return key === undefined ? [] : [key];
  });
}

/** True when any call reads a stored target its operation declares. */
export function readsStoredTarget(
  calls: readonly SignatureCall[],
  resolveOperation: ResolveCallOperation = toolIdIsOperation,
): boolean {
  return calls.some((c) => declaredReadTargetArgs(resolveOperation(c.toolId)) !== undefined);
}

export type RepeatVerdict = 'none' | 'warning' | 'final_warning' | 'pause';

function verdictFor(count: number, softWarning: number, hardPause: number): RepeatVerdict {
  if (count >= hardPause) return 'pause';
  if (count >= softWarning) return count === hardPause - 1 ? 'final_warning' : 'warning';
  return 'none';
}

export interface RepeatCount {
  /** The window after this signature is appended, oldest first. */
  recentSignatures: string[];
  /** How many of the newest entries equal this signature, this one included. */
  consecutiveCount: number;
  verdict: RepeatVerdict;
}

/** Appends one turn's signature to the window and says what the detector does about it. */
export function countRepeatedCall(
  previousSignatures: readonly string[],
  callSignature: string,
): RepeatCount {
  const recentSignatures = [...previousSignatures, callSignature].slice(-SIGNATURE_WINDOW);
  let consecutiveCount = 0;
  for (let i = recentSignatures.length - 1; i >= 0; i--) {
    if (recentSignatures[i] === callSignature) consecutiveCount++;
    else break;
  }
  const verdict = verdictFor(
    consecutiveCount,
    SOFT_WARNING_IDENTICAL_CONSECUTIVE,
    HARD_PAUSE_IDENTICAL_CONSECUTIVE,
  );
  return { recentSignatures, consecutiveCount, verdict };
}

export interface SameTargetCount {
  /** The window after this turn's reads are appended, one entry per turn, oldest first. */
  recentReadTargets: string[][];
  /** The target this turn read most often across the window, when it read any. */
  target?: string;
  /** How many reads of that target the window holds, this turn's included. */
  readCount: number;
  verdict: RepeatVerdict;
}

/**
 * Appends one turn's read targets to the window and says what the same-target
 * rule does about it. A turn that reads nothing still takes a slot, so the
 * window spans turns, not reads.
 */
export function countSameTargetReads(
  previousTurns: ReadonlyArray<readonly string[]>,
  turnTargets: readonly string[],
): SameTargetCount {
  const recentReadTargets = [...previousTurns.map((t) => [...t]), [...turnTargets]].slice(
    -SAME_TARGET_WINDOW,
  );
  let target: string | undefined;
  let readCount = 0;
  for (const candidate of new Set(turnTargets)) {
    const count = recentReadTargets.reduce(
      (sum, turn) => sum + turn.filter((t) => t === candidate).length,
      0,
    );
    if (count > readCount) {
      target = candidate;
      readCount = count;
    }
  }
  const verdict = verdictFor(
    readCount,
    SOFT_WARNING_SAME_TARGET_READS,
    HARD_PAUSE_SAME_TARGET_READS,
  );
  return { recentReadTargets, ...(target !== undefined ? { target } : {}), readCount, verdict };
}

function readBudgetAdvice(): string {
  return (
    `A read without maxBytes returns at most ${MEMORY_READ_BUDGET_CHARS.toLocaleString('en-US')} characters. ` +
    'To read a section whole, pass an explicit maxBytes large enough to hold it. ' +
    'To page a larger target, read it window by window with byteRange, lineRange or itemRange.'
  );
}

/**
 * The identical-call warning for a read of a stored target. It says how to
 * read more in one call, because a read without maxBytes returns a bounded
 * window and repeating it is the loop.
 */
export function repeatedReadWarning(consecutiveCount: number): string {
  return (
    `You have sent the same read of one target ${String(consecutiveCount)} times in a row. ` +
    readBudgetAdvice()
  );
}

/**
 * The same-target warning. It names the remedy, because reading one target
 * section by section is the loop this rule exists to stop.
 */
export function sameTargetReadWarning(readCount: number): string {
  return (
    `You have read one stored target ${String(readCount)} times in the last ` +
    `${String(SAME_TARGET_WINDOW)} turns. ` +
    'Read the target whole or by window, not section by section. ' +
    readBudgetAdvice()
  );
}

/** The rule that wrote a loop warning or failed the run. */
export type LoopRule = 'identical_call' | 'same_target';

/** One loop warning the next agent turn reads. Each rule writes its own. */
export interface LoopWarning {
  rule: LoopRule;
  repeatedActionCount: number;
  repeatedActionSignature: string;
  severity: 'warning' | 'final_warning';
  message: string;
  instruction: string;
}

function warningSeverity(verdict: RepeatVerdict): LoopWarning['severity'] | undefined {
  return verdict === 'warning' || verdict === 'final_warning' ? verdict : undefined;
}

/** The identical-call warning for this count, or undefined when the rule does not warn. */
export function identicalCallLoopWarning(
  count: RepeatCount,
  callSignature: string,
  readsTarget: boolean,
): LoopWarning | undefined {
  const severity = warningSeverity(count.verdict);
  if (severity === undefined) return undefined;
  const remainingBeforePause = HARD_PAUSE_IDENTICAL_CONSECUTIVE - count.consecutiveCount;
  return {
    rule: 'identical_call',
    repeatedActionCount: count.consecutiveCount,
    repeatedActionSignature: callSignature,
    severity,
    message: readsTarget
      ? repeatedReadWarning(count.consecutiveCount)
      : `You have invoked the exact same tool call ${String(count.consecutiveCount)} times in a row. ` +
        'Do not repeat it again unless the input has materially changed.',
    instruction:
      remainingBeforePause > 1
        ? `Choose a meaningfully different next action. ${String(remainingBeforePause)} more identical repeats will pause the run for user input.`
        : 'Choose a meaningfully different next action now. The next identical repeat will pause the run for user input.',
  };
}

/** The same-target warning for this count, or undefined when the rule does not warn. */
export function sameTargetLoopWarning(count: SameTargetCount): LoopWarning | undefined {
  const severity = warningSeverity(count.verdict);
  if (severity === undefined || count.target === undefined) return undefined;
  const remainingBeforePause = HARD_PAUSE_SAME_TARGET_READS - count.readCount;
  return {
    rule: 'same_target',
    repeatedActionCount: count.readCount,
    repeatedActionSignature: count.target,
    severity,
    message: sameTargetReadWarning(count.readCount),
    instruction:
      remainingBeforePause > 1
        ? `${String(remainingBeforePause)} more reads of this target within ${String(SAME_TARGET_WINDOW)} turns will pause the run for user input.`
        : `The next read of this target within ${String(SAME_TARGET_WINDOW)} turns will pause the run for user input.`,
  };
}

function identicalCallLogDetail(count: RepeatCount, callSignature: string): string {
  const repeats = `agent invoked "${callSignature}" ${String(count.consecutiveCount)} times consecutively. `;
  return count.verdict === 'pause'
    ? `${repeats}Failing run — harness blocked the agent.`
    : `${repeats}Giving model a chance to recover before pause at ${String(HARD_PAUSE_IDENTICAL_CONSECUTIVE)} repeats.`;
}

/** The log line for a same-target warning or pause, after the run id. */
export function sameTargetLogDetail(count: SameTargetCount): string {
  const reads =
    `agent read "${count.target ?? ''}" ${String(count.readCount)} times in ` +
    `${String(SAME_TARGET_WINDOW)} turns. `;
  return count.verdict === 'pause'
    ? `${reads}Failing run — harness blocked the agent.`
    : `${reads}Giving model a chance to recover before pause at ${String(HARD_PAUSE_SAME_TARGET_READS)} reads.`;
}

/** The run failure message when the same-target rule pauses. */
export function sameTargetPauseMessage(readCount: number): string {
  return (
    `The assistant read one stored target ${String(readCount)} times in ` +
    `${String(SAME_TARGET_WINDOW)} turns without reading it whole or by window. ` +
    'The run has been failed — start a new run with different instructions or fix the underlying issue.'
  );
}

/** What the two loop rules remember between turns of one agent step. */
export interface LoopTurnState {
  recentSignatures: string[];
  recentReadTargets: string[][];
}

/** A warning a rule wrote this turn, with the line to log for it. */
export interface LoggedLoopWarning {
  warning: LoopWarning;
  logDetail: string;
}

/** What the loop rules decide about one agent turn's tool calls. */
export interface LoopTurnVerdict {
  /** The windows after this turn, to persist for the next one. */
  state: LoopTurnState;
  identicalCall?: LoggedLoopWarning;
  sameTarget?: LoggedLoopWarning;
  /** Set when a rule pauses. The run fails and no warning is surfaced. */
  failure?: { rule: LoopRule; message: string; logDetail: string };
}

/**
 * Runs both loop rules over one turn's tool calls. Each rule writes its own
 * warning, so a turn that trips both carries two. A pause from either rule
 * fails the run.
 */
export function evaluateLoopTurn(
  previous: LoopTurnState,
  calls: readonly SignatureCall[],
  resolveOperation: ResolveCallOperation = toolIdIsOperation,
): LoopTurnVerdict {
  const callSignature = buildCallSignature(calls);
  const identical = countRepeatedCall(previous.recentSignatures, callSignature);
  const sameTarget = countSameTargetReads(
    previous.recentReadTargets,
    readTargetKeys(calls, resolveOperation),
  );
  const state: LoopTurnState = {
    recentSignatures: identical.recentSignatures,
    recentReadTargets: sameTarget.recentReadTargets,
  };

  if (identical.verdict === 'pause') {
    return {
      state,
      failure: {
        rule: 'identical_call',
        message:
          `The assistant attempted the same action ${String(identical.consecutiveCount)} times in a row without progress. ` +
          'The run has been failed — start a new run with different instructions or fix the underlying issue.',
        logDetail: identicalCallLogDetail(identical, callSignature),
      },
    };
  }
  if (sameTarget.verdict === 'pause') {
    return {
      state,
      failure: {
        rule: 'same_target',
        message: sameTargetPauseMessage(sameTarget.readCount),
        logDetail: sameTargetLogDetail(sameTarget),
      },
    };
  }

  const identicalWarning = identicalCallLoopWarning(
    identical,
    callSignature,
    readsStoredTarget(calls, resolveOperation),
  );
  const sameTargetWarning = sameTargetLoopWarning(sameTarget);
  return {
    state,
    ...(identicalWarning !== undefined
      ? {
          identicalCall: {
            warning: identicalWarning,
            logDetail: identicalCallLogDetail(identical, callSignature),
          },
        }
      : {}),
    ...(sameTargetWarning !== undefined
      ? {
          sameTarget: { warning: sameTargetWarning, logDetail: sameTargetLogDetail(sameTarget) },
        }
      : {}),
  };
}
