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
 * SAME_TARGET_WINDOW turns, whatever their jsonPath, view, version or
 * maxBytes. A read carrying a window argument (`readWindowArgs`) pages the
 * target, so the pages of one selection count once together and a long
 * paging runs to completion. Each new selection paged counts again, so
 * paging one section after another is still section-by-section reading.
 *
 * Mapping one document takes a model about 8 sections, so the rule warns
 * there. At 12 the reads have outrun any plausible map, and the rule fails
 * the run. The window of 16 turns spans the reads an agent clears from
 * context and then repeats.
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

function declaredReadWindowArgs(operationId: string): readonly string[] {
  return getOperation(operationId)?.readWindowArgs ?? [];
}

/** A copy of the record without the value at one dotted path. */
function withoutDottedPath(
  record: Record<string, unknown>,
  dottedPath: string,
): Record<string, unknown> {
  const [head, ...rest] = dottedPath.split('.');
  if (head === undefined || !(head in record)) return record;
  const { [head]: value, ...others } = record;
  if (rest.length === 0) return others;
  const level = asRecord(value);
  if (!level) return record;
  const inner = withoutDottedPath(level, rest.join('.'));
  return Object.keys(inner).length === 0 ? others : { ...others, [head]: inner };
}

/**
 * What a windowed read selects inside its target: every argument except the
 * target, the window and replay keys. The pages of one selection agree on
 * it, and paging a new section changes it.
 */
function windowedSelection(
  record: Record<string, unknown>,
  targetPaths: readonly string[],
  windowArgs: readonly string[],
): string {
  let selection = signatureArgs(record);
  for (const path of [...targetPaths, ...windowArgs]) {
    selection = withoutDottedPath(selection, path);
  }
  return canonicalJson(selection);
}

/** JSON with object keys sorted, so two spellings of one selection agree. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = asRecord(value);
  if (!record) return value === undefined ? 'null' : JSON.stringify(value);
  const entries = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Separates a windowed entry's target from its selection. JSON never holds a
 * raw newline, so no target key contains it.
 */
const WINDOWED_ENTRY_SEPARATOR = '\n';

/** The target a same-target window entry reads. */
export function entryTarget(entry: string): string {
  const cut = entry.indexOf(WINDOWED_ENTRY_SEPARATOR);
  return cut === -1 ? entry : entry.slice(0, cut);
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
 * declared target or names none of the declared parts.
 */
export function readTargetKey(operationId: string | undefined, args: unknown): string | undefined {
  const declared = declaredReadTargetArgs(operationId);
  if (operationId === undefined || !declared) return undefined;
  const record = asRecord(args) ?? {};
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

/**
 * What the same-target window records for one read. An unwindowed read is
 * its target key, and every one counts. A read carrying a window argument is
 * its target key with its selection, and the pages of one selection count
 * once together.
 */
export function readTargetEntry(
  operationId: string | undefined,
  args: unknown,
): string | undefined {
  const target = readTargetKey(operationId, args);
  if (operationId === undefined || target === undefined) return undefined;
  const record = asRecord(args) ?? {};
  const windowArgs = declaredReadWindowArgs(operationId);
  if (!windowArgs.some((arg) => readDottedPath(record, arg) !== undefined)) return target;
  const targetPaths = Object.values(declaredReadTargetArgs(operationId) ?? {}).flat();
  return `${target}${WINDOWED_ENTRY_SEPARATOR}${windowedSelection(record, targetPaths, windowArgs)}`;
}

/** The same-target entries one turn's calls record, one per read. */
export function readTargetEntries(
  calls: readonly SignatureCall[],
  resolveOperation: ResolveCallOperation = toolIdIsOperation,
): string[] {
  return calls.flatMap((c) => {
    const entry = readTargetEntry(resolveOperation(c.toolId), c.args);
    return entry === undefined ? [] : [entry];
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

/**
 * A rule pauses only once it has given its final warning, which it gives
 * when the count reaches hardPause - 1 or more. The same-target count rises
 * by every parallel read in a turn, so it can pass hardPause - 1 in one
 * turn. That turn gets the final warning, and the next read pauses.
 */
function verdictFor(
  count: number,
  previousCount: number,
  softWarning: number,
  hardPause: number,
): RepeatVerdict {
  if (count >= hardPause && previousCount >= hardPause - 1) return 'pause';
  if (count >= hardPause - 1) return 'final_warning';
  if (count >= softWarning) return 'warning';
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
    consecutiveCount - 1,
    SOFT_WARNING_IDENTICAL_CONSECUTIVE,
    HARD_PAUSE_IDENTICAL_CONSECUTIVE,
  );
  return { recentSignatures, consecutiveCount, verdict };
}

export interface SameTargetCount {
  /** The window after this turn's read entries are appended, one list per turn, oldest first. */
  recentReadTargets: string[][];
  /** The target this turn read most often across the window, when it read any. */
  target?: string;
  /** How many reads of that target the window holds, this turn's included. */
  readCount: number;
  verdict: RepeatVerdict;
}

/**
 * How many reads of one target the entries hold: its unwindowed reads plus
 * the distinct selections it was paged by.
 */
function countReadsOf(entries: readonly string[], target: string): number {
  const unwindowed = entries.filter((e) => e === target).length;
  const pagedSelections = new Set(entries.filter((e) => e !== target && entryTarget(e) === target))
    .size;
  return unwindowed + pagedSelections;
}

/**
 * Appends one turn's read entries to the window and says what the
 * same-target rule does about it. A turn that reads nothing still takes a
 * slot, so the window spans turns, not reads.
 */
export function countSameTargetReads(
  previousTurns: ReadonlyArray<readonly string[]>,
  turnEntries: readonly string[],
): SameTargetCount {
  const previousWindow = previousTurns.slice(-SAME_TARGET_WINDOW);
  const recentReadTargets = [...previousWindow.map((t) => [...t]), [...turnEntries]].slice(
    -SAME_TARGET_WINDOW,
  );
  const windowEntries = recentReadTargets.flat();
  let target: string | undefined;
  let readCount = 0;
  for (const candidate of new Set(turnEntries.map(entryTarget))) {
    const count = countReadsOf(windowEntries, candidate);
    if (count > readCount) {
      target = candidate;
      readCount = count;
    }
  }
  const previousCount = target === undefined ? 0 : countReadsOf(previousWindow.flat(), target);
  const verdict = verdictFor(
    readCount,
    previousCount,
    SOFT_WARNING_SAME_TARGET_READS,
    HARD_PAUSE_SAME_TARGET_READS,
  );
  return { recentReadTargets, ...(target !== undefined ? { target } : {}), readCount, verdict };
}

/**
 * The identical-call warning for a read of a stored target. It says how to
 * read more in one call, because a read without maxBytes returns a bounded
 * window and repeating it is the loop. A read that follows it with maxBytes
 * still counts toward the same-target rule.
 */
export function repeatedReadWarning(consecutiveCount: number): string {
  return (
    `You have sent the same read of one target ${String(consecutiveCount)} times in a row. ` +
    `A read without maxBytes returns at most ${MEMORY_READ_BUDGET_CHARS.toLocaleString('en-US')} characters. ` +
    'To read a section whole, pass an explicit maxBytes large enough to hold it. ' +
    'To page a larger target, read it window by window with byteRange, lineRange or itemRange.'
  );
}

/**
 * The same-target warning. It names the remedy, because reading one target
 * section by section is the loop this rule exists to stop. Each remedy it
 * names either stays counted or pages the target, so a model that follows
 * it stays inside the rule.
 */
export function sameTargetReadWarning(readCount: number): string {
  return (
    `You have read one stored target ${String(readCount)} times in the last ` +
    `${String(SAME_TARGET_WINDOW)} turns. ` +
    'Read the target whole or by window, not section by section. ' +
    `A read without maxBytes returns at most ${MEMORY_READ_BUDGET_CHARS.toLocaleString('en-US')} characters. ` +
    'To read the target whole, send one read with a maxBytes large enough to hold it. ' +
    'Every read with maxBytes still counts toward this limit. ' +
    'To page a larger target, read it window by window with byteRange, lineRange or itemRange. ' +
    'The pages of one jsonPath count once, and each new jsonPath counts again.'
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

/** The runtime-state variables the loop rules keep for one agent step. */
export function loopVarKeys(stepId: string): {
  recentSignatures: string;
  recentReadTargets: string;
  identicalCallWarning: string;
  sameTargetWarning: string;
} {
  return {
    recentSignatures: `ai.agent.recentCallSignatures.${stepId}`,
    recentReadTargets: `ai.agent.recentReadTargets.${stepId}`,
    identicalCallWarning: `ai.agent.loopWarning.${stepId}`,
    sameTargetWarning: `ai.agent.sameTargetWarning.${stepId}`,
  };
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
    readTargetEntries(calls, resolveOperation),
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
