/**
 * The cursor watch_session and inspect_session hand back: the session's state
 * at that call, so a later call returns only the steps that are new, or whose
 * status changed, since.
 *
 * It remembers each step by id, with the last status actually read for it, so
 * it survives the debug view switching between the hot state's step list and
 * the one its events name. NOT_READ and HOT_STATE_EXPIRED say what a read could
 * not see, not what the step did: a remembered step read as either is
 * unchanged and keeps the status remembered for it, so a later read that does
 * see a change still reports it. A step the cursor does not hold is new
 * whatever its status. Each step is a short hash of its id and of its status,
 * not the id itself: a long conversation names hundreds of steps, and a cursor
 * spelling their ids out would outweigh the bounded answer it travels with.
 */

import { createHash } from 'node:crypto';
import { STEP_HOT_STATE_EXPIRED, STEP_STATUS_NOT_READ, type StepSummary } from './sessionViews.js';

export interface SessionCursor {
  status: string;
  /** Hash of a step's id → hash of the last status read for it. */
  seen: ReadonlyMap<string, string>;
}

const VERSION = 's4';
const ID_CHARS = 6;
const STATUS_CHARS = 2;
const ENTRY_CHARS = ID_CHARS + STATUS_CHARS;
const CURSOR_SHAPE = /^s4\.([A-Z_]+)\.((?:[A-Za-z0-9_-]{8})*)$/;

const UNREADABLE_STATUSES: ReadonlySet<string> = new Set([
  STEP_STATUS_NOT_READ,
  STEP_HOT_STATE_EXPIRED,
]);

function shortHash(value: string, chars: number): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, chars);
}

function idKey(step: StepSummary): string {
  return shortHash(step.step_id, ID_CHARS);
}

export function statusKey(status: string): string {
  return shortHash(status, STATUS_CHARS);
}

function unreadable(step: StepSummary): boolean {
  return UNREADABLE_STATUSES.has(step.status);
}

/**
 * What the cursor remembers after a read of `steps`: every step it held
 * before, and each step read under its status — or, where that status could
 * not be read and the step was already held, under the status held for it.
 */
export function rememberSteps(
  cursor: SessionCursor | undefined,
  steps: readonly StepSummary[],
): Map<string, string> {
  const seen = new Map(cursor?.seen);
  for (const step of steps) {
    const id = idKey(step);
    if (unreadable(step) && seen.has(id)) continue;
    seen.set(id, statusKey(step.status));
  }
  return seen;
}

export function encodeSessionCursor(status: string, seen: ReadonlyMap<string, string>): string {
  let packed = '';
  for (const [id, stepStatus] of seen) packed += id + stepStatus;
  return `${VERSION}.${status}.${packed}`;
}

/** An unreadable or foreign cursor reads as none: steps are sent again rather than lost. */
export function decodeSessionCursor(raw: string | undefined): SessionCursor | undefined {
  if (!raw) return undefined;
  const match = CURSOR_SHAPE.exec(raw);
  if (!match) return undefined;
  const packed = match[2] ?? '';
  const seen = new Map<string, string>();
  for (let i = 0; i < packed.length; i += ENTRY_CHARS) {
    seen.set(packed.slice(i, i + ID_CHARS), packed.slice(i + ID_CHARS, i + ENTRY_CHARS));
  }
  return { status: match[1] ?? '', seen };
}

/** The steps the cursor does not hold, or holds under a status other than the one now read. */
export function stepsNotSeen(
  cursor: SessionCursor | undefined,
  steps: readonly StepSummary[],
): StepSummary[] {
  if (!cursor) return [...steps];
  return steps.filter((step) => {
    const held = cursor.seen.get(idKey(step));
    if (held === undefined) return true;
    return !unreadable(step) && held !== statusKey(step.status);
  });
}
