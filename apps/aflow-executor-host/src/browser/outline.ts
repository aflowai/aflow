/**
 * The page as an agent reads it by default: its headings and the elements it
 * can act on, in document order, each with its reference.
 *
 * A whole-page snapshot runs to tens of thousands of tokens on an ordinary
 * page; this keeps the part an action can name and leaves the text to be asked
 * for. Past the bound it stops and counts what it left out, by role, so the
 * agent knows what kind of thing it is not seeing.
 */
import { BROWSER_OUTLINE_DEFAULT_CHARS, BROWSER_SNAPSHOT_DEFAULT_CHARS } from '@aflow/schemas';

import { encodedLength } from './encodedLength.js';
import type { PageSnapshot } from './types.js';

export const OUTLINE_INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'switch',
  'slider',
  'spinbutton',
]);

const OUTLINE_ROLES: ReadonlySet<string> = new Set([...OUTLINE_INTERACTIVE_ROLES, 'heading']);

/** Attributes that describe the pointer rather than the element. */
const DROPPED_ATTRIBUTE_PREFIX = 'cursor=';

export interface Outline {
  readonly text: string;
  /** Elements the text carries. */
  readonly elements: number;
  /** Present only when the bound was reached: what was left out, by role. */
  readonly census?: Readonly<Record<string, number>>;
}

interface SnapshotNode {
  readonly indent: number;
  readonly role: string;
  readonly name?: string;
  readonly attributes: string[];
  readonly value?: string;
}

/** A YAML single-quoted scalar, as the snapshot writes a key that needs quoting. */
function unquoteSingle(text: string): { value: string; rest: string } | undefined {
  let value = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "'") {
      if (text[i + 1] === "'") {
        value += "'";
        i += 1;
        continue;
      }
      return { value, rest: text.slice(i + 1) };
    }
    value += ch;
  }
  return undefined;
}

/** A double-quoted string with JSON escapes, which is how a name is written. */
function readQuoted(text: string): { value: string; rest: string } | undefined {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '"') {
      try {
        return { value: JSON.parse(text.slice(0, i + 1)) as string, rest: text.slice(i + 1) };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function parseKey(
  key: string,
): { role: string; name?: string; attributes: string[]; rest: string } | undefined {
  const role = /^([a-z/][a-z]*)/.exec(key)?.[1];
  if (role === undefined) return undefined;
  let rest = key.slice(role.length);
  let name: string | undefined;
  if (rest.startsWith(' "')) {
    const quoted = readQuoted(rest.slice(1));
    if (quoted === undefined) return undefined;
    name = quoted.value;
    rest = quoted.rest;
  }
  const attributes: string[] = [];
  for (let match = /^ \[([^\]]*)\]/.exec(rest); match; match = /^ \[([^\]]*)\]/.exec(rest)) {
    attributes.push(match[1] ?? '');
    rest = rest.slice(match[0].length);
  }
  return { role, ...(name !== undefined ? { name } : {}), attributes, rest };
}

function parseLine(line: string): SnapshotNode | undefined {
  const match = /^(\s*)- (.*)$/.exec(line);
  if (match === null) return undefined;
  const indent = match[1]?.length ?? 0;
  let body = match[2] ?? '';
  if (body.startsWith("'")) {
    const quoted = unquoteSingle(body);
    if (quoted === undefined) return undefined;
    body = quoted.value + quoted.rest;
  }
  const key = parseKey(body);
  if (key === undefined) return undefined;
  const value = /^:\s*(.*)$/.exec(key.rest)?.[1];
  return {
    indent,
    role: key.role,
    ...(key.name !== undefined ? { name: key.name } : {}),
    attributes: key.attributes,
    ...(value !== undefined && value !== '' ? { value } : {}),
  };
}

function refOf(node: SnapshotNode): string | undefined {
  return node.attributes.find((a) => a.startsWith('ref='))?.slice('ref='.length);
}

function render(node: SnapshotNode, url: string | undefined, masked: boolean): string {
  const parts = [`- ${node.role}`];
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(node.name));
  for (const attribute of node.attributes) {
    if (!attribute.startsWith(DROPPED_ATTRIBUTE_PREFIX)) parts.push(`[${attribute}]`);
  }
  if (url !== undefined) parts.push(`[url=${url}]`);
  const line = parts.join(' ');
  return node.value !== undefined && !masked ? `${line}: ${node.value}` : line;
}

interface Line {
  readonly role: string;
  line: string;
}

/** A line joined after another costs its own length and the escaped line break before it. */
const SEPARATOR_COST = 2;

function censusLine(
  what: string,
  census: Record<string, number>,
  maxChars: number,
  remedy: string,
): string {
  const counted = Object.entries(census)
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([role, count]) => `${role} ${String(count)}`)
    .join(', ');
  return `# ${what} cut at ${String(maxChars)} characters. Not shown: ${counted}. ${remedy}`;
}

/**
 * Lines in order until the bound, then a census of the rest by role — the
 * census inside the bound too. The bound counts characters as the result
 * carries them.
 */
function cutToBound(
  what: string,
  entries: readonly Line[],
  maxChars: number,
  remedy: (kept: number) => string,
): { text: string; lines: number; census?: Record<string, number> } {
  const costs = entries.map((entry) => encodedLength(entry.line));
  const total =
    costs.reduce((sum, cost) => sum + cost, 0) + SEPARATOR_COST * Math.max(0, entries.length - 1);
  if (total <= maxChars) {
    return { text: entries.map((entry) => entry.line).join('\n'), lines: entries.length };
  }

  const census: Record<string, number> = {};
  let kept = entries.length;
  let length = total;
  const withhold = (): void => {
    kept -= 1;
    const entry = entries[kept];
    if (entry === undefined) return;
    census[entry.role] = (census[entry.role] ?? 0) + 1;
    length -= (costs[kept] ?? 0) + (kept > 0 ? SEPARATOR_COST : 0);
  };
  const closing = (): string => censusLine(what, census, maxChars, remedy(kept));
  while (kept > 0 && length > maxChars) withhold();
  while (kept > 0 && length + SEPARATOR_COST + encodedLength(closing()) > maxChars) withhold();
  return {
    text: [...entries.slice(0, kept).map((entry) => entry.line), closing()].join('\n'),
    lines: kept,
    census,
  };
}

const OUTLINE_REMEDY =
  'browser.page.snapshot with a `ref` shows one region whole, or raise `maxChars`.';

export function buildOutline(
  snapshot: PageSnapshot,
  maxChars: number = BROWSER_OUTLINE_DEFAULT_CHARS,
): Outline {
  const kept: Line[] = [];
  let previous: { node: SnapshotNode; keptIndex?: number } | undefined;
  for (const raw of snapshot.text.split('\n')) {
    const node = parseLine(raw);
    if (node === undefined) continue;
    // A link's address is its child, written on the next line.
    if (
      node.role === '/url' &&
      previous?.node.role === 'link' &&
      previous.keptIndex !== undefined &&
      node.indent > previous.node.indent &&
      node.value !== undefined
    ) {
      const entry = kept[previous.keptIndex];
      if (entry !== undefined) {
        const ref = refOf(previous.node);
        entry.line = render(
          previous.node,
          node.value,
          ref !== undefined && snapshot.maskedRefs.has(ref),
        );
      }
      previous = undefined;
      continue;
    }
    if (!OUTLINE_ROLES.has(node.role)) {
      previous = { node };
      continue;
    }
    const ref = refOf(node);
    kept.push({
      role: node.role,
      line: render(node, undefined, ref !== undefined && snapshot.maskedRefs.has(ref)),
    });
    previous = { node, keptIndex: kept.length - 1 };
  }

  const cut = cutToBound('Outline', kept, maxChars, () => OUTLINE_REMEDY);
  return {
    text: cut.text,
    elements: cut.lines,
    ...(cut.census !== undefined ? { census: cut.census } : {}),
  };
}

/** The element a reference names in a snapshot, or nothing when the snapshot has no such reference. */
export function describeRef(
  snapshotText: string,
  ref: string,
): { role: string; name?: string } | undefined {
  for (const raw of snapshotText.split('\n')) {
    const node = parseLine(raw);
    if (node === undefined || refOf(node) !== ref) continue;
    return {
      role: node.role,
      ...(node.name !== undefined && node.name !== '' ? { name: node.name } : {}),
    };
  }
  return undefined;
}

export interface BoundedSnapshot {
  readonly text: string;
  readonly lines: number;
  readonly census?: Readonly<Record<string, number>>;
  /** When cut: the element enclosing the first line left out, to scope the next snapshot to. */
  readonly continueRef?: string;
}

interface SnapshotLine extends Line {
  readonly indent: number;
  readonly ref?: string;
}

/**
 * The nearest element with a reference that encloses the first line left out
 * and is not the top of the snapshot — or, failing one, the first reference
 * at or after that line.
 */
function continueRefAt(lines: readonly SnapshotLine[], firstLeftOut: number): string | undefined {
  const first = lines[firstLeftOut];
  if (first === undefined) return undefined;
  let indent = first.indent;
  for (let i = firstLeftOut - 1; i > 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || line.indent >= indent) continue;
    if (line.ref !== undefined) return line.ref;
    indent = line.indent;
  }
  return lines.slice(firstLeftOut).find((line) => line.ref !== undefined)?.ref;
}

/**
 * The whole snapshot, or the subtree under one reference, with every masked
 * field's value removed and the same bound as the outline. Nothing when the
 * reference is not in the snapshot.
 */
export function boundSnapshot(
  snapshot: PageSnapshot,
  ref?: string,
  maxChars: number = BROWSER_SNAPSHOT_DEFAULT_CHARS,
): BoundedSnapshot | undefined {
  const raws = snapshot.text.split('\n').filter((raw) => raw.trim() !== '');
  let selected = raws;
  if (ref !== undefined) {
    const at = raws.findIndex((raw) => {
      const node = parseLine(raw);
      return node !== undefined && refOf(node) === ref;
    });
    if (at < 0) return undefined;
    const rootIndent = parseLine(raws[at] ?? '')?.indent ?? 0;
    const end = raws.findIndex((raw, index) => {
      if (index <= at) return false;
      const indent = /^(\s*)/.exec(raw)?.[1]?.length ?? 0;
      return indent <= rootIndent;
    });
    selected = raws.slice(at, end < 0 ? undefined : end).map((raw) => raw.slice(rootIndent));
  }
  const lines: SnapshotLine[] = selected.map((raw) => {
    const node = parseLine(raw);
    if (node === undefined) {
      return { role: 'text', line: raw, indent: /^(\s*)/.exec(raw)?.[1]?.length ?? 0 };
    }
    const nodeRef = refOf(node);
    const at = {
      role: node.role,
      indent: node.indent,
      ...(nodeRef !== undefined ? { ref: nodeRef } : {}),
    };
    if (nodeRef === undefined || !snapshot.maskedRefs.has(nodeRef) || node.value === undefined) {
      return { ...at, line: raw };
    }
    return { ...at, line: `${' '.repeat(node.indent)}${render(node, undefined, true)}` };
  });
  let continueRef: string | undefined;
  const cut = cutToBound('Snapshot', lines, maxChars, (kept) => {
    continueRef = continueRefAt(lines, kept);
    return continueRef !== undefined
      ? `To read on, snapshot with \`ref: ${continueRef}\`, or raise \`maxChars\`.`
      : 'Scope the snapshot with a `ref` above, or raise `maxChars`.';
  });
  return {
    text: cut.text,
    lines: cut.lines,
    ...(cut.census !== undefined ? { census: cut.census } : {}),
    ...(cut.census !== undefined && continueRef !== undefined ? { continueRef } : {}),
  };
}
