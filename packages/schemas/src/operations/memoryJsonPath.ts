/**
 * The `jsonPath` grammar the memory read ops admit — the dotted/bracket subset
 * `parseDottedPath` in `@aflow/memory-paths` drills with — and the teaching
 * refusals for what falls outside it.
 */

export const MAX_ITEM_RANGE_COUNT = 200;

const JSON_PATH_GRAMMAR =
  `jsonPath names one value: keys and array indices joined by '.' or '[n]', ` +
  `e.g. "entries", "entries[3]", "ledger.entries[3].amount"`;

const SLICE_SEGMENT = /^(-?\d*):(-?\d*)(?::-?\d*)?$/;

function sliceRefusal(path: string, slice: RegExpExecArray, arrayPath: string): string {
  const segment = slice[0];
  const quotedKey = `${arrayPath === '$' ? '' : arrayPath}["${segment}"]`;
  const start = slice[1] === '' ? 0 : Number(slice[1]);
  const end = slice[2] === '' ? undefined : Number(slice[2]);
  const range =
    start >= 0 && end !== undefined && end > start
      ? `itemRange: { start: ${String(start)}, count: ${String(end - start)} }`
      : start >= 0
        ? `itemRange: { start: ${String(start)}, count: <how many> }`
        : 'itemRange: { start, count }';
  const target =
    arrayPath === '' || arrayPath === '$'
      ? 'leave jsonPath out (the document itself is the array)'
      : `set jsonPath to the array ("${arrayPath}")`;
  return (
    `jsonPath '${path}' is a slice, and jsonPath does not take slices. ${JSON_PATH_GRAMMAR}. ` +
    `For a range of items, ${target} and ${range} (count at most ${String(MAX_ITEM_RANGE_COUNT)}). ` +
    `If '${segment}' is an object key rather than a range, quote it in brackets: ${quotedKey}.`
  );
}

function grammarRefusal(path: string, reason: string): string {
  return (
    `jsonPath '${path}' is not a path a read takes: ${reason}. ${JSON_PATH_GRAMMAR} — ` +
    `no slices, wildcards or filters. For a range of items, point jsonPath at the array and ` +
    `set itemRange: { start, count }.`
  );
}

/**
 * Why a `jsonPath` falls outside the dotted/bracket subset the memory reads
 * drill with (`parseDottedPath` in `@aflow/memory-paths`), or null when it is
 * inside it. Refused here so a JSONPath slice or wildcard is answered with the
 * grammar and the field that does take a range, rather than a not-found.
 */
export function jsonPathRefusal(path: string): string | null {
  let i = path.startsWith('$') ? 1 : 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i++;
      continue;
    }
    if (ch === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) return grammarRefusal(path, `'[' at position ${String(i)} is never closed`);
      const inner = path.slice(i + 1, close).trim();
      const quoted =
        inner.length >= 2 &&
        ((inner.startsWith("'") && inner.endsWith("'")) ||
          (inner.startsWith('"') && inner.endsWith('"')));
      if (!quoted && !/^\d+$/.test(inner)) {
        const slice = SLICE_SEGMENT.exec(inner);
        if (slice) return sliceRefusal(path, slice, path.slice(0, i));
        return grammarRefusal(path, `[${inner}] is neither an array index nor a quoted key`);
      }
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    const key = path.slice(i, j);
    const slice = SLICE_SEGMENT.exec(key);
    if (slice) return sliceRefusal(path, slice, path.slice(0, i).replace(/\.$/, ''));
    if (key === '*') return grammarRefusal(path, `'*' is a wildcard`);
    i = j;
  }
  return null;
}
