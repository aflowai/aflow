'use client';

import { Button, Icon, Input, Text } from '@aflow/design-system';
import {
  isCampaignRef,
  formatCampaignParamForDisplay,
  type Workflow,
  type WorkflowTask,
  type Outcome,
} from '@aflow/schemas';

import { deriveTaskOutputs } from './skill-graph.js';
import type { SkillDraftActions } from './useSkillDraft.js';
import { useOperationCatalog } from '../../hooks/use-operation-catalog.js';
import {
  Sel,
  Editable,
  Empty,
  Mono,
  FlagSel,
  uniqueKey,
  defaultEvaluator,
  BINDING_KIND_OPTIONS,
  SEMANTICS_OPTIONS,
  EVAL_TYPE_OPTIONS,
  OPERATOR_OPTIONS,
  type Evaluator,
  type SelectOption,
} from './inspectorShared.js';

const SHAPE_TYPE_OPTIONS: SelectOption[] = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'integer', label: 'integer' },
  { value: 'boolean', label: 'boolean' },
  { value: 'object', label: 'object' },
  { value: 'array', label: 'array' },
];
function shapeType(shape: Record<string, unknown>): string {
  const t = shape['type'];
  return typeof t === 'string' ? t : '';
}

/**
 * Infer a produces-port shape from the op input it feeds — the same idea the
 * runtime's deriveOpBoundProducerShapes uses, so Declare lands the right type
 * (e.g. a uri-string) instead of a generic object that then mismatches.
 * Follows both direct `inputBindings` (op field = bindAs) and `inputTemplate`
 * (`{ field: { $bind } }`). Falls back to a plain string.
 */
function inferPortShape(
  workflow: Workflow,
  producerId: string,
  portKey: string,
  getOperation: (id: string) => { inputSchema?: unknown } | undefined,
): Record<string, unknown> {
  for (const t of workflow.tasks) {
    if (!t.operation) continue;
    const props = (
      getOperation(t.operation)?.inputSchema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    if (!props) continue;
    const bindings = (t.inputBindings ?? {}) as Record<
      string,
      { kind?: string; taskId?: string; path?: string }
    >;
    const feeds = (b: { kind?: string; taskId?: string; path?: string } | undefined) =>
      b?.kind === 'task_output' && b.taskId === producerId && b.path === portKey;

    for (const [field, b] of Object.entries(bindings)) {
      if (feeds(b) && props[field]) return props[field] as Record<string, unknown>;
    }
    const tmpl = (t as { inputTemplate?: Record<string, { $bind?: string }> }).inputTemplate;
    for (const [field, spec] of Object.entries(tmpl ?? {})) {
      if (spec?.$bind && feeds(bindings[spec.$bind]) && props[field]) {
        return props[field] as Record<string, unknown>;
      }
    }
  }
  return { type: 'string' };
}

// ---------------------------------------------------------------------------
// Outcome evaluator editor
// ---------------------------------------------------------------------------

export function EvaluatorEditor({
  outcome,
  actions,
}: {
  outcome: Outcome;
  actions: SkillDraftActions;
}) {
  const ev = outcome.evaluator;
  const set = (next: Evaluator) => {
    actions.patchOutcome(outcome.id, { evaluator: next });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
      <Sel
        value={ev.type}
        options={EVAL_TYPE_OPTIONS}
        onChange={(v) => {
          set(defaultEvaluator(v as Evaluator['type']));
        }}
      />
      {ev.type === 'threshold' && (
        <>
          <Editable
            value={ev.metric}
            placeholder="metric key"
            onChange={(v) => {
              set({ ...ev, metric: v });
            }}
          />
          {isCampaignRef(ev.operator) ? (
            <Mono>operator: {formatCampaignParamForDisplay(ev.operator)}</Mono>
          ) : (
            <Sel
              value={ev.operator}
              options={OPERATOR_OPTIONS}
              onChange={(v) => {
                set({ ...ev, operator: v as Exclude<typeof ev.operator, object> });
              }}
            />
          )}
          {isCampaignRef(ev.target) ? (
            <Mono>target: {formatCampaignParamForDisplay(ev.target)}</Mono>
          ) : (
            <Editable
              value={String(ev.target)}
              type="number"
              onChange={(v) => {
                set({ ...ev, target: Number(v) || 0 });
              }}
            />
          )}
        </>
      )}
      {ev.type === 'pattern' && (
        <>
          <Editable
            value={ev.metric}
            placeholder="metric key"
            onChange={(v) => {
              set({ ...ev, metric: v });
            }}
          />
          <Editable
            value={ev.pattern}
            placeholder="regex"
            onChange={(v) => {
              set({ ...ev, pattern: v });
            }}
          />
        </>
      )}
      {ev.type === 'manual' && (
        <Editable
          value={ev.instruction}
          multiline
          placeholder="Instruction for the reviewer"
          onChange={(v) => {
            set({ ...ev, instruction: v });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Consumes (input bindings) editor
// ---------------------------------------------------------------------------

interface Binding {
  kind?: string | undefined;
  taskId?: string | undefined;
  path?: string | undefined;
}

export function ConsumesEditor({
  workflow,
  task,
  actions,
}: {
  workflow: Workflow;
  task: WorkflowTask;
  actions: SkillDraftActions;
}) {
  const bindings = (task.inputBindings ?? {}) as Record<string, Binding>;
  const entries = Object.entries(bindings);
  const producerTasks = workflow.tasks.filter((t) => t.taskId !== task.taskId);

  // Persist new bindings, auto-covering producers in dependsOn so the binding
  // resolves (else validation flags `binding_not_upstream`).
  const apply = (next: Record<string, Binding>) => {
    const producers = new Set<string>();
    for (const b of Object.values(next)) {
      if ((b.kind === 'task_output' || b.kind === 'task_summary') && b.taskId)
        producers.add(b.taskId);
    }
    const dependsOn = [...new Set([...(task.dependsOn ?? []), ...producers])];
    actions.patchTask(task.taskId, {
      inputBindings: next as unknown as WorkflowTask['inputBindings'],
      dependsOn,
    });
  };

  const setBinding = (key: string, b: Binding) => {
    apply({ ...bindings, [key]: b });
  };
  const removeBinding = (key: string) => {
    const next = { ...bindings };
    delete next[key];
    apply(next);
  };
  const renameBinding = (oldKey: string, newKey: string) => {
    if (!newKey || newKey === oldKey || bindings[newKey]) return;
    const next: Record<string, Binding> = {};
    for (const [k, v] of entries) next[k === oldKey ? newKey : k] = v;
    apply(next);
  };
  const addBinding = () => {
    setBinding(uniqueKey('input', new Set(Object.keys(bindings))), { kind: 'run_input', path: '' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {entries.length === 0 && <Empty>No inputs.</Empty>}
      {entries.map(([key, b]) => (
        <div
          key={key}
          style={{
            padding: 'var(--space-sm)',
            background: 'var(--color-surface-1)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Input
              value={key}
              onChange={(e) => {
                renameBinding(key, e.target.value);
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => {
                removeBinding(key);
              }}
              title="Remove input"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-error-default, #ef4444)',
              }}
            >
              <Icon name="trash" size="xs" />
            </button>
          </div>
          <Sel
            value={b.kind ?? 'run_input'}
            options={BINDING_KIND_OPTIONS}
            onChange={(v) => {
              setBinding(key, bindingForKind(v, b));
            }}
          />
          {(b.kind === 'task_output' || b.kind === 'task_summary') && (
            <Sel
              value={b.taskId ?? ''}
              options={[
                { value: '', label: '— producer task —' },
                ...producerTasks.map((t) => ({ value: t.taskId, label: t.name })),
              ]}
              onChange={(v) => {
                setBinding(key, { ...b, taskId: v });
              }}
            />
          )}
          {b.kind === 'task_output' && b.taskId && (
            <Sel
              value={b.path ?? ''}
              options={[
                { value: '', label: '— output —' },
                ...outputOptions(workflow, b.taskId, b.path),
              ]}
              onChange={(v) => {
                setBinding(key, { ...b, path: v });
              }}
            />
          )}
          {(b.kind === 'run_input' || b.kind === 'campaign_input') && (
            <Input
              value={b.path ?? ''}
              placeholder="path"
              onChange={(e) => {
                setBinding(key, { ...b, path: e.target.value });
              }}
            />
          )}
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={addBinding}>
        <Icon name="plus" size="xs" /> Add input
      </Button>
    </div>
  );
}

function bindingForKind(kind: string, prev: Binding): Binding {
  if (kind === 'task_output') return { kind, taskId: prev.taskId, path: prev.path };
  if (kind === 'task_summary') return { kind, taskId: prev.taskId };
  return { kind, path: prev.path ?? '' };
}

function outputOptions(workflow: Workflow, producerId: string, current?: string): SelectOption[] {
  const opts = deriveTaskOutputs(workflow, producerId).map((o) => ({
    value: o.key,
    label: o.derived ? `${o.key} (inferred)` : o.key,
  }));
  if (current && !opts.some((o) => o.value === current))
    opts.push({ value: current, label: current });
  return opts;
}

// ---------------------------------------------------------------------------
// Produces (output ports) editor
// ---------------------------------------------------------------------------

export function ProducesEditor({
  workflow,
  task,
  actions,
}: {
  workflow: Workflow;
  task: WorkflowTask;
  actions: SkillDraftActions;
}) {
  const { getOperation } = useOperationCatalog();
  const declared = task.produces ?? [];
  const declaredKeys = new Set(declared.map((p) => p.key));
  const inferred = deriveTaskOutputs(workflow, task.taskId).filter(
    (o) => o.derived && !declaredKeys.has(o.key),
  );

  const setProduces = (next: typeof declared) => {
    actions.patchTask(task.taskId, { produces: next as WorkflowTask['produces'] });
  };
  const declarePort = (key: string, semantics: string) => {
    setProduces([
      ...declared,
      {
        key,
        shape: inferPortShape(workflow, task.taskId, key, getOperation),
        semantics: semantics as (typeof declared)[number]['semantics'],
      },
    ]);
  };
  const removePort = (key: string) => {
    setProduces(declared.filter((p) => p.key !== key));
  };
  const patchPort = (key: string, patch: Partial<(typeof declared)[number]>) => {
    setProduces(declared.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };
  const addPort = () => {
    declarePort(uniqueKey('output', declaredKeys), 'data');
  };

  const consumersOf = (key: string): string[] => {
    const names: string[] = [];
    for (const t of workflow.tasks) {
      if (t.taskId === task.taskId) continue;
      for (const b of Object.values(t.inputBindings ?? {})) {
        const bb = b as { kind?: string; taskId?: string; path?: string };
        if (bb.kind === 'task_output' && bb.taskId === task.taskId && bb.path === key) {
          names.push(t.name);
          break;
        }
      }
    }
    return names;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {declared.length === 0 && inferred.length === 0 && <Empty>No outputs.</Empty>}
      {declared.map((p) => (
        <div
          key={p.key}
          style={{
            padding: 'var(--space-sm)',
            background: 'var(--color-surface-1)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Input
              value={p.key}
              onChange={(e) => {
                patchPort(p.key, { key: e.target.value });
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => {
                removePort(p.key);
              }}
              title="Remove output"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-error-default, #ef4444)',
              }}
            >
              <Icon name="trash" size="xs" />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sel
              value={shapeType(p.shape)}
              options={SHAPE_TYPE_OPTIONS}
              onChange={(v) => {
                patchPort(p.key, { shape: { ...p.shape, type: v } });
              }}
            />
            <Sel
              value={p.semantics}
              options={SEMANTICS_OPTIONS}
              onChange={(v) => {
                patchPort(p.key, { semantics: v as (typeof declared)[number]['semantics'] });
              }}
            />
          </div>
        </div>
      ))}
      {inferred.map((o) => {
        // Declaring only helps once the producer is already strict (has declared
        // ports) — there a missing, declarable port is a real dangling-ref error
        // that Declare fixes. On a port-less producer every binding is already
        // valid, so declaring would only create problems; just show the info.
        const canDeclare = declared.length > 0 && o.declarable;
        const consumers = consumersOf(o.key);
        return (
          <div key={o.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm">{o.key}</Text>
              {consumers.length > 0 && (
                <Text size="xs" color="muted" style={{ fontStyle: 'italic', display: 'block' }}>
                  used by {consumers.join(', ')}
                </Text>
              )}
            </div>
            {canDeclare && (
              <Button
                variant="ghost"
                size="sm"
                title="Declare as an output port (shape inferred from how it's consumed) to satisfy this producer's declared contract"
                onClick={() => {
                  declarePort(o.key, o.semantics);
                }}
              >
                Declare port
              </Button>
            )}
          </div>
        );
      })}
      <Button variant="secondary" size="sm" onClick={addPort}>
        <Icon name="plus" size="xs" /> Add output
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run-state (state variables) editor — skill-wide
// ---------------------------------------------------------------------------

export function StateVarsEditor({
  workflow,
  actions,
}: {
  workflow: Workflow;
  actions: SkillDraftActions;
}) {
  const vars = workflow.stateVariables ?? [];
  const set = (next: typeof vars) => {
    actions.patchWorkflow({ stateVariables: next });
  };
  const patch = (id: string, p: Partial<(typeof vars)[number]>) => {
    set(vars.map((v) => (v.variableId === id ? { ...v, ...p } : v)));
  };
  const remove = (id: string) => {
    set(vars.filter((v) => v.variableId !== id));
  };
  const add = () => {
    const id = uniqueKey('state', new Set(vars.map((v) => v.variableId)));
    set([
      ...vars,
      { variableId: id, name: id, required: false, sensitive: false, immutable: false },
    ]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {vars.length === 0 && <Empty>No run state.</Empty>}
      {vars.map((v) => (
        <div
          key={v.variableId}
          style={{
            padding: 'var(--space-sm)',
            background: 'var(--color-surface-3)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Input
              value={v.name}
              onChange={(e) => {
                patch(v.variableId, { name: e.target.value });
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => {
                remove(v.variableId);
              }}
              title="Remove variable"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-error-default, #ef4444)',
              }}
            >
              <Icon name="trash" size="xs" />
            </button>
          </div>
          <Mono>{v.variableId}</Mono>
          <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            <FlagSel
              label="required"
              value={v.required}
              onChange={(b) => {
                patch(v.variableId, { required: b });
              }}
            />
            <FlagSel
              label="sensitive"
              value={v.sensitive}
              onChange={(b) => {
                patch(v.variableId, { sensitive: b });
              }}
            />
            <FlagSel
              label="immutable"
              value={v.immutable}
              onChange={(b) => {
                patch(v.variableId, { immutable: b });
              }}
            />
          </div>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={add}>
        <Icon name="plus" size="xs" /> Add variable
      </Button>
    </div>
  );
}
