/**
 * Where a prompt names the references a render is conditioned on.
 *
 * A route that reads references as named entities is told each one's name and
 * then reads the prompt for it, so "the prompt says this name" is a property of
 * the request rather than of any one provider. It lives here because two places
 * need the same answer from it — the adapter that rewrites the prompt into the
 * route's own markers, and the authoring surface that refuses a shot whose
 * prompt has stopped naming a character it carries. Two implementations of the
 * same rule would let a shot pass one and fail the other.
 */

/** A character of a name, rather than a fragment of a longer one. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

export interface NamedLabelSpan {
  label: string;
  /** Index of the first character of the name in the prompt. */
  start: number;
  /** Index just past its last character. */
  end: number;
}

function namesSomethingAt(prompt: string, start: number, length: number): boolean {
  const before = start > 0 ? prompt[start - 1]! : '';
  const after = start + length < prompt.length ? prompt[start + length]! : '';
  return !WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after);
}

/**
 * Every place the prompt names one of these labels, in reading order and never
 * overlapping.
 *
 * One left-to-right pass taking the longest label that names something at each
 * position. Scanning label by label instead lets a short name eat a longer one
 * containing it — 'Ana' consumes the 'Ana' inside 'Anabel', and Anabel is then
 * carried by the request while the prompt never says her name. The boundary
 * check is the other half: without it 'Al' renames the 'al' in 'mall'.
 */
export function findNamedLabels(
  prompt: string,
  labels: readonly string[],
): readonly NamedLabelSpan[] {
  // An empty label matches at every position and would never advance the scan.
  const byLength = [...new Set(labels)].filter((label) => label.length > 0);
  byLength.sort((left, right) => right.length - left.length);

  const spans: NamedLabelSpan[] = [];
  let at = 0;
  while (at < prompt.length) {
    const match = byLength.find(
      (label) => prompt.startsWith(label, at) && namesSomethingAt(prompt, at, label.length),
    );
    if (match === undefined) {
      at += 1;
      continue;
    }
    spans.push({ label: match, start: at, end: at + match.length });
    at += match.length;
  }
  return spans;
}
