import { inferTaskType, type SkillDiagnostic, type WorkflowTask } from '@aflow/schemas';

/**
 * Design pitfalls a machine can find on a skill graph. Each one has failed a
 * live skill. Every check is advisory: it names a likely defect and never
 * blocks a write, an install or a run. The evidence behind each check lives in
 * `.claude/skills/cybernetic-skill-authoring/SKILL.md` (Pitfalls).
 */

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;

function taskFamily(task: WorkflowTask): 'agent' | 'operation' | 'human' | null {
  try {
    return inferTaskType(task);
  } catch {
    return null;
  }
}

/** Every prose surface a model reads on a task. */
function taskProse(task: WorkflowTask): string {
  const t = task as unknown as Rec;
  return ['name', 'goal', 'description', 'pauseInstruction']
    .map((k) => t[k])
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
}

/** Every literal string inside a value, as an operation template carries them. */
function literalStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) literalStrings(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) literalStrings(v, out);
  }
  return out;
}

function directPredecessors(task: WorkflowTask): Set<string> {
  const preds = new Set<string>(task.dependsOn ?? []);
  for (const binding of Object.values(task.inputBindings ?? {})) {
    const taskId = (binding as { taskId?: unknown }).taskId;
    if (typeof taskId === 'string') preds.add(taskId);
  }
  return preds;
}

/** Every task that finishes before each task starts, by its dependencies and bindings. */
function ancestorsByTask(tasks: readonly WorkflowTask[]): Map<string, Set<string>> {
  const direct = new Map(tasks.map((t) => [t.taskId, directPredecessors(t)] as const));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    const all = new Set<string>();
    // A cycle is the graph validator's error. Here it only ends the walk.
    if (stack.has(id)) return all;
    stack.add(id);
    for (const pred of direct.get(id) ?? []) {
      all.add(pred);
      for (const a of visit(pred, stack)) all.add(a);
    }
    stack.delete(id);
    memo.set(id, all);
    return all;
  };
  for (const t of tasks) visit(t.taskId, new Set());
  return memo;
}

// ============================================================================
// model_copy_task
// ============================================================================

const COPY_VERB = /\b(copy|copies|reproduce|transcribe|verbatim)\b/i;
// Verbs only: a word that is also a noun ("the reason", "a plan") would hide a copy task.
const JUDGMENT_VERB =
  /\b(decide|judge|choose|select|assess|evaluate|weigh|analy[sz]e|propose|classify|rank|recommend|diagnose|compare|interpret|critique|veto|approve|reject)\b/gi;
const NEGATION = /\b(no|not|never|nothing|without|don't)\b/i;

/** A judgment verb the goal asks for, not one it forbids ("judge nothing"). */
function hasUnnegatedJudgment(prose: string): boolean {
  for (const match of prose.matchAll(JUDGMENT_VERB)) {
    const start = match.index;
    const before = prose.slice(Math.max(0, start - 24), start);
    const after = prose.slice(start + match[0].length, start + match[0].length + 10);
    if (NEGATION.test(before) || /^\s+nothing\b/i.test(after)) continue;
    return true;
  }
  return false;
}

/** The goal's statement of the task: its first two sentences. */
function statementOf(prose: string): string {
  return prose
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(' ');
}

function outputMirrorsInputs(task: WorkflowTask): boolean {
  const properties = asRec(asRec(task.outputContract?.schema)?.['properties']);
  const inputs = Object.keys(task.inputBindings ?? {});
  if (!properties || inputs.length === 0) return false;
  const outputs = Object.keys(properties);
  return outputs.length === inputs.length && outputs.every((k) => inputs.includes(k));
}

function copyTaskDiagnostics(tasks: readonly WorkflowTask[]): SkillDiagnostic[] {
  const out: SkillDiagnostic[] = [];
  for (const task of tasks) {
    if (taskFamily(task) !== 'agent') continue;
    const goal = typeof task.goal === 'string' ? task.goal : '';
    const copies = COPY_VERB.test(statementOf(goal)) && !hasUnnegatedJudgment(goal);
    if (!copies && !outputMirrorsInputs(task)) continue;
    out.push({
      code: 'model_copy_task',
      dimension: 'semantic',
      severity: 'advisory',
      taskId: task.taskId,
      detail: copies
        ? `Agent task '${task.taskId}' is asked to copy, reproduce or transcribe, and its goal names no judgment. A model that copies a large structured output can fail its shape on every run.`
        : `Agent task '${task.taskId}' returns exactly the fields it is given. A model that echoes its inputs adds a seam that can fail and decides nothing.`,
      fixHint:
        'Remove the model from the copy. Read the documents with operation tasks (memory.store.get, memory.store.query) and bind their outputs to the task that judges them.',
    });
  }
  return out;
}

// ============================================================================
// write_parent_unproduced
// ============================================================================

// memory.store.put creates its parent directories itself, so only a folder write needs one.
const FOLDER_WRITE_OPS = new Set(['host.file.put']);

/** The path with each bound piece as `{}`, or null when it has no literal shape. */
function renderPath(path: unknown): string | null {
  if (typeof path === 'string') return path;
  const concat = asRec(path)?.['$concat'];
  if (!Array.isArray(concat)) return null;
  return concat.map((part) => (typeof part === 'string' ? part : '{}')).join('');
}

function parentOf(rendered: string): string | null {
  const trimmed = rendered.replace(/^\/+/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : null;
}

function createsParents(task: WorkflowTask): boolean {
  return asRec(task.inputTemplate)?.['createParents'] === true;
}

function writeParentDiagnostics(
  tasks: readonly WorkflowTask[],
  ancestors: Map<string, Set<string>>,
): SkillDiagnostic[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t] as const));
  const out: SkillDiagnostic[] = [];
  for (const task of tasks) {
    if (!task.operation || !FOLDER_WRITE_OPS.has(task.operation) || createsParents(task)) continue;
    const rendered = renderPath(asRec(task.inputTemplate)?.['path']);
    const parent = rendered === null ? null : parentOf(rendered);
    if (parent === null) continue;
    const produced = [...(ancestors.get(task.taskId) ?? [])].some((id) => {
      const earlier = byId.get(id);
      if (!earlier?.operation || !FOLDER_WRITE_OPS.has(earlier.operation)) return false;
      if (!createsParents(earlier)) return false;
      const earlierPath = renderPath(asRec(earlier.inputTemplate)?.['path']);
      return earlierPath?.replace(/^\/+/, '').startsWith(`${parent}/`) ?? false;
    });
    if (produced) continue;
    out.push({
      code: 'write_parent_unproduced',
      dimension: 'graph',
      severity: 'advisory',
      taskId: task.taskId,
      operationId: task.operation,
      field: 'path',
      detail: `Task '${task.taskId}' writes under '${parent}/' with ${task.operation}, and no task before it creates that directory. The write fails wherever the folder has no such directory yet.`,
      fixHint: `Set createParents: true on the task's inputTemplate, or create the directory first in a task '${task.taskId}' depends on.`,
    });
  }
  return out;
}

// ============================================================================
// record_reads_superseded_state
// ============================================================================

const RECORD_TASK = /(record|report|snapshot|journal|summar)/i;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_TOOL = /^(post|put|patch|delete)_/i;

function httpMethod(task: WorkflowTask): string {
  const method = asRec(task.inputTemplate)?.['method'];
  return typeof method === 'string' ? method.toUpperCase() : 'GET';
}

/**
 * The service an API id belongs to: its first hyphen segment, so
 * `acme-account-read` and `acme-orders-write` are one service.
 */
function serviceOf(apiId: string): string {
  return apiId.split('-')[0] ?? apiId;
}

function templateApiId(task: WorkflowTask): string | null {
  const apiId = asRec(task.inputTemplate)?.['apiId'];
  return typeof apiId === 'string' ? apiId : null;
}

/** The service an operation task reads, or null where it writes or reads no API. */
function externalReadService(task: WorkflowTask): string | null {
  if (task.operation !== 'api.http.call' || WRITE_METHODS.has(httpMethod(task))) return null;
  const apiId = templateApiId(task);
  return apiId === null ? null : serviceOf(apiId);
}

/** The services a task writes: an API write, or an agent granted a write tool. */
function externalWriteServices(task: WorkflowTask): Set<string> {
  const services = new Set<string>();
  if (task.operation === 'api.http.call') {
    const apiId = templateApiId(task);
    if (apiId !== null && WRITE_METHODS.has(httpMethod(task))) services.add(serviceOf(apiId));
    return services;
  }
  if (taskFamily(task) !== 'agent') return services;
  const caps = asRec(asRec((task as unknown as Rec)['context'])?.['capabilities']);
  const integrations = caps?.['integrations'];
  if (!Array.isArray(integrations)) return services;
  for (const grant of integrations) {
    const g = asRec(grant);
    const integrationId = g?.['integrationId'];
    const names = g?.['toolNames'];
    if (typeof integrationId !== 'string' || !Array.isArray(names)) continue;
    const writes = names
      .map((n) => (typeof n === 'string' ? n : asRec(n)?.['toolName']))
      .some((n) => typeof n === 'string' && WRITE_TOOL.test(n));
    if (writes) services.add(serviceOf(integrationId));
  }
  return services;
}

function recordVantageDiagnostics(
  tasks: readonly WorkflowTask[],
  ancestors: Map<string, Set<string>>,
): SkillDiagnostic[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t] as const));
  const out: SkillDiagnostic[] = [];
  for (const task of tasks) {
    const label = `${task.taskId} ${typeof task.name === 'string' ? task.name : ''}`;
    if (!RECORD_TASK.test(label)) continue;
    const prose = taskProse(task);
    const before = ancestors.get(task.taskId) ?? new Set<string>();
    const readers = new Map<string, string>();
    for (const binding of Object.values(task.inputBindings ?? {})) {
      if (binding.kind !== 'task_output') continue;
      const reader = byId.get(binding.taskId);
      const service = reader ? externalReadService(reader) : null;
      if (service !== null) readers.set(binding.taskId, service);
    }
    for (const [readerId, service] of readers) {
      // A task whose prose names the read, or its vantage, has said what its input shows.
      if (prose.includes(readerId) || /\bvantage\b/i.test(prose)) continue;
      const writer = [...before].find((id) => {
        const w = byId.get(id);
        if (w === undefined || id === readerId || !externalWriteServices(w).has(service)) {
          return false;
        }
        return ancestors.get(id)?.has(readerId) ?? false;
      });
      if (writer === undefined) continue;
      out.push({
        code: 'record_reads_superseded_state',
        dimension: 'graph',
        severity: 'advisory',
        taskId: task.taskId,
        producerTaskId: readerId,
        detail: `Task '${task.taskId}' records the state '${readerId}' read from '${service}' before '${writer}' wrote to it. Its record shows the state before this run's own writes, and can report no position in the cycle that opened one.`,
        fixHint: `Read the state again after '${writer}' and bind that read, or say in the task's prose that its input is '${readerId}' as read before '${writer}'.`,
      });
    }
  }
  return out;
}

// ============================================================================
// nullable_input_reading_unstated
// ============================================================================

function schemaAllowsNull(schema: unknown): boolean {
  const s = asRec(schema);
  if (!s) return false;
  if (s['type'] === 'null' || s['nullable'] === true) return true;
  if (Array.isArray(s['type']) && s['type'].includes('null')) return true;
  for (const key of ['anyOf', 'oneOf']) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.some(schemaAllowsNull)) return true;
  }
  return false;
}

function producesNull(producer: WorkflowTask, field: string): boolean {
  const projection = asRec(asRec((producer as unknown as Rec)['outputProjection'])?.[field]);
  if (projection?.['onMissing'] === 'null') return true;
  const properties = asRec(asRec(producer.outputContract?.schema)?.['properties']);
  return schemaAllowsNull(properties?.[field]);
}

/** A line names the input itself, or a template such as `campaign_{field}` that covers it. */
function lineNames(line: string, name: string): boolean {
  if (line.includes(name)) return true;
  for (const match of line.matchAll(/([A-Za-z_$][\w$]*)\{[^}]+\}/g)) {
    const prefix = match[1];
    if (prefix !== undefined && name.startsWith(prefix) && name.length > prefix.length) return true;
  }
  return false;
}

/** The prose states a null reading where one line names the input and says null. */
function statesNullReading(prose: string, name: string): boolean {
  return prose.split('\n').some((line) => lineNames(line, name) && /\bnull\b/i.test(line));
}

function nullableInputDiagnostics(tasks: readonly WorkflowTask[]): SkillDiagnostic[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t] as const));
  const out: SkillDiagnostic[] = [];
  for (const task of tasks) {
    if (taskFamily(task) !== 'agent') continue;
    const prose = taskProse(task);
    for (const [name, binding] of Object.entries(task.inputBindings ?? {})) {
      if (binding.kind !== 'task_output' || binding.path === undefined) continue;
      // Only a whole top-level field: a nested path reads a shape this check cannot see.
      if (!/^[A-Za-z_$][\w$]*$/.test(binding.path)) continue;
      const producer = byId.get(binding.taskId);
      if (!producer || !producesNull(producer, binding.path)) continue;
      if (statesNullReading(prose, name)) continue;
      out.push({
        code: 'nullable_input_reading_unstated',
        dimension: 'semantic',
        severity: 'advisory',
        taskId: task.taskId,
        field: name,
        producerTaskId: producer.taskId,
        detail: `Agent task '${task.taskId}' reads '${name}', which '${producer.taskId}' may give as null, and its prose never says what null means. A model then guesses, and the same guess repeats on every run.`,
        fixHint: `State the null reading on the line that names '${name}': what the task does when it is null.`,
      });
    }
  }
  return out;
}

// ============================================================================
// dropped_config_field_named
// ============================================================================

const MARKED_INERT = /\b(inert|removed|no longer)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A whole identifier only, so a short name like `cap` never matches `capital`
// or `max_cap`.
function namesField(field: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(field)}(?![\\w$])`);
}

function droppedFieldDiagnostics(
  tasks: readonly WorkflowTask[],
  dropped: readonly string[],
): SkillDiagnostic[] {
  const out: SkillDiagnostic[] = [];
  for (const task of tasks) {
    const lines = [taskProse(task), ...literalStrings(task.inputTemplate)].join('\n').split('\n');
    for (const field of dropped) {
      const pattern = namesField(field);
      const naming = lines.filter((l) => pattern.test(l));
      if (naming.length === 0 || naming.every((l) => MARKED_INERT.test(l))) continue;
      out.push({
        code: 'dropped_config_field_named',
        dimension: 'semantic',
        severity: 'advisory',
        taskId: task.taskId,
        field,
        detail: `Campaign field '${field}' is gone from the contract, and task '${task.taskId}' still names it. A model reads a removed rule as a live one, and cites it.`,
        fixHint: `Remove '${field}' from the task's prose and templates, or mark it inert on the line that names it.`,
      });
    }
  }
  return out;
}

// ============================================================================

export interface DesignPitfallOptions {
  /** The campaign field names the installed or previous version declared. */
  previousCampaignFields?: readonly string[] | undefined;
  /** The campaign field names this version declares. */
  campaignFields?: readonly string[] | undefined;
}

export function designPitfallDiagnostics(
  tasks: readonly WorkflowTask[],
  options: DesignPitfallOptions = {},
): SkillDiagnostic[] {
  const ancestors = ancestorsByTask(tasks);
  const kept = new Set(options.campaignFields ?? []);
  const dropped = (options.previousCampaignFields ?? []).filter((f) => !kept.has(f));
  return [
    ...copyTaskDiagnostics(tasks),
    ...writeParentDiagnostics(tasks, ancestors),
    ...recordVantageDiagnostics(tasks, ancestors),
    ...nullableInputDiagnostics(tasks),
    ...droppedFieldDiagnostics(tasks, dropped),
  ];
}
