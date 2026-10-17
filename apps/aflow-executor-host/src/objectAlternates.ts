/**
 * The object stores a git object store borrows from through
 * `info/alternates`, read as git reads them.
 */
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** An entry in git's C-style quoting, unquoted; undefined when it is not one. */
function unquotedC(entry: string): string | undefined {
  const bytes: number[] = [];
  for (let i = 1; i < entry.length; i += 1) {
    const char = entry.charAt(i);
    if (char === '"') {
      return i === entry.length - 1 ? Buffer.from(bytes).toString('utf8') : undefined;
    }
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const octal = /^[0-3][0-7]{2}/.exec(entry.slice(i + 1));
    const escaped = C_ESCAPES[entry.charAt(i + 1)];
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else if (escaped !== undefined) {
      bytes.push(escaped);
      i += 1;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** The stores `store`'s `info/alternates` names, as git reads them, unresolved. */
async function alternatesOf(store: string): Promise<string[]> {
  const text = await readFile(join(store, 'info', 'alternates'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((entry) => entry !== '' && !entry.startsWith('#'))
    .map((entry) => (entry.startsWith('"') ? (unquotedC(entry) ?? entry) : entry))
    .map((entry) => resolvePath(store, entry));
}

/**
 * Appends to `stores` each store `store` borrows from, resolved, following
 * `info/alternates` as git does: depth first, an entry relative to the store
 * naming it, a store missing or already named skipped. Stops at the first store
 * `levels` levels below `store` that still borrows a store existing and not yet
 * named, and resolves to it; resolves to undefined once the whole chain is
 * followed. A store whose entries name only missing or already-named stores
 * holds nothing a clone would miss, however deep it lies.
 */
export async function appendAlternateStores(
  store: string,
  levels: number,
  stores: string[],
  level = 0,
): Promise<string | undefined> {
  for (const entry of await alternatesOf(store)) {
    const resolved = await realpath(entry).catch(() => undefined);
    if (resolved === undefined || stores.includes(resolved)) continue;
    if (level >= levels) return store;
    stores.push(resolved);
    const tooDeep = await appendAlternateStores(resolved, levels, stores, level + 1);
    if (tooDeep !== undefined) return tooDeep;
  }
  return undefined;
}
