/**
 * The cursor watch_session and inspect_session hand back: what the caller has
 * seen of a session, so the next call returns only what is new.
 *
 * It records each step as seen in one status, keyed by id rather than position
 * so it survives the debug view switching between the hot state's step list
 * and the one its events name, and re-delivers a step whose status changed in
 * place. Each pair is a short hash, not the step id itself: a long conversation
 * names hundreds of steps, and a cursor spelling their ids out would outweigh
 * the bounded answer it travels with.
 */

import { createHash } from 'node:crypto';
import type { StepSummary } from './sessionViews.js';

export interface SessionCursor {
  status: string;
  seen: ReadonlySet<string>;
}

const VERSION = 's3';
const HASH_CHARS = 6;
const CURSOR_SHAPE = /^s3\.([A-Z_]+)\.((?:[A-Za-z0-9_-]{6})*)$/;

function seenKey(step: StepSummary): string {
  return createHash('sha256')
    .update(`${step.step_id}\0${step.status}`)
    .digest('base64url')
    .slice(0, HASH_CHARS);
}

export function seenSteps(steps: readonly StepSummary[]): Set<string> {
  return new Set(steps.map(seenKey));
}

export function encodeSessionCursor(status: string, seen: ReadonlySet<string>): string {
  return `${VERSION}.${status}.${[...seen].join('')}`;
}

/** An unreadable or foreign cursor reads as none: steps are sent again rather than lost. */
export function decodeSessionCursor(raw: string | undefined): SessionCursor | undefined {
  if (!raw) return undefined;
  const match = CURSOR_SHAPE.exec(raw);
  if (!match) return undefined;
  const packed = match[2] ?? '';
  const seen = new Set<string>();
  for (let i = 0; i < packed.length; i += HASH_CHARS) seen.add(packed.slice(i, i + HASH_CHARS));
  return { status: match[1] ?? '', seen };
}

/** The steps the caller has not seen in their current status. */
export function stepsNotSeen(
  cursor: SessionCursor | undefined,
  steps: readonly StepSummary[],
): StepSummary[] {
  if (!cursor) return [...steps];
  return steps.filter((s) => !cursor.seen.has(seenKey(s)));
}
