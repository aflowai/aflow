/**
 * The signal that tells failure accounting a repair is converging.
 *
 * Two caps end a repair loop and prose defeats neither: the consecutive-failure
 * counter compares only the first 500 characters of the message, and the total
 * counter never resets. So progress is stated structurally, at the front of the
 * message, in a form both the writer and the accounting read from here — a
 * second spelling of this marker would silently stop matching.
 */
const MARKER = /^\[draft rev (\d+) · (\d+) unmet\]/;

export interface DraftRepairProgress {
  revision: number;
  unmet: number;
}

export function formatDraftRepairProgress(p: DraftRepairProgress): string {
  return `[draft rev ${String(p.revision)} · ${String(p.unmet)} unmet]`;
}

export function parseDraftRepairProgress(message: string | undefined): DraftRepairProgress | null {
  if (!message) return null;
  const m = MARKER.exec(message);
  if (!m) return null;
  return { revision: Number(m[1]), unmet: Number(m[2]) };
}

/**
 * A submission is repair when it is built on a later draft and fails on
 * strictly fewer counts. Anything else — same revision, same or more problems,
 * or no marker at all — is repetition and consumes the budget as before.
 */
export function isDraftRepair(
  previousMessage: string | undefined,
  currentMessage: string | undefined,
): boolean {
  const prev = parseDraftRepairProgress(previousMessage);
  const next = parseDraftRepairProgress(currentMessage);
  if (!prev || !next) return false;
  return next.revision > prev.revision && next.unmet < prev.unmet;
}
