import { createDefaultModelCatalog } from '@aflow/ai-client';
import {
  inferTaskType,
  RECOMMENDED_AGENT_MODELS,
  type SkillCampaignContract,
  type SkillDiagnostic,
  type WorkflowTask,
} from '@aflow/schemas';

/**
 * A static estimate of the output tokens an agent task's pinned output needs
 * (Plan 346). It reads the task's output contract, and each array whose count
 * a `count:` binding ties to an input, at that input's declared ceiling: a
 * campaign field's or an upstream contract's `maxItems`. So it holds the
 * output at the data volume a production run hands the task, before any run.
 *
 * The estimate counts the answer alone. Reasoning is paid from the same
 * output budget, so a task near its budget fails sooner than the estimate
 * says. The counts are typical JSON token costs, not a tokenizer's.
 */

const STRUCTURE_TOKENS = 2;
const NUMBER_TOKENS = 3;
const INTEGER_TOKENS = 2;
const SCALAR_TOKENS = 1;
const DATE_TOKENS = 6;
const DATE_TIME_TOKENS = 12;
/** JSON a model writes runs about three characters a token: digits and punctuation split short. */
const CHARS_PER_TOKEN = 3;

const DATE_PATTERNS = new Set(['^\\d{4}-\\d{2}-\\d{2}$', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$']);

export interface ScaledArray {
  /** The array, as a `derivedFrom` target names it: `$.memberCloses`. */
  path: string;
  count: number;
  /** What sets the count: `$campaign.universe`, or `<taskId>.<path>`. */
  source: string;
}

export interface OutputBudgetEstimate {
  taskId: string;
  tokens: number;
  /** The arrays the estimate counts at an input's declared ceiling. */
  scaled: ScaledArray[];
}

type Schema = Record<string, unknown>;

const asSchema = (v: unknown): Schema | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Schema) : null;

const textTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** JSON.stringify gives undefined for undefined, whatever its declared type. */
const jsonLength = (value: unknown) => (JSON.stringify(value) as string | undefined)?.length ?? 1;

/** The `maxItems` a JSONPath like `$.universe` or `$.bars.SPY` names in `schema`. */
function declaredCeiling(schema: Schema | null, jsonPath: string): number | null {
  const keys = jsonPath
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let at: Schema | null = schema;
  for (const key of keys) {
    const properties = asSchema(at?.['properties']);
    at = asSchema(properties?.[key]);
    if (at === null) return null;
  }
  const max = at?.['maxItems'];
  return typeof max === 'number' ? max : null;
}

/**
 * The count each count-bound array of `task` takes at its input's ceiling,
 * keyed by the array's target path. An input with no declared ceiling is left
 * out, so the array counts at its own `minItems`.
 */
function scaledArrays(
  task: WorkflowTask,
  tasks: readonly WorkflowTask[],
  contract: SkillCampaignContract | undefined,
): Map<string, ScaledArray> {
  const scaled = new Map<string, ScaledArray>();
  for (const binding of task.outputContract?.derivedFrom ?? []) {
    const count = /^count:(.+)$/.exec(binding.binding)?.[1];
    const target = /^(.*)\.(minItems|maxItems)$/.exec(binding.target)?.[1];
    if (count === undefined || target === undefined) continue;
    let ceiling: number | null;
    let source: string;
    if (binding.from === '$campaign') {
      const field = count.replace(/^\$\.?/, '').split('.')[0] ?? '';
      ceiling = declaredCeiling(
        { properties: { [field]: contract?.fields[field]?.schema } },
        count,
      );
      source = `$campaign.${field}`;
    } else {
      const producer = tasks.find((t) => t.taskId === binding.from);
      ceiling = declaredCeiling(asSchema(producer?.outputContract?.schema), count);
      source = `${binding.from}${count.replace(/^\$/, '')}`;
    }
    if (ceiling === null) continue;
    const prior = scaled.get(target);
    if (prior === undefined || prior.count < ceiling) {
      scaled.set(target, { path: target, count: ceiling, source });
    }
  }
  return scaled;
}

function stringTokens(schema: Schema): number {
  const pattern = schema['pattern'];
  if (schema['format'] === 'date' || (typeof pattern === 'string' && DATE_PATTERNS.has(pattern))) {
    return DATE_TOKENS;
  }
  if (schema['format'] === 'date-time') return DATE_TIME_TOKENS;
  const minLength = schema['minLength'];
  return STRUCTURE_TOKENS + (typeof minLength === 'number' ? textTokens(minLength) : 0);
}

function instanceTokens(
  schema: Schema | null,
  path: string,
  scaled: ReadonlyMap<string, ScaledArray>,
  depth: number,
): number {
  if (schema === null || depth > 32) return SCALAR_TOKENS;
  if ('const' in schema) return textTokens(jsonLength(schema['const']));
  const choices = schema['enum'];
  if (Array.isArray(choices) && choices.length > 0) {
    return Math.min(...choices.map((c) => textTokens(jsonLength(c))));
  }
  const types = Array.isArray(schema['type']) ? (schema['type'] as unknown[]) : [schema['type']];
  const costs = types.map((type) => {
    switch (type) {
      case 'object':
        return objectTokens(schema, path, scaled, depth);
      case 'array':
        return arrayTokens(schema, path, scaled, depth);
      case 'string':
        return stringTokens(schema);
      case 'number':
        return NUMBER_TOKENS;
      case 'integer':
        return INTEGER_TOKENS;
      case undefined:
        return asSchema(schema['properties'])
          ? objectTokens(schema, path, scaled, depth)
          : SCALAR_TOKENS;
      default:
        return SCALAR_TOKENS;
    }
  });
  return Math.min(...costs);
}

function objectTokens(
  schema: Schema,
  path: string,
  scaled: ReadonlyMap<string, ScaledArray>,
  depth: number,
): number {
  const properties = asSchema(schema['properties']) ?? {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  let tokens = STRUCTURE_TOKENS;
  for (const key of required) {
    tokens += textTokens(key.length) + STRUCTURE_TOKENS + 1;
    tokens += instanceTokens(asSchema(properties[key]), `${path}.${key}`, scaled, depth + 1);
  }
  return tokens;
}

function arrayTokens(
  schema: Schema,
  path: string,
  scaled: ReadonlyMap<string, ScaledArray>,
  depth: number,
): number {
  const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : 0;
  const count = Math.max(minItems, scaled.get(path)?.count ?? 0);
  if (count === 0) return STRUCTURE_TOKENS;
  const item = instanceTokens(asSchema(schema['items']), `${path}.items`, scaled, depth + 1);
  return STRUCTURE_TOKENS + count * (item + 1);
}

/**
 * The tokens an agent task's pinned output needs at its inputs' ceilings, or
 * null for a task that pins no output or asks no model.
 */
export function estimatePinnedOutputTokens(
  task: WorkflowTask,
  tasks: readonly WorkflowTask[],
  contract?: SkillCampaignContract,
): OutputBudgetEstimate | null {
  let family: string;
  try {
    family = inferTaskType(task);
  } catch {
    return null;
  }
  const schema = asSchema(task.outputContract?.schema);
  if (family !== 'agent' || schema === null) return null;
  const scaled = scaledArrays(task, tasks, contract);
  return {
    taskId: task.taskId,
    tokens: instanceTokens(schema, '$', scaled, 0),
    scaled: [...scaled.values()],
  };
}

export interface OutputBudget {
  model: string;
  maxOutputTokens: number;
}

/** The output budget of each model a space may assign an agent task, and of the task's own model. */
export function agentOutputBudgets(pinnedModel?: string): OutputBudget[] {
  const catalog = createDefaultModelCatalog();
  const refs =
    pinnedModel !== undefined ? [pinnedModel] : RECOMMENDED_AGENT_MODELS.map((m) => m.modelId);
  return refs.flatMap((model) => {
    const max = catalog.getModel(model)?.maxOutputTokens;
    return typeof max === 'number' && max > 0 ? [{ model, maxOutputTokens: max }] : [];
  });
}

/**
 * Flags each agent task whose pinned output, at its inputs' ceilings, needs
 * more tokens than a model's output budget. A task that pins its model, or
 * one no recommended model has the budget for, fails every run: an error.
 * A task some recommended model can answer and another cannot is advisory.
 */
export function outputBudgetDiagnostics(
  tasks: readonly WorkflowTask[],
  contract?: SkillCampaignContract,
): SkillDiagnostic[] {
  const out: SkillDiagnostic[] = [];
  for (const task of tasks) {
    const estimate = estimatePinnedOutputTokens(task, tasks, contract);
    if (estimate === null) continue;
    const budgets = agentOutputBudgets(task.model);
    const short = budgets.filter((b) => b.maxOutputTokens < estimate.tokens);
    if (short.length === 0) continue;
    const scaledBy =
      estimate.scaled.length > 0
        ? ` It counts ${estimate.scaled.map((s) => `${s.path} at ${String(s.count)} items, from ${s.source}`).join(', and ')}.`
        : '';
    const models = short.map((b) => `${b.model} (${String(b.maxOutputTokens)})`).join(', ');
    out.push({
      code: 'output_budget_exceeded',
      dimension: 'semantic',
      severity: short.length === budgets.length ? 'error' : 'advisory',
      taskId: task.taskId,
      detail:
        `Agent task '${task.taskId}' pins an output that needs about ${String(estimate.tokens)} output tokens, more than the output budget of ${models}.${scaledBy} ` +
        'Reasoning is paid from the same budget, so the run truncates before it submits.',
      fixHint:
        'Compute the values by rule in an operation task, for example with workflow.run.derive, and keep only the judgement in the agent’s output. Or bound the arrays the output copies from its input.',
    });
  }
  return out;
}
