/**
 * What stopped a run short of its primary output.
 *
 * A run can end green while its headline output never arrived: a task
 * succeeded with an outcome its successors' `when` conditions skip on, such
 * as a commit that conflicted. `result.stoppedBy` names that task, or the
 * run's own cancel or failure where no task row holds the cause, so a caller
 * reads one result rather than every task row. An approval gate the operator
 * rejected is named too, with the rejection as its detail.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import {
  WorkflowRunTaskStatusSchema,
  type Workflow,
  type WorkflowRunResultStoppedBy,
  type WorkflowTask,
} from '@aflow/schemas';
import { decodeTaskOutput } from './humanTaskHydration.js';
import { extractRunFailureReason } from './evalJudgeEvidence.js';
import { resolvePromotedRunMetrics, type PromotionTaskResult } from './promotion.js';
import type { WorkflowRunDetail, WorkflowTaskRow } from './ledger/types.js';
import { resolveUserLabels } from './userLabels.js';

/** A storage ceiling for the detail, sized for an error or a git account. */
const MAX_DETAIL_CHARS = 8_000;

const REDACTED = '[redacted]';

type StoppingRun = Pick<
  WorkflowRunDetail,
  'status' | 'failureJson' | 'cancelledBy' | 'cancelReason' | 'tasks'
>;
type StoppingWorkflow = Pick<Workflow, 'tasks' | 'stateVariables'>;

/** What the run named: a task row, or the run itself where no row holds the cause. */
export type RunStopper =
  { kind: 'task'; row: WorkflowTaskRow } | { kind: 'run'; status: 'failed' | 'cancelled' };

function inOrder(workflow: StoppingWorkflow, taskIds: ReadonlySet<string>): WorkflowTask[] {
  return workflow.tasks.filter((t) => taskIds.has(t.taskId));
}

function producersOf(workflow: StoppingWorkflow, primary: string): string[] {
  return workflow.tasks
    .filter((t) => (t.promoteOutputs ?? []).some((p) => p.toState === primary))
    .map((t) => t.taskId);
}

/** The producers of the primary output and every task they depend on, transitively. */
function producerAncestry(workflow: StoppingWorkflow, primary: string): Set<string> {
  const taskById = new Map(workflow.tasks.map((t) => [t.taskId, t]));
  const seen = new Set<string>();
  const pending = producersOf(workflow, primary);
  for (let taskId = pending.pop(); taskId !== undefined; taskId = pending.pop()) {
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    pending.push(...(taskById.get(taskId)?.dependsOn ?? []));
  }
  return seen;
}

function namedByRunFailure(failureJson: unknown): Set<string> {
  if (failureJson === null || typeof failureJson !== 'object') return new Set();
  const taskIds = (failureJson as Record<string, unknown>)['taskIds'];
  return new Set(
    Array.isArray(taskIds) ? taskIds.filter((id): id is string => typeof id === 'string') : [],
  );
}

/**
 * A cancelled run stopped on its own account: the cancel cascades into the
 * task rows, so a cancelled task names the cascade rather than its cause.
 * Otherwise only a required task on the way to a producer of the primary
 * output can stop it: an optional task's failure counts as a satisfied
 * dependency, and a task off that path withholds nothing from it. A failed
 * one comes first. A blocked or cancelled one comes next, behind any task the
 * run's failure names, because a `cancel_siblings` failure off the path
 * blocks the tasks on it. Where a required task on the path was skipped, the
 * latest task that succeeded toward the producer is the one whose outcome
 * skipped it, even when a failure off the path failed the run. A rejected
 * approval gate on the way counts as that outcome. A failed run with none of
 * these stopped on its own account.
 */
export function findStopper(
  workflow: StoppingWorkflow,
  run: StoppingRun,
  primary: string,
  rejectedGates: ReadonlySet<string> = new Set(),
): RunStopper | undefined {
  if (run.status === 'cancelled') return { kind: 'run', status: 'cancelled' };
  const rowByTaskId = new Map(run.tasks.map((r) => [r.taskId, r]));
  const onPath = inOrder(workflow, producerAncestry(workflow, primary)).filter(
    (t) => t.optional !== true,
  );
  const rowWith = (tasks: readonly WorkflowTask[], status: string): WorkflowTaskRow | undefined => {
    for (const task of tasks) {
      const row = rowByTaskId.get(task.taskId);
      if (row?.status === status) return row;
    }
    return undefined;
  };

  const failed = rowWith(onPath, 'failed');
  if (failed) return { kind: 'task', row: failed };
  const halted = rowWith(onPath, 'blocked') ?? rowWith(onPath, 'cancelled');
  if (halted) {
    const named = rowWith(inOrder(workflow, namedByRunFailure(run.failureJson)), 'failed');
    return { kind: 'task', row: named ?? halted };
  }
  if (run.status === 'failed' && !rowWith(onPath, 'skipped')) {
    return { kind: 'run', status: 'failed' };
  }
  const latest = latestSucceededTowardProducer(workflow, rowByTaskId, primary, rejectedGates);
  if (latest) return { kind: 'task', row: latest };
  return run.status === 'failed' ? { kind: 'run', status: 'failed' } : undefined;
}

/**
 * The latest task that succeeded on the way to a producer of the primary
 * output — the producer itself where it succeeded and promoted nothing, or
 * else the last ancestor that succeeded before every task between it and the
 * producer was skipped. An approval gate the operator rejected is skipped
 * too, but its rejection skipped the tasks after it, so the walk ends there
 * as it ends at a task that succeeded. It passes over every other row, so an
 * optional task that failed counts as satisfied, as readiness counts it.
 */
function latestSucceededTowardProducer(
  workflow: StoppingWorkflow,
  rowByTaskId: ReadonlyMap<string, WorkflowTaskRow>,
  primary: string,
  rejectedGates: ReadonlySet<string>,
): WorkflowTaskRow | undefined {
  const taskById = new Map(workflow.tasks.map((t) => [t.taskId, t]));
  const order = new Map(workflow.tasks.map((t, i) => [t.taskId, i]));
  const pending = producersOf(workflow, primary);
  const visited = new Set<string>();
  const candidates: WorkflowTaskRow[] = [];
  for (let taskId = pending.pop(); taskId !== undefined; taskId = pending.pop()) {
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    const row = rowByTaskId.get(taskId);
    if (row?.status === 'succeeded' || (row?.status === 'skipped' && rejectedGates.has(taskId))) {
      candidates.push(row);
      continue;
    }
    pending.push(...(taskById.get(taskId)?.dependsOn ?? []));
  }
  const at = (row: WorkflowTaskRow): number => row.completedAt?.getTime() ?? 0;
  const position = (row: WorkflowTaskRow): number => order.get(row.taskId) ?? 0;
  let latest: WorkflowTaskRow | undefined;
  for (const row of candidates) {
    if (
      !latest ||
      at(row) > at(latest) ||
      (at(row) === at(latest) && position(row) > position(latest))
    ) {
      latest = row;
    }
  }
  return latest;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * The approval gates on the way to the primary output that the operator
 * rejected, with the decision each recorded. A `reject` resume lands the gate
 * `skipped` with a `{ decision: 'rejected' }` output. A row its own `when`
 * skipped holds no output, so it is never one.
 */
async function rejectedGatesOnPath(
  payloadStore: PayloadStore,
  workflow: StoppingWorkflow,
  run: StoppingRun,
  primary: string,
): Promise<Map<string, Record<string, unknown>>> {
  const onPath = producerAncestry(workflow, primary);
  const gates = new Map<string, Record<string, unknown>>();
  for (const row of run.tasks) {
    if (row.status !== 'skipped' || !row.outputRef || !onPath.has(row.taskId)) continue;
    const output = await decodeTaskOutput(row.outputRef, payloadStore).catch(() => null);
    if (output?.['decision'] === 'rejected') gates.set(row.taskId, output);
  }
  return gates;
}

/**
 * Which of a task's own accounts fill a sensitive variable: its whole output,
 * named output paths, or its summary. Those stay out of the detail, as the
 * variables they fill stay out of `output`.
 */
function sensitiveSources(task: WorkflowTask | undefined, sensitiveIds: ReadonlySet<string>) {
  const promotions = (task?.promoteOutputs ?? []).filter((p) => sensitiveIds.has(p.toState));
  const paths = promotions.flatMap((p) => (p.kind === 'output_path' ? [p.path] : []));
  return {
    output: promotions.some((p) => p.kind === 'output_root'),
    summary: promotions.some((p) => p.kind === 'task_summary'),
    field: (key: string): boolean => paths.some((p) => p === key || p.startsWith(`${key}.`)),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The display name of the user who decided a gate, or nothing. A gate
 * records the user's id, which a caller must never read. An email is not a
 * display name either, as the detail reaches agent context.
 */
async function deciderLabel(
  db: PostgresJsDatabase,
  decidedBy: string | undefined,
): Promise<string | undefined> {
  if (decidedBy === undefined || !UUID.test(decidedBy)) return undefined;
  const label = await resolveUserLabels(db, [decidedBy])
    .then((labels) => labels.get(decidedBy))
    .catch(() => undefined);
  return label === undefined || label === decidedBy || label.includes('@') ? undefined : label;
}

/**
 * What the task said about how it ended: a failure's reason, the decision a
 * rejected gate recorded, or, for a task that succeeded, the `state` and
 * `detail` its output reports. A gate names who decided it by display name,
 * or as an operator decision where no display name resolves.
 */
async function describeTaskEnding(
  deps: StoppedByDeps,
  row: WorkflowTaskRow,
  task: WorkflowTask | undefined,
  sensitiveIds: ReadonlySet<string>,
  rejection: Readonly<Record<string, unknown>> | undefined,
): Promise<string | undefined> {
  const hidden = sensitiveSources(task, sensitiveIds);
  const recorded = text(row.failureReason) ?? (hidden.summary ? undefined : text(row.summary));
  if (rejection !== undefined) {
    if (hidden.output) return recorded;
    const said = (key: string): string | undefined =>
      hidden.field(key) ? undefined : text(rejection[key]);
    const by = await deciderLabel(deps.db, said('decidedBy'));
    const comment = said('comment');
    const head = `rejected by ${by ?? 'an operator decision'}`;
    return comment === undefined ? head : `${head}: ${comment}`;
  }
  if (row.status !== 'succeeded' || hidden.output) return recorded;
  const output = await decodeTaskOutput(row.outputRef, deps.payloadStore).catch(() => null);
  const field = (key: string): string | undefined =>
    hidden.field(key) ? undefined : text(output?.[key]);
  const state = field('state');
  const said = field('detail') ?? field('summary') ?? recorded;
  const parts = [state === undefined ? undefined : `state: ${state}`, said].filter(
    (p): p is string => p !== undefined,
  );
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

function describeRunEnding(run: StoppingRun): string | undefined {
  if (run.status !== 'cancelled') return text(extractRunFailureReason(run.failureJson));
  const actor = text(run.cancelledBy);
  const reason = text(run.cancelReason);
  if (actor === undefined) return reason;
  return reason === undefined ? `cancelled by ${actor}` : `cancelled by ${actor}: ${reason}`;
}

/**
 * Below this length a spelling also spells parts of unrelated text, such as
 * `dev` in `development` or `42` in `142`. It is matched only as a whole token.
 */
const MIN_FREE_TEXT_CHARS = 6;

interface SensitiveSpellings {
  /** The JSON text of every sensitive value and of every node inside one. */
  nodes: Set<string>;
  /** Spellings that match anywhere in text. */
  free: string[];
  /** Short spellings that match in text only where they stand alone. */
  tokens: string[];
}

function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function addTextSpelling(spelled: string, into: SensitiveSpellings): void {
  if (spelled.length >= MIN_FREE_TEXT_CHARS) into.free.push(spelled);
  else into.tokens.push(spelled);
}

/**
 * The spellings a sensitive value takes when a reason quotes it: a string as
 * itself, and a number, boolean or object as its JSON text. An object's
 * leaves are spelled too, as a message usually quotes one field of it.
 */
function collectSpellings(value: unknown, into: SensitiveSpellings): void {
  if (typeof value === 'string') {
    if (text(value) === undefined) return;
    into.nodes.add(JSON.stringify(value));
    addTextSpelling(value, into);
    return;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    const spelled = String(value);
    if (typeof value !== 'number' || Number.isFinite(value)) into.nodes.add(spelled);
    addTextSpelling(spelled, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const children = Object.values(value);
  if (children.length === 0) return;
  const serialised = jsonText(value);
  if (serialised !== undefined) {
    into.nodes.add(serialised);
    addTextSpelling(serialised, into);
  }
  for (const child of children) collectSpellings(child, into);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const DIGIT = /\d/;

/**
 * Whether the spelling at `start` stands alone: no letter, digit or
 * underscore touches either edge, and a number is not the whole or the
 * fraction part of a longer decimal such as `1.05`.
 */
function standsAlone(textValue: string, start: number, spelled: string): boolean {
  const end = start + spelled.length;
  const before = textValue.charAt(start - 1);
  const after = textValue.charAt(end);
  const first = spelled.charAt(0);
  const last = spelled.charAt(spelled.length - 1);
  if (WORD_CHAR.test(first) && before !== '' && WORD_CHAR.test(before)) return false;
  if (WORD_CHAR.test(last) && after !== '' && WORD_CHAR.test(after)) return false;
  if (DIGIT.test(first) && before === '.' && DIGIT.test(textValue.charAt(start - 2))) return false;
  if (DIGIT.test(last) && after === '.' && DIGIT.test(textValue.charAt(end + 1))) return false;
  return true;
}

function replaceTokens(textValue: string, spelled: string): string {
  let out = '';
  let from = 0;
  for (let at = textValue.indexOf(spelled); at !== -1; at = textValue.indexOf(spelled, at + 1)) {
    if (at < from || !standsAlone(textValue, at, spelled)) continue;
    out += textValue.slice(from, at) + REDACTED;
    from = at + spelled.length;
  }
  return out + textValue.slice(from);
}

/** Longest first, so an object's JSON text is replaced whole before its leaves. */
function longestFirst(spellings: readonly string[]): string[] {
  return [...new Set(spellings)].sort((a, b) => b.length - a.length);
}

function redactAnywhere(textValue: string, spellings: SensitiveSpellings): string {
  let out = textValue;
  for (const spelled of longestFirst(spellings.free)) out = out.split(spelled).join(REDACTED);
  return out;
}

/** Replaces a long spelling anywhere in the text, and a short one where it stands alone. */
function redactText(textValue: string, spellings: SensitiveSpellings): string {
  let out = redactAnywhere(textValue, spellings);
  for (const spelled of longestFirst(spellings.tokens)) out = replaceTokens(out, spelled);
  return out;
}

/**
 * Replaces a node whose JSON text is a sensitive value. A string leaf is
 * text as well, so the text rule applies inside it.
 */
function redactNode(node: unknown, spellings: SensitiveSpellings): unknown {
  const spelled = jsonText(node);
  if (spelled !== undefined && spellings.nodes.has(spelled)) return REDACTED;
  if (typeof node === 'string') return redactText(node, spellings);
  if (Array.isArray(node)) return node.map((child) => redactNode(child, spellings));
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, child]) => [key, redactNode(child, spellings)]),
  );
}

/** Where the JSON object or array opening at `start` closes, or -1. */
function closingIndex(detail: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < detail.length; i++) {
    const c = detail.charAt(i);
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function decodeJson(slice: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(slice) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * Replaces the sensitive values a detail quotes. The whole detail and each
 * JSON object or array inside it match by node. The text between them
 * matches by the text rule. A last pass replaces a long spelling that runs
 * from text into JSON.
 */
function redact(detail: string, spellings: SensitiveSpellings): string {
  const whole = detail.trim();
  if (spellings.nodes.has(whole) || spellings.nodes.has(JSON.stringify(whole))) return REDACTED;
  let out = '';
  let between = '';
  let i = 0;
  while (i < detail.length) {
    const c = detail.charAt(i);
    const end = c === '{' || c === '[' ? closingIndex(detail, i) : -1;
    const slice = end === -1 ? undefined : detail.slice(i, end + 1);
    const decoded = slice === undefined ? undefined : decodeJson(slice);
    if (slice === undefined || decoded === undefined) {
      between += c;
      i++;
      continue;
    }
    out += redactText(between, spellings);
    between = '';
    const redacted = redactNode(decoded.value, spellings);
    const changed = jsonText(redacted) !== jsonText(decoded.value);
    out += redacted === REDACTED ? REDACTED : changed ? (jsonText(redacted) ?? slice) : slice;
    i = end + 1;
  }
  return redactAnywhere(out + redactText(between, spellings), spellings);
}

function bounded(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS
    ? `${detail.slice(0, MAX_DETAIL_CHARS)}… [truncated]`
    : detail;
}

export interface StoppedByDeps {
  db: PostgresJsDatabase;
  payloadStore: PayloadStore;
}

export interface BuildStoppedByArgs {
  workflow: StoppingWorkflow;
  run: StoppingRun;
  primary: string;
  /** The succeeded rows that promote outputs, which the result decoded. */
  promotingRows: readonly WorkflowTaskRow[];
  /** What decoding those rows returned. A row missing here, or without output, did not decode. */
  taskResults: readonly PromotionTaskResult[];
}

/**
 * Decodes again each promoting row whose output the result could not read,
 * through the loader that also reads inline and serialised outputs. A row
 * still unread is returned as undecoded.
 */
async function rereadOutputs(
  payloadStore: PayloadStore,
  rows: readonly WorkflowTaskRow[],
  taskResults: readonly PromotionTaskResult[],
): Promise<{ results: PromotionTaskResult[]; undecoded: Set<string> }> {
  const byTaskId = new Map(taskResults.map((r) => [r.taskId, r]));
  const results = [...taskResults];
  const undecoded = new Set<string>();
  for (const row of rows) {
    const held = byTaskId.get(row.taskId);
    if (!row.outputRef || held?.output !== undefined) continue;
    const output = await decodeTaskOutput(row.outputRef, payloadStore).catch(() => null);
    if (output === null) {
      undecoded.add(row.taskId);
      continue;
    }
    const reread: PromotionTaskResult = held
      ? { ...held, output }
      : {
          taskId: row.taskId,
          status: row.status,
          output,
          ...(row.summary ? { summary: row.summary } : {}),
          ...(row.metricsJson ? { metrics: row.metricsJson as Record<string, unknown> } : {}),
        };
    if (held) results[results.indexOf(held)] = reread;
    else results.push(reread);
  }
  return { results, undecoded };
}

/**
 * What stopped the run short of its primary output, or nothing where the run
 * produced it. The sanitiser may remove a primary that was produced, so the
 * raw bag decides that. Where the output of a producer of the primary could
 * not be decoded, the primary may have been produced, so no stop is reported.
 * Where an undecoded output fills a sensitive variable, its values cannot be
 * redacted, so the stop is reported without its detail.
 */
export async function buildStoppedBy(
  deps: StoppedByDeps,
  args: BuildStoppedByArgs,
): Promise<WorkflowRunResultStoppedBy | undefined> {
  const { payloadStore } = deps;
  const { workflow, run, primary } = args;
  const { results, undecoded } = await rereadOutputs(
    payloadStore,
    args.promotingRows,
    args.taskResults,
  );
  if (producersOf(workflow, primary).some((taskId) => undecoded.has(taskId))) return undefined;
  const bag = resolvePromotedRunMetrics(workflow.tasks, results, workflow.stateVariables);
  if (bag[primary] !== undefined) return undefined;

  const rejectedGates = await rejectedGatesOnPath(payloadStore, workflow, run, primary);
  const stopper = findStopper(workflow, run, primary, new Set(rejectedGates.keys()));
  if (!stopper) return undefined;

  const sensitiveIds = new Set(
    workflow.stateVariables.filter((v) => v.sensitive).map((v) => v.variableId),
  );
  const redactable = !workflow.tasks.some(
    (t) =>
      undecoded.has(t.taskId) && (t.promoteOutputs ?? []).some((p) => sensitiveIds.has(p.toState)),
  );
  const spellings: SensitiveSpellings = { nodes: new Set(), free: [], tokens: [] };
  for (const [key, value] of Object.entries(bag)) {
    if (sensitiveIds.has(key)) collectSpellings(value, spellings);
  }

  let head: Pick<WorkflowRunResultStoppedBy, 'taskId' | 'status'>;
  let detail: string | undefined;
  if (stopper.kind === 'run') {
    head = { taskId: null, status: stopper.status };
    detail = describeRunEnding(run);
  } else {
    const status = WorkflowRunTaskStatusSchema.safeParse(stopper.row.status);
    if (!status.success) return undefined;
    head = { taskId: stopper.row.taskId, status: status.data };
    const task = workflow.tasks.find((t) => t.taskId === stopper.row.taskId);
    detail = await describeTaskEnding(
      deps,
      stopper.row,
      task,
      sensitiveIds,
      rejectedGates.get(stopper.row.taskId),
    );
  }
  return detail === undefined || !redactable
    ? head
    : { ...head, detail: bounded(redact(detail, spellings)) };
}
