import { MarkerType, type Node, type Edge } from '@xyflow/react';
import {
  inferTaskType,
  predicateExpressions,
  workflowWhenView,
  type Workflow,
  type WorkflowTask,
  type WorkflowWhenView,
  type Outcome,
  type SkillValidity,
  type SkillDiagnostic,
  type SkillCampaignContract,
  isCampaignFieldMutable,
} from '@aflow/schemas';

/** A campaign-contract field flattened for display on the Campaign node. */
export interface CampaignFieldView {
  key: string;
  label: string;
  identity: boolean;
  mutable: boolean;
  type: string;
}

export function campaignFieldViews(contract: SkillCampaignContract): CampaignFieldView[] {
  return Object.entries(contract.fields).map(([key, f]) => {
    const schema = f.schema as { type?: unknown; enum?: unknown };
    const type = Array.isArray(schema.enum)
      ? 'enum'
      : typeof schema.type === 'string'
        ? schema.type
        : 'value';
    return {
      key,
      label: f.label,
      identity: f.identity === true,
      mutable: isCampaignFieldMutable(f),
      type,
    };
  });
}

/**
 * Enriched graph model for the Skill Designer.
 *
 * Where the read-only inspector graph (`workflow-to-graph.ts`) only renders
 * the task DAG, the designer canvas tells the whole skill story: a Goal anchor
 * up top, an Activation entry node, the typed task DAG in the middle, and an
 * Outcomes terminal. Each task node carries the visual clues an operator needs
 * to reason about it at a glance — dispatch kind, granted capabilities, typed
 * port counts, conditional/eval markers, and a live validity dot sourced from
 * the recompute-at-read `contractValidity`.
 */

export type SkillNodeKind = 'goal' | 'activation' | 'task' | 'outcomes';
export type TaskDispatch = 'agent' | 'operation' | 'human';
export type NodeSeverity = 'error' | 'advisory' | null;

export interface CapabilityChip {
  label: string;
  /** `api` / `mcp` integration grant, or `operation` for a native op tool. */
  source: 'api' | 'mcp' | 'operation';
}

interface GoalNodeData extends Record<string, unknown> {
  nodeKind: 'goal';
  skillName: string;
  goal?: string | undefined;
  description?: string | undefined;
  mode: Workflow['mode'];
  taskCount: number;
  outcomeCount: number;
}

interface ActivationNodeData extends Record<string, unknown> {
  nodeKind: 'activation';
  triggerPatterns: string[];
  activationHint?: string | undefined;
  priority?: number | undefined;
  prerequisites: string[];
  iterationAuto?: boolean | undefined;
  hasBudget: boolean;
  severity: NodeSeverity;
}

export interface TaskNodeData extends Record<string, unknown> {
  nodeKind: 'task';
  taskId: string;
  title: string;
  dispatch: TaskDispatch;
  /** The agent id / operation id / human intent — the secondary identity line. */
  dispatchLabel?: string | undefined;
  goalPreview: string;
  optional: boolean;
  retryCount?: number | undefined;
  model?: string | undefined;
  capabilities: CapabilityChip[];
  producesCount: number;
  consumesCount: number;
  /** Named consumes (inputBinding keys) — "what this task requires". */
  inputs: string[];
  /** Named output ports — declared, plus those derived from downstream usage. */
  outputs: DerivedOutput[];
  /** Display-ready `when` guard — present iff the task is conditional. */
  when?: WorkflowWhenView | undefined;
  /**
   * Output subjects (`decision`, `status`, …) that ≥2 downstream edges branch
   * on — this task is a decision point; the fan edges carry the outcomes.
   */
  branchSubjects?: string[] | undefined;
  hasEval: boolean;
  /** Distinct eval-criterion type labels for this task (badge reference). */
  evalTypes?: string[] | undefined;
  agentStepCount?: number | undefined;
  isEntry: boolean;
  severity: NodeSeverity;
  task: WorkflowTask;
}

interface OutcomesNodeData extends Record<string, unknown> {
  nodeKind: 'outcomes';
  outcomes: Array<{ id: string; name: string; type: string }>;
}

interface CampaignNodeData extends Record<string, unknown> {
  nodeKind: 'campaign';
  fields: CampaignFieldView[];
}

export type DataSourceKind = 'run' | 'campaign' | 'artifact' | 'feedback';

interface SourceNodeData extends Record<string, unknown> {
  nodeKind: 'source';
  sourceKind: DataSourceKind;
  label: string;
}

export type SkillNodeData =
  | GoalNodeData
  | ActivationNodeData
  | TaskNodeData
  | OutcomesNodeData
  | CampaignNodeData
  | SourceNodeData;

export type GraphLens = 'control' | 'data';
export type DataSemantics = 'data' | 'artifact' | 'metric' | 'status';

export interface DerivedOutput {
  key: string;
  semantics: DataSemantics;
  /** True when the port is not declared in `produces[]` but is consumed
   *  downstream via a `task_output` binding — the runtime back-fills these. */
  derived?: boolean | undefined;
  /** A `produces[]` key must be a bare identifier. Dotted sub-paths
   *  (`stat.sizeBytes`) can never match a port, so they are not declarable —
   *  their producer must stay port-less to keep the binding valid. */
  declarable?: boolean | undefined;
}

const IDENT_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** A task's effective outputs: declared `produces[]` ports unioned with the
 *  output keys downstream tasks consume from it (the runtime materializes the
 *  latter, so they are absent from the persisted doc but real at run time). */
export function deriveTaskOutputs(workflow: Workflow, taskId: string): DerivedOutput[] {
  const task = workflow.tasks.find((t) => t.taskId === taskId);
  const declared = new Map<string, DataSemantics>();
  for (const p of task?.produces ?? []) declared.set(p.key, p.semantics);

  const out: DerivedOutput[] = [];
  for (const [key, semantics] of declared) out.push({ key, semantics, declarable: true });

  const seen = new Set(declared.keys());
  for (const t of workflow.tasks) {
    for (const raw of Object.values(t.inputBindings ?? {})) {
      const b = raw as { kind?: string; taskId?: string; path?: string };
      if (b.kind !== 'task_output' || b.taskId !== taskId) continue;
      // Key by the FULL binding path — the validator matches `path === key`
      // exactly, no sub-path resolution. A pathless binding consumes the whole
      // output. Only bare-identifier paths can be declared as a port.
      const key = b.path?.trim() ? b.path : 'output';
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ key, semantics: 'data', derived: true, declarable: IDENT_RE.test(key) });
      }
    }
  }
  return out;
}

export const GOAL_NODE_ID = '__goal__';
export const ACTIVATION_NODE_ID = '__activation__';
export const OUTCOMES_NODE_ID = '__outcomes__';
export const CAMPAIGN_NODE_ID = '__campaign__';

export interface DiagnosticsIndex {
  /** taskId → its diagnostics (errors + advisories). */
  byTask: Map<string, SkillDiagnostic[]>;
  /** Diagnostics that do not localize to a task (graph-level). */
  general: SkillDiagnostic[];
  errorCount: number;
  advisoryCount: number;
}

export function indexDiagnostics(validity?: SkillValidity): DiagnosticsIndex {
  const byTask = new Map<string, SkillDiagnostic[]>();
  const general: SkillDiagnostic[] = [];
  const all = validity ? [...validity.diagnostics, ...validity.advisories] : [];
  for (const d of all) {
    if (d.taskId) {
      const list = byTask.get(d.taskId) ?? [];
      list.push(d);
      byTask.set(d.taskId, list);
    } else {
      general.push(d);
    }
  }
  return {
    byTask,
    general,
    errorCount: validity?.diagnostics.length ?? 0,
    advisoryCount: validity?.advisories.length ?? 0,
  };
}

function severityFor(diags: SkillDiagnostic[] | undefined): NodeSeverity {
  if (!diags || diags.length === 0) return null;
  return diags.some((d) => d.severity === 'error') ? 'error' : 'advisory';
}

function capabilityChips(task: WorkflowTask): CapabilityChip[] {
  const chips: CapabilityChip[] = [];
  const caps = task.context?.capabilities;
  if (caps) {
    for (const integ of caps.integrations ?? []) {
      chips.push({
        label: integ.integrationId ?? integ.capabilityId,
        source: integ.sourceKind === 'mcp' ? 'mcp' : 'api',
      });
    }
    for (const op of caps.operations ?? []) {
      chips.push({ label: op, source: 'operation' });
    }
  }
  return chips;
}

function dispatchLabelFor(task: WorkflowTask, dispatch: TaskDispatch): string | undefined {
  if (dispatch === 'agent') return task.agent ?? 'cybernetic-runner';
  if (dispatch === 'operation') return task.operation;
  if (dispatch === 'human') return task.intent === 'approve' ? 'approval gate' : 'collect input';
  return undefined;
}

export interface BuildSkillGraphOptions {
  agentStepCounts?: Map<string, number> | undefined;
  validity?: SkillValidity | undefined;
  /** 'control' (default) draws dependsOn; 'data' overlays produces→consumes. */
  lens?: GraphLens | undefined;
  /** Task ids that have eval criteria in the eval suite (lights the eval badge). */
  tasksWithEval?: Set<string> | undefined;
  /** The skill's campaign contract — when present, a read-only Campaign anchor node. */
  campaignContract?: SkillCampaignContract | undefined;
  /** Per-task distinct eval-criterion type labels — lights the badge + reference. */
  taskEvalTypes?: Map<string, string[]> | undefined;
}

export const DATA_SEMANTIC_COLOR: Record<DataSemantics, string> = {
  data: 'var(--color-info-default, #38bdf8)',
  artifact: 'var(--color-accent-default)',
  metric: 'var(--color-success-default, #4ade80)',
  status: 'var(--color-warning-default, #fbbf24)',
};

function dataEdge(
  id: string,
  source: string,
  target: string,
  label: string,
  semantics: DataSemantics,
): Edge {
  const color = DATA_SEMANTIC_COLOR[semantics];
  return {
    id,
    source,
    target,
    type: 'default',
    label,
    labelStyle: { fontSize: 10, fill: 'var(--color-text-secondary)' },
    labelBgStyle: { fill: 'var(--color-surface-0)', fillOpacity: 0.9 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    style: { stroke: color, strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
    animated: true,
  };
}

/** Builds the produces→consumes overlay: input-source chips + labeled,
 *  semantic-coloured data edges. task_output/task_summary become task→task
 *  edges; run/campaign/artifact/feedback bindings become source chips. */
function collectDataFlow(workflow: Workflow): {
  sourceNodes: Array<Node<SkillNodeData>>;
  dataEdges: Edge[];
} {
  const semanticsByProducer = new Map<string, Map<string, DataSemantics>>();
  for (const t of workflow.tasks) {
    if (!t.produces) continue;
    const m = new Map<string, DataSemantics>();
    for (const p of t.produces) m.set(p.key, p.semantics);
    semanticsByProducer.set(t.taskId, m);
  }

  const taskIds = new Set(workflow.tasks.map((t) => t.taskId));
  const sources = new Map<string, Node<SkillNodeData>>();
  const dataEdges: Edge[] = [];

  const addSource = (id: string, sourceKind: DataSourceKind, label: string) => {
    if (!sources.has(id)) {
      sources.set(id, {
        id,
        type: 'skillSource',
        position: { x: 0, y: 0 },
        data: { nodeKind: 'source', sourceKind, label },
      });
    }
  };

  for (const task of workflow.tasks) {
    const binds = task.inputBindings ? Object.entries(task.inputBindings) : [];
    for (const [bindAs, raw] of binds) {
      const b = raw as { kind?: string; taskId?: string; path?: string };
      const edgeId = `data:${bindAs}->${task.taskId}:${String(b.kind)}:${b.taskId ?? b.path ?? ''}`;
      if (b.kind === 'task_output' && b.taskId && taskIds.has(b.taskId)) {
        const semantics = (b.path && semanticsByProducer.get(b.taskId)?.get(b.path)) || 'data';
        dataEdges.push(
          dataEdge(edgeId, b.taskId, task.taskId, `${b.path ?? 'output'} → ${bindAs}`, semantics),
        );
      } else if (b.kind === 'task_summary' && b.taskId && taskIds.has(b.taskId)) {
        dataEdges.push(dataEdge(edgeId, b.taskId, task.taskId, `summary → ${bindAs}`, 'data'));
      } else if (b.kind === 'run_input') {
        const id = `src:run:${b.path ?? ''}`;
        addSource(id, 'run', `run: ${b.path ?? '·'}`);
        dataEdges.push(dataEdge(edgeId, id, task.taskId, bindAs, 'data'));
      } else if (b.kind === 'campaign_input') {
        const id = `src:campaign:${b.path ?? ''}`;
        addSource(id, 'campaign', `campaign: ${b.path ?? '·'}`);
        dataEdges.push(dataEdge(edgeId, id, task.taskId, bindAs, 'data'));
      } else if (b.kind === 'artifact_binding') {
        addSource('src:artifact', 'artifact', 'artifact');
        dataEdges.push(dataEdge(edgeId, 'src:artifact', task.taskId, bindAs, 'artifact'));
      } else if (b.kind === 'system_feedback') {
        addSource('src:feedback', 'feedback', 'system feedback');
        dataEdges.push(dataEdge(edgeId, 'src:feedback', task.taskId, bindAs, 'status'));
      }
    }
  }

  return { sourceNodes: [...sources.values()], dataEdges };
}

export interface SkillGraph {
  nodes: Array<Node<SkillNodeData>>;
  edges: Edge[];
  diagnostics: DiagnosticsIndex;
}

const CONTROL_EDGE = {
  type: 'default' as const,
  style: { stroke: 'var(--color-text-muted, #94a3b8)', strokeWidth: 2 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 18,
    height: 18,
    color: 'var(--color-text-muted, #94a3b8)',
  },
};

const ANCHOR_EDGE = {
  type: 'default' as const,
  style: {
    stroke: 'var(--color-accent-default)',
    strokeWidth: 2,
    strokeDasharray: '6 4',
  },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 18,
    height: 18,
    color: 'var(--color-accent-default)',
  },
};

const CONDITIONAL_EDGE = {
  type: 'default' as const,
  style: {
    stroke: 'var(--color-warning-default, #fbbf24)',
    strokeWidth: 2,
    strokeDasharray: '5 4',
  },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 18,
    height: 18,
    color: 'var(--color-warning-default, #fbbf24)',
  },
};

const CONDITION_EDGE_LABEL_MAX = 60;

/**
 * Guard clauses grouped by the upstream task they reference
 * (`tasks.<id>.<subject> <op> <literal>`), with the `tasks.<id>.` prefix
 * stripped for edge-label display. Clauses that don't parse (or reference no
 * task) stay card-only.
 */
export function whenClausesBySource(task: WorkflowTask): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  if (!task.when) return bySource;
  for (const raw of predicateExpressions(task.when)) {
    const match = /^\s*tasks\.([^.\s]+)\.(.+)$/.exec(raw);
    const source = match?.[1];
    const clause = match?.[2]?.trim();
    if (!source || !clause) continue;
    const list = bySource.get(source) ?? [];
    list.push(clause);
    bySource.set(source, list);
  }
  return bySource;
}

export function conditionEdgeLabel(task: WorkflowTask, clauses: string[]): string {
  const joiner = task.when && 'anyOf' in task.when ? ' | ' : ' & ';
  const label = clauses.join(joiner);
  return label.length > CONDITION_EDGE_LABEL_MAX
    ? `${label.slice(0, CONDITION_EDGE_LABEL_MAX - 1)}…`
    : label;
}

const COMPARISON_RE = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

interface ConditionalEdgeRecord {
  edge: Edge;
  task: WorkflowTask;
  clauses: string[];
}

/**
 * Branch fans — the guard model is task-level, but a decision READS at its
 * producer: when one source task gates ≥2 out-edges on the same subject
 * (`decision`, `status`, …), badge the producer with the subject and compact
 * those edge labels to just the outcome (`== 'approved'`). Sources with a
 * single gated edge keep the full clause on that edge.
 */
function applyBranchFans(
  conditionalEdges: ConditionalEdgeRecord[],
  nodes: Array<Node<SkillNodeData>>,
): void {
  const bySource = new Map<string, ConditionalEdgeRecord[]>();
  for (const record of conditionalEdges) {
    const list = bySource.get(record.edge.source) ?? [];
    list.push(record);
    bySource.set(record.edge.source, list);
  }
  for (const [source, records] of bySource) {
    const edgesPerSubject = new Map<string, number>();
    for (const record of records) {
      const subjects = new Set(
        record.clauses.map((c) => COMPARISON_RE.exec(c)?.[1]).filter(Boolean),
      );
      for (const s of subjects) edgesPerSubject.set(s!, (edgesPerSubject.get(s!) ?? 0) + 1);
    }
    const fanSubjects = [...edgesPerSubject]
      .filter(([, edgeCount]) => edgeCount >= 2)
      .map(([subject]) => subject);
    if (fanSubjects.length === 0) continue;
    const fanSet = new Set(fanSubjects);
    for (const record of records) {
      const compacted = record.clauses.map((clause) => {
        const match = COMPARISON_RE.exec(clause);
        const [, subject, operator, value] = match ?? [];
        return subject !== undefined && fanSet.has(subject) ? `${operator} ${value}` : clause;
      });
      record.edge.label = conditionEdgeLabel(record.task, compacted);
    }
    const node = nodes.find((n) => n.id === source);
    if (node && node.data.nodeKind === 'task') {
      node.data.branchSubjects = fanSubjects.map((s) => s.replace(/^output\./, ''));
    }
  }
}

export function buildSkillGraph(workflow: Workflow, opts?: BuildSkillGraphOptions): SkillGraph {
  const diagnostics = indexDiagnostics(opts?.validity);
  const tasks = workflow.tasks;
  const dependedOn = new Set<string>();
  for (const t of tasks) for (const d of t.dependsOn ?? []) dependedOn.add(d);

  const taskCriteriaMetrics = new Set<string>();
  for (const t of tasks) if ((t.metrics?.length ?? 0) > 0) taskCriteriaMetrics.add(t.taskId);

  const nodes: Array<Node<SkillNodeData>> = [];
  const edges: Edge[] = [];
  const conditionalEdges: ConditionalEdgeRecord[] = [];

  // Goal anchor (pinned narrative header).
  nodes.push({
    id: GOAL_NODE_ID,
    type: 'skillGoal',
    position: { x: 0, y: 0 },
    data: {
      nodeKind: 'goal',
      skillName: workflow.name,
      goal: workflow.goal,
      description: workflow.description,
      mode: workflow.mode,
      taskCount: tasks.length,
      outcomeCount: workflow.outcomes.length,
    },
  });

  // Campaign anchor — only when the skill declares a contract. Read-only.
  if (opts?.campaignContract && Object.keys(opts.campaignContract.fields).length > 0) {
    nodes.push({
      id: CAMPAIGN_NODE_ID,
      type: 'skillCampaign',
      position: { x: 360, y: 0 },
      data: {
        nodeKind: 'campaign',
        fields: campaignFieldViews(opts.campaignContract),
      },
    });
    edges.push({
      id: `e-${GOAL_NODE_ID}-${CAMPAIGN_NODE_ID}`,
      source: GOAL_NODE_ID,
      target: CAMPAIGN_NODE_ID,
      ...ANCHOR_EDGE,
    });
  }

  // Activation entry anchor.
  const act = workflow.activation;
  nodes.push({
    id: ACTIVATION_NODE_ID,
    type: 'skillActivation',
    position: { x: 0, y: 160 },
    data: {
      nodeKind: 'activation',
      triggerPatterns: act?.triggerPatterns ?? [],
      activationHint: act?.activationHint,
      priority: act?.priority,
      prerequisites: act?.prerequisites ?? [],
      iterationAuto: workflow.iteration?.auto,
      hasBudget: workflow.budget != null,
      severity: act ? null : 'advisory',
    },
  });
  edges.push({
    id: `${GOAL_NODE_ID}->${ACTIVATION_NODE_ID}`,
    source: GOAL_NODE_ID,
    target: ACTIVATION_NODE_ID,
    ...ANCHOR_EDGE,
  });

  // Task nodes.
  tasks.forEach((task, index) => {
    const dispatch = inferTaskType(task);
    const isEntry = (task.dependsOn ?? []).length === 0;
    const agentRef =
      dispatch === 'agent'
        ? (task.agent ?? workflow.assignedAgent ?? 'cybernetic-runner')
        : undefined;
    nodes.push({
      id: task.taskId,
      type: 'skillTask',
      position: { x: 0, y: 320 + index * 170 },
      data: {
        nodeKind: 'task',
        taskId: task.taskId,
        title: task.name,
        dispatch,
        dispatchLabel: dispatchLabelFor(task, dispatch),
        goalPreview: task.goal.length > 110 ? task.goal.slice(0, 107) + '…' : task.goal,
        optional: task.optional === true,
        retryCount: task.retryCount,
        model: task.model,
        capabilities: capabilityChips(task),
        producesCount: task.produces?.length ?? 0,
        consumesCount: task.inputBindings ? Object.keys(task.inputBindings).length : 0,
        inputs: task.inputBindings ? Object.keys(task.inputBindings) : [],
        outputs: deriveTaskOutputs(workflow, task.taskId),
        ...(task.when ? { when: workflowWhenView(task.when) } : {}),
        hasEval:
          (opts?.tasksWithEval?.has(task.taskId) ?? false) ||
          (opts?.taskEvalTypes?.get(task.taskId)?.length ?? 0) > 0 ||
          taskCriteriaMetrics.has(task.taskId),
        evalTypes: opts?.taskEvalTypes?.get(task.taskId),
        agentStepCount: agentRef ? opts?.agentStepCounts?.get(agentRef) : undefined,
        isEntry,
        severity: severityFor(diagnostics.byTask.get(task.taskId)),
        task,
      },
    });

    if (isEntry) {
      edges.push({
        id: `${ACTIVATION_NODE_ID}->${task.taskId}`,
        source: ACTIVATION_NODE_ID,
        target: task.taskId,
        ...ANCHOR_EDGE,
      });
    }
    const guardBySource = whenClausesBySource(task);
    for (const dep of task.dependsOn ?? []) {
      if (!tasks.some((t) => t.taskId === dep)) continue;
      const guardClauses = guardBySource.get(dep);
      if (guardClauses && guardClauses.length > 0) {
        // The guard references this upstream task — render the edge as a
        // conditional branch with the comparison(s) as its label.
        const edge: Edge = {
          id: `${dep}->${task.taskId}`,
          source: dep,
          target: task.taskId,
          ...CONDITIONAL_EDGE,
          data: { conditional: true },
          label: conditionEdgeLabel(task, guardClauses),
          labelStyle: { fontSize: 10, fill: 'var(--color-warning-default, #fbbf24)' },
          labelBgStyle: { fill: 'var(--color-surface-0)', fillOpacity: 0.9 },
          labelBgPadding: [4, 2],
          labelBgBorderRadius: 4,
        };
        edges.push(edge);
        conditionalEdges.push({ edge, task, clauses: guardClauses });
      } else {
        edges.push({
          id: `${dep}->${task.taskId}`,
          source: dep,
          target: task.taskId,
          ...CONTROL_EDGE,
        });
      }
    }
  });

  applyBranchFans(conditionalEdges, nodes);

  // Outcomes terminal anchor.
  nodes.push({
    id: OUTCOMES_NODE_ID,
    type: 'skillOutcomes',
    position: { x: 0, y: 320 + tasks.length * 170 },
    data: {
      nodeKind: 'outcomes',
      outcomes: workflow.outcomes.map((o: Outcome) => ({
        id: o.id,
        name: o.name,
        type: o.evaluator.type,
      })),
    },
  });
  for (const task of tasks) {
    if (dependedOn.has(task.taskId)) continue;
    edges.push({
      id: `${task.taskId}->${OUTCOMES_NODE_ID}`,
      source: task.taskId,
      target: OUTCOMES_NODE_ID,
      ...ANCHOR_EDGE,
    });
  }

  // Data lens: keep the same nodes for spatial stability, fade the control
  // edges to context, and overlay the produces→consumes data flow + sources.
  if (opts?.lens === 'data') {
    const dimmed: Edge[] = edges.map(({ markerEnd: _markerEnd, ...e }) => ({
      ...e,
      animated: false,
      label: undefined,
      style: { ...e.style, opacity: 0.18 },
    }));
    const { sourceNodes, dataEdges } = collectDataFlow(workflow);
    return { nodes: [...nodes, ...sourceNodes], edges: [...dimmed, ...dataEdges], diagnostics };
  }

  return { nodes, edges, diagnostics };
}
