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

function declaredSignatureArgs(operationId: string | undefined): readonly string[] | undefined {
  return operationId === undefined ? undefined : getOperation(operationId)?.decisionSignatureArgs;
}

/**
 * The arguments that identify one call. An operation that declares
 * `decisionSignatureArgs` is identified by those paths alone. Any other
 * operation is identified by every argument except replay keys.
 */
export function signatureArgs(
  operationId: string | undefined,
  args: unknown,
): Record<string, unknown> {
  const record = asRecord(args) ?? {};
  const declared = declaredSignatureArgs(operationId);
  if (!declared) {
    return Object.fromEntries(Object.entries(record).filter(([k]) => !REPLAY_KEY_ARG_NAMES.has(k)));
  }
  const identity: Record<string, unknown> = {};
  for (const path of declared) {
    const value = readDottedPath(record, path);
    if (value !== undefined) identity[path] = value;
  }
  return identity;
}

/** What the loop detector compares one turn's tool calls against the last. */
export function buildCallSignature(
  calls: readonly SignatureCall[],
  resolveOperation: ResolveCallOperation = toolIdIsOperation,
): string {
  return calls
    .map((c) => `${c.toolId}:${JSON.stringify(signatureArgs(resolveOperation(c.toolId), c.args))}`)
    .sort()
    .join('|');
}

/** True when any call is identified by a declared signature rather than its full arguments. */
export function hasDeclaredSignature(
  calls: readonly SignatureCall[],
  resolveOperation: ResolveCallOperation = toolIdIsOperation,
): boolean {
  return calls.some((c) => declaredSignatureArgs(resolveOperation(c.toolId)) !== undefined);
}

export type RepeatVerdict = 'none' | 'warning' | 'final_warning' | 'pause';

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
  let verdict: RepeatVerdict = 'none';
  if (consecutiveCount >= HARD_PAUSE_IDENTICAL_CONSECUTIVE) verdict = 'pause';
  else if (consecutiveCount >= SOFT_WARNING_IDENTICAL_CONSECUTIVE) {
    verdict =
      consecutiveCount === HARD_PAUSE_IDENTICAL_CONSECUTIVE - 1 ? 'final_warning' : 'warning';
  }
  return { recentSignatures, consecutiveCount, verdict };
}
