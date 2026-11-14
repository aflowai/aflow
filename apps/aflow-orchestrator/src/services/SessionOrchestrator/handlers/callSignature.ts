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
 * SAME_TARGET_WINDOW turns, whatever their jsonPath, view or window. Paging
 * one large document by window counts too, so the thresholds sit well above
 * a normal paging.
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
 * declared target, or names none of the declared parts.
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
