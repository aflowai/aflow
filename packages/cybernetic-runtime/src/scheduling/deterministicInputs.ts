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
 * Helmsman reasoned its way to a Saturday. These checks flag a date a model
 * or a caller supplies where a deterministic source could. They are
 * advisory, because a skill may take a date it truly needs from outside.
 */

const DATE_PATTERNS = new Set(['^\\d{4}-\\d{2}-\\d{2}$', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$']);

type Schema = Record<string, unknown>;

const asSchema = (v: unknown): Schema | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Schema) : null;

/** A string schema whose every value is a calendar date or an instant. */
export function isClockValueSchema(schema: unknown): boolean {
  const s = asSchema(schema);
  if (s?.['type'] !== 'string') return false;
  if (s['format'] === 'date' || s['format'] === 'date-time') return true;
  const pattern = s['pattern'];
  return typeof pattern === 'string' && DATE_PATTERNS.has(pattern);
}

const FIX_HINT =
  'Read the date in the run: an operation task on the exchange clock, with a run deriver over the clock and calendar for the trading day, or a `clock` input binding for an instant. Then bind every reader to that task.';

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
    if (!input.required || !isClockValueSchema(input.schema)) continue;
    out.push({
      code: 'clock_value_from_caller',
      dimension: 'graph',
      severity: 'advisory',
      ...(entry ? { taskId: entry.taskId } : {}),
      field: input.id,
      detail:
        `Run input '${input.id}' is a date the exchange clock or calendar gives, and every caller must supply it. ` +
        'A schedule’s prompt or a model then works the date out, and can name the wrong day.',
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
      if (!isClockValueSchema(schema) || pinned.has(field)) continue;
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
          `Agent task '${task.taskId}' writes '${field}', a date the exchange clock or calendar gives, and ${read} read it. ` +
          'No derivedFrom binding pins it, so the model works the date out and can name the wrong day.',
        fixHint: `${FIX_HINT} Or pin '${field}' to that task's output with a derivedFrom value binding.`,
      });
    }
  }
  return out;
}
