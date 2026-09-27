/**
 * Smallest string a JSON Schema `pattern` admits.
 *
 * The conformance gate replays every template action against a synthesized
 * input. A synthesizer that ignores `pattern` produces a sample the schema
 * rejects, the replay is skipped, and a patterned id silently converts a
 * failing template into a passing one — so honouring `pattern` is what makes
 * dynamically-keyed templates verifiable at all.
 *
 * Only the regex subset a declared applet schema may carry is parsed;
 * lookaround, backreferences and word boundaries return undefined rather than
 * a guess. Whatever the parser emits is checked against the real RegExp
 * before it is handed back, so a parser gap can only under-approximate.
 */

/** An expanded character class is bounded — a generated pattern is untrusted. */
const MAX_CLASS_OPTIONS = 256;

/** Cap on how far a quantifier is expanded to reach a `minLength`. */
const MAX_REPEAT_EXPANSION = 512;

/** Characters a negated class draws from, in preference order. */
const NEGATED_CLASS_POOL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.';

const DIGITS = '0123456789';
const WORD_CHARS = `${DIGITS}abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_`;
const WHITESPACE = ' ';

type PatternNode =
  | { kind: 'chars'; options: string }
  | { kind: 'sequence'; parts: PatternNode[] }
  | { kind: 'choice'; branches: PatternNode[] }
  | { kind: 'repeat'; part: PatternNode; min: number; max: number };

class UnsupportedPatternError extends Error {}

interface Cursor {
  readonly source: string;
  index: number;
}

/**
 * The smallest string matching `pattern` and at least `minLength` long, or
 * undefined when the pattern falls outside the parsed subset or admits
 * nothing of that length.
 */
export function sampleStringForPattern(pattern: string, minLength = 0): string | undefined {
  let node: PatternNode;
  try {
    const cursor: Cursor = { source: pattern, index: 0 };
    node = parseChoice(cursor);
    if (cursor.index < pattern.length) return undefined;
  } catch (err) {
    if (err instanceof UnsupportedPatternError) return undefined;
    throw err;
  }
  const emitted = emit(node, { text: '', minLength });
  if (emitted.length < minLength) return undefined;
  let matches: boolean;
  try {
    matches = new RegExp(pattern).test(emitted);
  } catch {
    return undefined;
  }
  return matches ? emitted : undefined;
}

// ============================================================================
// Parsing
// ============================================================================

function parseChoice(cursor: Cursor): PatternNode {
  const branches = [parseSequence(cursor)];
  while (cursor.source[cursor.index] === '|') {
    cursor.index += 1;
    branches.push(parseSequence(cursor));
  }
  return branches.length === 1 ? branches[0]! : { kind: 'choice', branches };
}

function parseSequence(cursor: Cursor): PatternNode {
  const parts: PatternNode[] = [];
  while (cursor.index < cursor.source.length) {
    const char = cursor.source[cursor.index]!;
    if (char === '|' || char === ')') break;
    parts.push(parseQuantified(cursor));
  }
  return { kind: 'sequence', parts };
}

function parseQuantified(cursor: Cursor): PatternNode {
  const atom = parseAtom(cursor);
  const char = cursor.source[cursor.index];
  if (char === '?') {
    cursor.index += 1;
    consumeLazyMarker(cursor);
    return { kind: 'repeat', part: atom, min: 0, max: 1 };
  }
  if (char === '*') {
    cursor.index += 1;
    consumeLazyMarker(cursor);
    return { kind: 'repeat', part: atom, min: 0, max: Infinity };
  }
  if (char === '+') {
    cursor.index += 1;
    consumeLazyMarker(cursor);
    return { kind: 'repeat', part: atom, min: 1, max: Infinity };
  }
  if (char === '{') {
    const bounds = parseBraceBounds(cursor);
    if (bounds !== undefined) {
      consumeLazyMarker(cursor);
      return { kind: 'repeat', part: atom, min: bounds.min, max: bounds.max };
    }
  }
  return atom;
}

function consumeLazyMarker(cursor: Cursor): void {
  if (cursor.source[cursor.index] === '?') cursor.index += 1;
}

/** `{n}` / `{n,}` / `{n,m}`; anything else leaves `{` as a literal. */
function parseBraceBounds(cursor: Cursor): { min: number; max: number } | undefined {
  const closing = cursor.source.indexOf('}', cursor.index);
  if (closing === -1) return undefined;
  const body = cursor.source.slice(cursor.index + 1, closing);
  const match = /^(\d+)(,(\d*))?$/.exec(body);
  if (match === null) return undefined;
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
  if (max < min) throw new UnsupportedPatternError();
  cursor.index = closing + 1;
  return { min, max };
}

function parseAtom(cursor: Cursor): PatternNode {
  const char = cursor.source[cursor.index];
  if (char === undefined) throw new UnsupportedPatternError();
  if (char === '^' || char === '$') {
    cursor.index += 1;
    return { kind: 'sequence', parts: [] };
  }
  if (char === '(') {
    cursor.index += 1;
    if (cursor.source.startsWith('?:', cursor.index)) cursor.index += 2;
    else if (cursor.source[cursor.index] === '?') throw new UnsupportedPatternError();
    const inner = parseChoice(cursor);
    if (cursor.source[cursor.index] !== ')') throw new UnsupportedPatternError();
    cursor.index += 1;
    return inner;
  }
  if (char === '[') return parseCharacterClass(cursor);
  if (char === '.') {
    cursor.index += 1;
    return { kind: 'chars', options: 'a' };
  }
  if (char === '\\') return parseEscape(cursor);
  if (char === ')' || char === '|' || char === '*' || char === '+' || char === '?') {
    throw new UnsupportedPatternError();
  }
  cursor.index += 1;
  return { kind: 'chars', options: char };
}

function parseEscape(cursor: Cursor): PatternNode {
  const char = cursor.source[cursor.index + 1];
  if (char === undefined) throw new UnsupportedPatternError();
  cursor.index += 2;
  switch (char) {
    case 'd':
      return { kind: 'chars', options: DIGITS };
    case 'w':
      return { kind: 'chars', options: WORD_CHARS };
    case 's':
      return { kind: 'chars', options: WHITESPACE };
    case 'D':
      return { kind: 'chars', options: complement(DIGITS) };
    case 'W':
      return { kind: 'chars', options: complement(WORD_CHARS) };
    case 'S':
      return { kind: 'chars', options: complement(WHITESPACE) };
    case 't':
      return { kind: 'chars', options: '\t' };
    case 'n':
      return { kind: 'chars', options: '\n' };
    case 'r':
      return { kind: 'chars', options: '\r' };
    default:
      // A literal escape of a metacharacter is the only remaining safe form;
      // \b, \1 and \uXXXX carry meaning this parser does not model.
      if (/[-\\^$.|?*+()[\]{}/]/.test(char)) return { kind: 'chars', options: char };
      throw new UnsupportedPatternError();
  }
}

function parseCharacterClass(cursor: Cursor): PatternNode {
  let index = cursor.index + 1;
  const negated = cursor.source[index] === '^';
  if (negated) index += 1;
  let options = '';
  let closed = false;
  while (index < cursor.source.length) {
    const char = cursor.source[index]!;
    if (char === ']' && options.length > 0) {
      closed = true;
      index += 1;
      break;
    }
    if (char === '\\') {
      const escaped = cursor.source[index + 1];
      if (escaped === undefined) throw new UnsupportedPatternError();
      const sub: Cursor = { source: cursor.source, index };
      const node = parseEscape(sub);
      if (node.kind !== 'chars') throw new UnsupportedPatternError();
      options += node.options;
      index = sub.index;
      continue;
    }
    const next = cursor.source[index + 1];
    const afterNext = cursor.source[index + 2];
    if (next === '-' && afterNext !== undefined && afterNext !== ']') {
      const from = char.codePointAt(0)!;
      const to = afterNext.codePointAt(0)!;
      if (to < from || to - from > MAX_CLASS_OPTIONS) throw new UnsupportedPatternError();
      for (let code = from; code <= to; code++) options += String.fromCodePoint(code);
      index += 3;
      continue;
    }
    options += char;
    index += 1;
  }
  if (!closed || options.length === 0) throw new UnsupportedPatternError();
  cursor.index = index;
  const resolved = negated ? complement(options) : options;
  if (resolved.length === 0) throw new UnsupportedPatternError();
  return { kind: 'chars', options: resolved.slice(0, MAX_CLASS_OPTIONS) };
}

function complement(excluded: string): string {
  return NEGATED_CLASS_POOL.split('')
    .filter((char) => !excluded.includes(char))
    .join('');
}

// ============================================================================
// Emission
// ============================================================================

interface EmitState {
  text: string;
  readonly minLength: number;
}

function emit(node: PatternNode, state: EmitState): string {
  appendNode(node, state);
  return state.text;
}

function appendNode(node: PatternNode, state: EmitState): void {
  switch (node.kind) {
    case 'chars':
      state.text += node.options[0] ?? '';
      return;
    case 'sequence':
      for (const part of node.parts) appendNode(part, state);
      return;
    case 'choice': {
      // The first branch that emits something at least as short as every other
      // keeps the sample minimal without backtracking over the whole grammar.
      let shortest: PatternNode | undefined;
      let shortestLength = Infinity;
      for (const branch of node.branches) {
        const probe: EmitState = { text: '', minLength: 0 };
        appendNode(branch, probe);
        if (probe.text.length < shortestLength) {
          shortestLength = probe.text.length;
          shortest = branch;
        }
      }
      if (shortest !== undefined) appendNode(shortest, state);
      return;
    }
    case 'repeat': {
      for (let i = 0; i < node.min && i < MAX_REPEAT_EXPANSION; i++) {
        appendNode(node.part, state);
      }
      let extra = node.min;
      while (
        state.text.length < state.minLength &&
        extra < node.max &&
        extra < MAX_REPEAT_EXPANSION
      ) {
        const before = state.text.length;
        appendNode(node.part, state);
        extra += 1;
        if (state.text.length === before) break;
      }
      return;
    }
  }
}
