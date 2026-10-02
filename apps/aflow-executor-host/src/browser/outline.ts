/**
 * The page as an agent reads it by default: its headings and the elements it
 * can act on, in document order, each with its reference.
 *
 * A whole-page snapshot runs to tens of thousands of tokens on an ordinary
 * page; this keeps the part an action can name and leaves the text to be asked
 * for. Past the bound it stops and counts what it left out, by role, so the
 * agent knows what kind of thing it is not seeing.
 */
import { BROWSER_OUTLINE_MAX_CHARS } from '@aflow/schemas';

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

function censusLine(census: Record<string, number>, maxChars: number): string {
  const counted = Object.entries(census)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([role, count]) => `${role} ${String(count)}`)
    .join(', ');
  return `# Outline cut at ${String(maxChars)} characters. Not shown: ${counted}.`;
}

export function buildOutline(
  snapshot: PageSnapshot,
  maxChars: number = BROWSER_OUTLINE_MAX_CHARS,
): Outline {
  const kept: Array<{ role: string; line: string }> = [];
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

  const all = kept.map((entry) => entry.line).join('\n');
  if (all.length <= maxChars) return { text: all, elements: kept.length };

  const census: Record<string, number> = {};
  const lines = kept.map((entry) => entry.line);
  const roles = kept.map((entry) => entry.role);
  let length = all.length;
  const withhold = (): void => {
    const line = lines.pop();
    const role = roles.pop();
    if (line === undefined || role === undefined) return;
    census[role] = (census[role] ?? 0) + 1;
    length -= line.length + (lines.length > 0 ? 1 : 0);
  };
  while (lines.length > 0 && length > maxChars) withhold();
  // The census has to fit under the same bound, so lines give way to it.
  while (lines.length > 0 && length + 1 + censusLine(census, maxChars).length > maxChars) {
    withhold();
  }
  return {
    text: [...lines, censusLine(census, maxChars)].join('\n'),
    elements: lines.length,
    census,
  };
}
