/**
 * Restricted-YAML-subset frontmatter parser for memory v2 documents.
 *
 * Hand-written strict subset — intentionally NOT a full YAML implementation.
 * Parsed properties flow into agent-visible metadata, so the parser is a
 * security boundary: prototype-pollution keys are rejected, and anything the
 * subset does not explicitly accept is discarded with a diagnostic rather than
 * interpreted.
 */

import {
  FRONTMATTER_SCAN_BYTES,
  MAX_PROPERTIES_BYTES,
  MAX_PROPERTY_ARRAY_ITEMS,
  MAX_PROPERTY_KEYS,
  MAX_PROPERTY_VALUE_CHARS,
} from './linkConstants.js';

export type PropertyValue = string | number | boolean | Array<string | number>;

export interface FrontmatterDiagnostic {
  key?: string;
  reason: 'invalid_yaml' | 'unsupported_value' | 'clamped';
  message: string;
}

export interface FrontmatterResult {
  properties: Record<string, PropertyValue>;
  diagnostics: FrontmatterDiagnostic[];
  hadFrontmatter: boolean;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

interface RawPair {
  key: string;
  /** Inline text after the colon on the key line (already comment-stripped, trimmed). */
  inline: string;
  /** Block-list items gathered from following `- ` lines, when inline is empty. */
  blockItems: string[];
  /** A `key:` with empty inline and at least one indented non-list line under it. */
  looksNested: boolean;
  /** The inline value is an unsupported construct (block scalar / flow map). */
  unsupportedInline: boolean;
}

export function parseFrontmatter(content: string): FrontmatterResult {
  const normalized = stripBom(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return { properties: {}, diagnostics: [], hadFrontmatter: false };
  }

  const body = extractBlock(normalized);
  if (body === null) {
    return { properties: {}, diagnostics: [], hadFrontmatter: false };
  }

  const diagnostics: FrontmatterDiagnostic[] = [];
  const lines = body.split('\n');

  let pairs: RawPair[] | null;
  try {
    pairs = collectPairs(lines);
  } catch {
    pairs = null;
  }

  if (pairs === null) {
    return {
      properties: {},
      diagnostics: [
        { reason: 'invalid_yaml', message: 'Frontmatter is not a supported YAML subset.' },
      ],
      hadFrontmatter: true,
    };
  }

  const properties: Record<string, PropertyValue> = Object.create(null) as Record<
    string,
    PropertyValue
  >;
  const seen = new Set<string>();
  let keyCount = 0;

  for (const pair of pairs) {
    const { key } = pair;

    if (FORBIDDEN_KEYS.has(key)) {
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Key "${key}" is not allowed.`,
      });
      continue;
    }

    if (seen.has(key)) {
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Duplicate key "${key}" ignored; first value kept.`,
      });
      continue;
    }

    if (pair.looksNested) {
      seen.add(key);
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Nested maps are not supported for key "${key}".`,
      });
      continue;
    }

    if (pair.unsupportedInline) {
      seen.add(key);
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Unsupported value for key "${key}".`,
      });
      continue;
    }

    let value: PropertyValue | undefined;
    try {
      value = resolveValue(pair, diagnostics);
    } catch {
      value = undefined;
    }

    if (value === undefined) {
      // resolveValue pushed an unsupported_value diagnostic already, or the value
      // is genuinely empty. Mark the key as seen so a later duplicate stays a dup.
      seen.add(key);
      continue;
    }

    seen.add(key);

    if (keyCount >= MAX_PROPERTY_KEYS) {
      diagnostics.push({
        key,
        reason: 'clamped',
        message: `Exceeded maximum of ${String(MAX_PROPERTY_KEYS)} keys; "${key}" dropped.`,
      });
      continue;
    }

    properties[key] = value;
    keyCount += 1;
  }

  enforceByteBudget(properties, pairs, diagnostics);

  return { properties: toPlainObject(properties), diagnostics, hadFrontmatter: true };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Extract the frontmatter block body between the opening `---` and the next
 * `---` closing line. Returns null when no closing marker is found within
 * FRONTMATTER_SCAN_BYTES.
 */
function extractBlock(normalized: string): string | null {
  const afterOpen = normalized.slice(4); // past "---\n"

  // The closing marker is a line that is exactly `---` or `...` (trailing
  // horizontal whitespace allowed). Anchor to line starts.
  const closeRe = /(?:^|\n)(?:---|\.\.\.)[ \t]*(?:\n|$)/;
  const match = closeRe.exec(afterOpen);
  if (!match) return null;

  // Everything before the (optional) newline that precedes the closing marker
  // is the block body; match.index points at that newline, or at 0 when the
  // marker is on the very first body line.
  const body = afterOpen.slice(0, match.index);

  // The whole block (opening marker + body + closing marker) must close within
  // the byte budget, else the frontmatter is treated as absent.
  const blockEndByte = Buffer.byteLength(
    normalized.slice(0, 4 + match.index + match[0].length),
    'utf8',
  );
  if (blockEndByte > FRONTMATTER_SCAN_BYTES) return null;

  return body;
}

/**
 * Group frontmatter lines into key/value pairs. Throws when the input contains
 * a construct outside the accepted subset that cannot be attributed to a single
 * key (e.g. leading list at document root, or an unparseable structural line).
 */
function collectPairs(lines: string[]): RawPair[] {
  const pairs: RawPair[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;

    const indent = leadingSpaces(rawLine);
    const stripped = stripComment(rawLine).trimEnd();
    const trimmed = stripped.trim();

    if (trimmed.length === 0) continue;

    // A list item or indented line at the top level with no owning key is not a
    // valid top-level map.
    if (indent > 0) {
      throw new Error('unexpected indentation at document root');
    }
    if (trimmed.startsWith('- ') || trimmed === '-') {
      throw new Error('unexpected list at document root');
    }

    const colonIdx = findKeyColon(trimmed);
    if (colonIdx < 0) {
      throw new Error('line is not a key: value pair');
    }

    const rawKey = trimmed.slice(0, colonIdx).trim();
    if (rawKey.length === 0) {
      throw new Error('empty key');
    }
    const key = unquoteKey(rawKey);
    if (key === null) {
      throw new Error('unsupported key');
    }

    const inline = trimmed.slice(colonIdx + 1).trim();

    const blockItems: string[] = [];
    let looksNested = false;
    let unsupportedInline = false;

    if (isBlockScalarIndicator(inline)) {
      // A `|`/`>` block scalar owns the following more-indented lines; consume
      // them so they do not trip the root-indentation guard, then reject the key.
      unsupportedInline = true;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j];
        if (next === undefined) break;
        const nextTrimmed = next.trim();
        if (nextTrimmed.length === 0) continue;
        if (leadingSpaces(next) === 0) break;
      }
      i = j - 1;
      pairs.push({ key, inline, blockItems, looksNested, unsupportedInline });
      continue;
    }

    if (inline.startsWith('{')) {
      // Flow map — outside the subset.
      pairs.push({ key, inline, blockItems, looksNested: false, unsupportedInline: true });
      continue;
    }

    if (inline.length === 0) {
      // Gather following more-indented lines: block list (`- x`) or nested map.
      let j = i + 1;
      let sawListItem = false;
      let sawNonList = false;
      for (; j < lines.length; j++) {
        const next = lines[j];
        if (next === undefined) break;
        const nextIndent = leadingSpaces(next);
        const nextStripped = stripComment(next).trimEnd();
        const nextTrimmed = nextStripped.trim();
        if (nextTrimmed.length === 0) {
          // blank line inside a block: keep scanning only if more indented content follows
          continue;
        }
        if (nextIndent === 0) break; // back to top level

        if (nextTrimmed.startsWith('- ') || nextTrimmed === '-') {
          sawListItem = true;
          const itemText = nextTrimmed === '-' ? '' : nextTrimmed.slice(2).trim();
          blockItems.push(itemText);
        } else {
          sawNonList = true;
        }
      }
      i = j - 1;

      if (sawNonList) {
        looksNested = true;
      } else if (!sawListItem) {
        // `key:` with nothing under it → treat as empty value (dropped later).
        looksNested = false;
      }
    }

    pairs.push({ key, inline, blockItems, looksNested, unsupportedInline });
  }

  return pairs;
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 1;
    else break;
  }
  return n;
}

/**
 * Strip a `#` comment that begins outside of quotes. A `#` directly after
 * non-space with no preceding space is treated as part of a token (URLs,
 * fragments) and left in place, matching YAML's "space before #" rule.
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      const prev = i > 0 ? line[i - 1] : undefined;
      if (prev === undefined || prev === ' ' || prev === '\t') {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/** Find the colon that separates key from value, respecting quotes. */
function findKeyColon(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = i + 1 < line.length ? line[i + 1] : undefined;
      // A colon must be followed by a space or end-of-line to count as the
      // key/value separator (so `http://x` inside a value is not split).
      if (next === undefined || next === ' ' || next === '\t') {
        return i;
      }
    }
  }
  return -1;
}

function unquoteKey(rawKey: string): string | null {
  const scalar = parseScalar(rawKey);
  if (scalar === UNSUPPORTED) return null;
  if (typeof scalar === 'string') return scalar;
  return String(scalar);
}

const UNSUPPORTED = Symbol('unsupported');
type ScalarResult = string | number | boolean | typeof UNSUPPORTED;

function resolveValue(
  pair: RawPair,
  diagnostics: FrontmatterDiagnostic[],
): PropertyValue | undefined {
  const { key, inline, blockItems } = pair;

  if (inline.length === 0) {
    if (blockItems.length === 0) {
      // `key:` with no value at all — drop silently (empty).
      return undefined;
    }
    return resolveList(key, blockItems, diagnostics);
  }

  if (inline.startsWith('[')) {
    const flow = parseFlowList(inline);
    if (flow === null) {
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Unsupported list value for key "${key}".`,
      });
      return undefined;
    }
    return resolveList(key, flow, diagnostics);
  }

  if (isUnsupportedScalarLead(inline)) {
    diagnostics.push({
      key,
      reason: 'unsupported_value',
      message: `Unsupported value for key "${key}".`,
    });
    return undefined;
  }

  const scalar = parseScalar(inline);
  if (scalar === UNSUPPORTED) {
    diagnostics.push({
      key,
      reason: 'unsupported_value',
      message: `Unsupported value for key "${key}".`,
    });
    return undefined;
  }

  return clampScalar(key, scalar, diagnostics);
}

function resolveList(
  key: string,
  items: string[],
  diagnostics: FrontmatterDiagnostic[],
): PropertyValue | undefined {
  const out: Array<string | number> = [];
  let arrayClamped = false;

  for (const item of items) {
    if (out.length >= MAX_PROPERTY_ARRAY_ITEMS) {
      arrayClamped = true;
      break;
    }
    if (isUnsupportedScalarLead(item) || item.startsWith('{') || findKeyColon(item) >= 0) {
      // Leading indicator, flow map, or an unquoted `k: v` (a mapping item).
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Unsupported list item for key "${key}".`,
      });
      return undefined;
    }
    const scalar = parseScalar(item);
    if (scalar === UNSUPPORTED) {
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Unsupported list item for key "${key}".`,
      });
      return undefined;
    }
    if (typeof scalar === 'boolean') {
      diagnostics.push({
        key,
        reason: 'unsupported_value',
        message: `Boolean list items are not supported for key "${key}".`,
      });
      return undefined;
    }
    out.push(clampScalar(key, scalar, diagnostics));
  }

  if (arrayClamped) {
    diagnostics.push({
      key,
      reason: 'clamped',
      message: `List for key "${key}" truncated to ${String(MAX_PROPERTY_ARRAY_ITEMS)} items.`,
    });
  }

  return out;
}

function clampScalar<T extends string | number | boolean>(
  key: string,
  scalar: T,
  diagnostics: FrontmatterDiagnostic[],
): T | string {
  if (typeof scalar === 'string' && scalar.length > MAX_PROPERTY_VALUE_CHARS) {
    diagnostics.push({
      key,
      reason: 'clamped',
      message: `Value for key "${key}" truncated to ${String(MAX_PROPERTY_VALUE_CHARS)} characters.`,
    });
    return scalar.slice(0, MAX_PROPERTY_VALUE_CHARS);
  }
  return scalar;
}

/**
 * Detect leading tokens that mark a value as outside the accepted subset:
 * anchors (&), aliases (*), custom tags (!), merge keys (<<), and block scalar
 * indicators (| or >). These must be rejected, never coerced to strings.
 */
function isUnsupportedScalarLead(text: string): boolean {
  if (text.length === 0) return false;
  const first = text[0];
  if (first === '&' || first === '*' || first === '!') return true;
  if (isBlockScalarIndicator(text)) return true;
  if (text.startsWith('<<')) return true;
  return false;
}

/**
 * A bare `|` or `>` (optionally with a chomping/indent indicator) after the
 * colon starts a multi-line block scalar. A quoted or plain string that merely
 * contains one of these characters is not a block scalar.
 */
function isBlockScalarIndicator(text: string): boolean {
  const first = text[0];
  if (first !== '|' && first !== '>') return false;
  const rest = text.slice(1).trim();
  return rest.length === 0 || /^[0-9+-]*$/.test(rest);
}

function parseScalar(text: string): ScalarResult {
  const t = text.trim();
  if (t.length === 0) return '';

  if (t.startsWith('"')) {
    return parseDoubleQuoted(t);
  }
  if (t.startsWith("'")) {
    return parseSingleQuoted(t);
  }

  // Reject constructs that only make sense as YAML structure, not plain scalars.
  if (t === '~' || t === 'null' || t === 'Null' || t === 'NULL') {
    return UNSUPPORTED;
  }

  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;

  const num = parseNumber(t);
  if (num !== null) return num;

  return t;
}

function parseDoubleQuoted(t: string): ScalarResult {
  if (!t.endsWith('"') || t.length < 2) return UNSUPPORTED;
  const inner = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === undefined) break;
    if (ch === '\\') {
      const next = inner[i + 1];
      if (next === undefined) return UNSUPPORTED;
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        default:
          out += next;
      }
      i += 1;
    } else if (ch === '"') {
      // Unescaped closing quote before the end → malformed.
      return UNSUPPORTED;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseSingleQuoted(t: string): ScalarResult {
  if (!t.endsWith("'") || t.length < 2) return UNSUPPORTED;
  const inner = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === undefined) break;
    if (ch === "'") {
      if (inner[i + 1] === "'") {
        out += "'";
        i += 1;
      } else {
        // Bare single quote before the end → malformed.
        return UNSUPPORTED;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/** ISO-ish dates and non-numeric-looking strings stay strings. */
function parseNumber(t: string): number | null {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

/** Parse a single-line flow list `[a, b, c]`. Returns null if malformed. */
function parseFlowList(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const inner = t.slice(1, -1);
  if (inner.trim().length === 0) return [];

  const items: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (const ch of inner) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (!inSingle && !inDouble && (ch === '[' || ch === '{' || ch === ']' || ch === '}')) {
      // Nested collections inside a flow list are outside the subset.
      return null;
    } else if (ch === ',' && !inSingle && !inDouble) {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (inSingle || inDouble) return null;
  items.push(current.trim());
  return items.map((s) => s.trim());
}

/**
 * Enforce the total serialized-bytes budget by dropping keys (lowest priority
 * first, where priority = original document order — later keys go first) until
 * the JSON representation fits under MAX_PROPERTIES_BYTES.
 */
function enforceByteBudget(
  properties: Record<string, PropertyValue>,
  pairs: RawPair[],
  diagnostics: FrontmatterDiagnostic[],
): void {
  if (jsonBytes(properties) <= MAX_PROPERTIES_BYTES) return;

  const order = pairs.map((p) => p.key);
  // Drop from the end of document order first.
  for (let i = order.length - 1; i >= 0; i--) {
    const key = order[i];
    if (key === undefined) continue;
    if (!(key in properties)) continue;
    delete properties[key];
    diagnostics.push({
      key,
      reason: 'clamped',
      message: `Properties exceeded ${String(MAX_PROPERTIES_BYTES)} bytes; "${key}" dropped.`,
    });
    if (jsonBytes(properties) <= MAX_PROPERTIES_BYTES) return;
  }
}

function jsonBytes(obj: Record<string, PropertyValue>): number {
  return Buffer.byteLength(JSON.stringify(toPlainObject(obj)), 'utf8');
}

/** Convert a null-prototype accumulator into a plain object for return/serialize. */
function toPlainObject(obj: Record<string, PropertyValue>): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
