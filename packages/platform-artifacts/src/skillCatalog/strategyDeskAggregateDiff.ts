/**
 * The refusal a lens aggregate gets where it differs from the veto rule: the
 * JSON paths that differ, each with the value the rule gives there. The
 * aggregating Runner reads nothing but this message and its own inputs, and a
 * log line or a tool result may cut a long message. So the refusal is bounded,
 * and it names each path on its own short line. The whole expected value is
 * quoted only where it is small.
 */
import { canonicalJson } from './dailyTradingCycleLenses.js';

export type JsonPath = Array<string | number>;

export type ValueDifference =
  | { kind: 'differs'; path: JsonPath; expected: unknown; actual: unknown }
  | { kind: 'missing'; path: JsonPath; expected: unknown }
  | { kind: 'extra'; path: JsonPath }
  | { kind: 'length'; path: JsonPath; expected: number; actual: number };

/** The total length the refusal messages of one aggregate stay within. */
export const AGGREGATE_REFUSAL_BUDGET = 2000;
/** The longest value a line quotes whole. A longer one is named by its shape. */
const QUOTED_VALUE_MAX = 160;
/** The longest expected field value a refusal quotes whole after its lines. */
const WHOLE_VALUE_MAX = 600;
/** Room kept for the line that counts the paths left out. */
const OMITTED_LINE_RESERVE = 100;

/**
 * The paths whose value the aggregate copies from a Runner input. `*` stands
 * for any one segment. A key named like an input elsewhere, such as the
 * `round` of each lens round, holds no input, so a pattern names the whole path.
 */
const COPIED_FROM: ReadonlyArray<{ pattern: readonly string[]; source: string }> = [
  { pattern: ['approvedSet', 'tradingDay'], source: 'your `tradingDay` input' },
  {
    pattern: ['approvedSet', 'slots', '*', '*', 'reviewRunId'],
    source: 'your `reviewRunId` input',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every path where `actual` departs from `expected`, in the order `expected` holds its keys. */
export function valueDifferences(
  expected: unknown,
  actual: unknown,
  path: JsonPath = [],
): ValueDifference[] {
  if (actual === undefined && expected !== undefined) return missingDifferences(expected, path);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: ValueDifference[] =
      expected.length === actual.length
        ? []
        : [{ kind: 'length', path, expected: expected.length, actual: actual.length }];
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (i >= expected.length) out.push({ kind: 'extra', path: [...path, i] });
      else out.push(...valueDifferences(expected[i], actual[i], [...path, i]));
    }
    return out;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const out: ValueDifference[] = [];
    for (const key of Object.keys(expected)) {
      if (expected[key] === undefined) continue;
      out.push(...valueDifferences(expected[key], actual[key], [...path, key]));
    }
    for (const key of Object.keys(actual)) {
      if (actual[key] !== undefined && expected[key] === undefined) {
        out.push({ kind: 'extra', path: [...path, key] });
      }
    }
    return out;
  }
  return canonicalJson(expected) === canonicalJson(actual)
    ? []
    : [{ kind: 'differs', path, expected, actual }];
}

/**
 * A missing value too long to quote whole is listed by its leaves, so every
 * line carries a value the Runner can write as it stands.
 */
function missingDifferences(expected: unknown, path: JsonPath): ValueDifference[] {
  const container = Array.isArray(expected) || isRecord(expected);
  if (!container || JSON.stringify(expected).length <= QUOTED_VALUE_MAX) {
    return [{ kind: 'missing', path, expected }];
  }
  const entries: Array<[string | number, unknown]> = Array.isArray(expected)
    ? expected.map((item, i): [number, unknown] => [i, item])
    : Object.entries(expected);
  return entries
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => missingDifferences(value, [...path, key]));
}

/** A path as a JSON Pointer, as the contract's own refusals name one. */
export function jsonPointer(path: JsonPath): string {
  return path.map((seg) => `/${String(seg).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function shown(value: unknown): string {
  const json = value === undefined ? 'nothing' : JSON.stringify(value);
  if (json.length <= QUOTED_VALUE_MAX) return json;
  if (Array.isArray(value)) return `an array of ${String(value.length)} items`;
  if (isRecord(value)) return `an object with the keys ${Object.keys(value).join(', ')}`;
  return `${json.slice(0, QUOTED_VALUE_MAX)}…`;
}

function copiedFrom(path: JsonPath): string {
  const match = COPIED_FROM.find(
    ({ pattern }) =>
      pattern.length === path.length &&
      pattern.every((seg, i) => seg === '*' || seg === String(path[i])),
  );
  return match === undefined ? '' : ` (${match.source})`;
}

/** One line per difference: the path, then what to write there. */
export function differenceLine(difference: ValueDifference): string {
  const at = jsonPointer(difference.path);
  switch (difference.kind) {
    case 'differs':
      return `${at}: write ${shown(difference.expected)}${copiedFrom(difference.path)}, not ${shown(difference.actual)}`;
    case 'missing':
      return `${at} is missing: write ${shown(difference.expected)}${copiedFrom(difference.path)}`;
    case 'extra':
      return `${at} is not in the rule's aggregate: remove it`;
    case 'length':
      return `${at} holds ${String(difference.actual)} items, and the rule gives ${String(difference.expected)}`;
  }
}

export interface FieldRefusal {
  field: string;
  message: string;
}

/**
 * The refusal of each top-level field that differs, all of them together
 * within {@link AGGREGATE_REFUSAL_BUDGET}. Lines are dealt to the fields in
 * turn, so every differing field names its first paths. A field whose lines
 * do not all fit says how many it left out, and the next refusal names those.
 */
export function fieldRefusals(
  fields: ReadonlyArray<{ field: string; expected: unknown; actual: unknown }>,
): FieldRefusal[] {
  const differing = fields
    .map(({ field, expected, actual }) => {
      const lines = valueDifferences(expected, actual, [field]).map(
        (difference) => `\n- ${differenceLine(difference)}`,
      );
      const count = lines.length;
      const head = `does not follow the lens veto rule over your lens inputs. ${String(count)} ${count === 1 ? 'path differs' : 'paths differ'}. Write each value shown, then submit again:`;
      return { field, expected, lines, head, shown: 0 };
    })
    .filter((f) => f.lines.length > 0);
  let used = differing.reduce((sum, f) => sum + f.head.length + OMITTED_LINE_RESERVE, 0);
  for (let dealt = true; dealt;) {
    dealt = false;
    for (const f of differing) {
      const line = f.lines[f.shown];
      if (line === undefined || used + line.length > AGGREGATE_REFUSAL_BUDGET) continue;
      used += line.length;
      f.shown += 1;
      dealt = true;
    }
  }
  return differing.map(({ field, expected, lines, head, shown }) => {
    let message = head + lines.slice(0, shown).join('');
    const omitted = lines.length - shown;
    if (omitted > 0) {
      message += `\n- ${String(omitted)} more under ${jsonPointer([field])}. Fix the paths shown, and the next refusal names the rest.`;
    } else {
      // A field shown whole has its reserve to spare, which a small expected value may use.
      const whole = `\nThe rule gives ${jsonPointer([field])} as ${JSON.stringify(expected)}`;
      if (
        whole.length <=
        Math.min(WHOLE_VALUE_MAX, OMITTED_LINE_RESERVE + AGGREGATE_REFUSAL_BUDGET - used)
      ) {
        message += whole;
        used += Math.max(0, whole.length - OMITTED_LINE_RESERVE);
      }
    }
    return { field, message };
  });
}
