import {
  inferTaskType,
  type SkillDiagnostic,
  type WorkflowRunInput,
  type WorkflowTask,
} from '@aflow/schemas';

/**
 * A run's date is a fact the exchange clock and calendar give (Plan 346). A
 * run that asks a model for one, through its own output or through the
 * prompt of whoever starts it, can be handed the wrong day: a scheduled
 * Helmsman reasoned its way to a Saturday. Whether the market is open, or
 * whether a date is a trading day, is a clock fact in the same way. These
 * checks flag a date or a market state a model or a caller supplies where a
 * deterministic source could. They are advisory, because a skill may take a
 * value it truly needs from outside.
 */

const DATE_PATTERNS = new Set(['^\\d{4}-\\d{2}-\\d{2}$', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$']);

type Schema = Record<string, unknown>;

const asSchema = (v: unknown): Schema | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Schema) : null;

/** A string schema whose every value is a calendar date or an instant. */
function isDateSchema(s: Schema): boolean {
  if (s['type'] !== 'string') return false;
  if (s['format'] === 'date' || s['format'] === 'date-time') return true;
  const pattern = s['pattern'];
  return typeof pattern === 'string' && DATE_PATTERNS.has(pattern);
}

const PLACE_WORDS = new Set(['market', 'exchange', 'session']);
const STATE_WORDS = new Set(['open', 'opened', 'closed']);

/** The lower-case words of a camelCase, snake_case or kebab-case name. */
const nameWords = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());

/**
 * A name that marks a market state: a place and a state (`marketIsOpen`,
 * `exchange_closed`, `isSessionOpen`), a trading day (`isTradingDay`), or a
 * day with no session (`isHoliday`, `isWeekend`).
 */
function namesMarketState(name: string): boolean {
  const words = nameWords(name);
  if (words.some((w) => PLACE_WORDS.has(w)) && words.some((w) => STATE_WORDS.has(w))) return true;
  if (words.some((w, i) => w === 'trading' && words[i + 1] === 'day')) return true;
  return words.includes('holiday') || words.includes('weekend');
}

/**
 * A description that says the value is a market state. It must open on the
 * state itself, so a gate that only names a trading day among its reasons
 * (`False when this cycle is already recorded or the date is not a trading
 * day`) is no clock fact.
 */
const MARKET_STATE_DESCRIPTION =
  /^\s*(whether|true (when|if)|false (when|if))\s+(the|today(['’]s)?)\s+(market|exchange|session|date|day)\b[^.]*?\b(is|was|has)\s+(not\s+)?(open|opened|closed|a trading day|a session day|a holiday)\b/i;

/** A boolean schema whose name or description marks a market or clock state. */
function isMarketStateSchema(s: Schema, name: string | undefined): boolean {
  if (s['type'] !== 'boolean') return false;
  if (name !== undefined && namesMarketState(name)) return true;
  const description = s['description'];
  return typeof description === 'string' && MARKET_STATE_DESCRIPTION.test(description);
}

/**
 * A value the exchange clock or calendar gives: a calendar date or an
 * instant, or a boolean market state such as whether the market is open or
 * the day is a trading day. `name` is the field or run input the schema types.
 */
export function isClockValueSchema(schema: unknown, name?: string): boolean {
  const s = asSchema(schema);
  if (s === null) return false;
  return isDateSchema(s) || isMarketStateSchema(s, name);
}

const valueKind = (schema: unknown): string =>
  asSchema(schema)?.['type'] === 'boolean'
    ? 'a market state the exchange clock or calendar gives'
    : 'a date the exchange clock or calendar gives';

const FIX_HINT =
  'Read the value in the run: an operation task on the exchange clock, with a run deriver over the clock and calendar for the trading day, or a `clock` input binding for an instant. Then bind every reader to that task.';

function readsField(path: string | undefined, field: string): boolean {
  if (path === undefined) return false;
  return path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[`);
}

function pinnedFields(task: WorkflowTask): Set<string> {
  const pinned = new Set<string>();
  for (const binding of task.outputContract?.derivedFrom ?? []) {
    const field = /^\$\.([^.]+)\.(const|enum)$/.exec(binding.target)?.[1];
    if (field !== undefined) pinned.add(field);
  }
  return pinned;
}

export function deterministicInputDiagnostics(
  tasks: readonly WorkflowTask[],
  runInputs?: readonly WorkflowRunInput[],
): SkillDiagnostic[] {
  const out: SkillDiagnostic[] = [];
  const entry = tasks.find((t) => !t.dependsOn || t.dependsOn.length === 0);

  for (const input of runInputs ?? []) {
    if (!input.required || !isClockValueSchema(input.schema, input.id)) continue;
    out.push({
      code: 'clock_value_from_caller',
      dimension: 'graph',
      severity: 'advisory',
      ...(entry ? { taskId: entry.taskId } : {}),
      field: input.id,
      detail:
        `Run input '${input.id}' is ${valueKind(input.schema)}, and every caller must supply it. ` +
        'A schedule’s prompt or a model then works the value out, and can name the wrong day or state.',
      fixHint: FIX_HINT,
    });
  }

  for (const task of tasks) {
    let family: string;
    try {
      family = inferTaskType(task);
    } catch {
      continue;
    }
    if (family !== 'agent') continue;
    const properties = asSchema(asSchema(task.outputContract?.schema)?.['properties']);
    if (properties === null) continue;
    const pinned = pinnedFields(task);
    for (const [field, schema] of Object.entries(properties)) {
      if (!isClockValueSchema(schema, field) || pinned.has(field)) continue;
      const readers = tasks.filter((t) =>
        Object.values(t.inputBindings ?? {}).some(
          (b) => b.kind === 'task_output' && b.taskId === task.taskId && readsField(b.path, field),
        ),
      );
      const promoted = (task.promoteOutputs ?? []).some(
        (p) => 'path' in p && readsField(p.path, field),
      );
      if (readers.length === 0 && !promoted) continue;
      const read = [
        ...readers.map((r) => `'${r.taskId}'`),
        ...(promoted ? ['the run state'] : []),
      ].join(', ');
      out.push({
        code: 'clock_value_from_model',
        dimension: 'graph',
        severity: 'advisory',
        taskId: task.taskId,
        field,
        detail:
          `Agent task '${task.taskId}' writes '${field}', ${valueKind(schema)}, and ${read} read it. ` +
          'No derivedFrom binding pins it, so the model works the value out and can name the wrong day or state.',
        fixHint: `${FIX_HINT} Or pin '${field}' to that task's output with a derivedFrom value binding.`,
      });
    }
  }
  return out;
}
