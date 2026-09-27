import type { ComposeIntent, DesignSurface, TaskGraphDraft } from '@aflow/schemas';
import { getAllOperations, isCampaignFieldConsume } from '@aflow/schemas';
import { collectOperationTaskApiRefs } from '../operationTaskApiRefs.js';

// ============================================================================
// Result types
// ============================================================================

export interface ComposeValidationViolation {
  /**
   * Local binding name on the consumer that this violation blames. The
   * inline-op handler resolves this to a `producerTaskId` via the consumer's
   * persisted `inputBindings[bindAs].taskId` and emits a typed
   * `ContractError` with `source.kind = 'binding'` and that producer.
   */
  bindAs: 'draft' | 'intent' | 'surface' | 'evals' | 'assembled';
  /**
   * Stable contract identifier — used as the retry-budget key segment
   * (`${consumerTaskId}|${bindAs}|${contractName}`). Stays constant across
   * consecutive failures of the same validator so the budget counter
   * meaningfully accumulates.
   */
  contractName: string;
  /** Human-readable message; surfaces verbatim in the runner's `system_feedback`. */
  message: string;
  /**
   * Optional Zod-style path into the binding's value, for trace / inspector
   * UI. Empty path = the violation is at the binding's root.
   */
  path?: Array<string | number>;
}

export type ComposeValidationResult =
  { valid: true } | { valid: false; violations: ComposeValidationViolation[] };

// ============================================================================
// Contract names (stable retry-budget keys)
// ============================================================================

export const VALIDATE_TASK_GRAPH_CONTRACT = 'task-graph-self-consistent' as const;
export const VALIDATE_SOURCE_COVERAGE_CONTRACT = 'required-data-source-access' as const;
export const VALIDATE_GRANTS_CONTRACT = 'capability-grants-within-surface' as const;

// ============================================================================
// validate_task_graph — task-graph-self-consistent (lifted)
// ============================================================================

interface TaskIndexEntry {
  index: number;
  producedKeys: Set<string>;
}

/**
 * Cycle detection via Kahn's topological sort. Returns the set of taskIds
 * participating in any cycle; empty when the graph is acyclic.
 */
function findCyclicTaskIds(adjacency: Map<string, Set<string>>): Set<string> {
  const inDegree = new Map<string, number>();
  for (const node of adjacency.keys()) inDegree.set(node, 0);
  for (const [, tos] of adjacency) {
    for (const to of tos) {
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [node, deg] of inDegree) if (deg === 0) queue.push(node);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited.add(node);
    for (const next of adjacency.get(node) ?? new Set<string>()) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  const cyclic = new Set<string>();
  for (const node of adjacency.keys()) if (!visited.has(node)) cyclic.add(node);
  return cyclic;
}

/**
 * Validates the draft's internal references: dependsOn / consumes attribution,
 * outputKey resolution, duplicate-id detection, and acyclicity. All faults
 * blame the `draft` binding — a self-consistency failure is the producer's
 * (draft-task-graph's) responsibility to fix.
 */
export function validateTaskGraphSelfConsistent(draft: TaskGraphDraft): ComposeValidationResult {
  const violations: ComposeValidationViolation[] = [];
  const tasks = draft.tasks;

  // Pass 1: index by taskId, collect produced keys, flag duplicates.
  const indexByTaskId = new Map<string, TaskIndexEntry>();
  for (const [idx, task] of tasks.entries()) {
    if (indexByTaskId.has(task.taskId)) {
      const first = indexByTaskId.get(task.taskId)!;
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_TASK_GRAPH_CONTRACT,
        path: ['tasks', idx, 'taskId'],
        message: `Duplicate taskId "${task.taskId}" — task IDs must be unique within a TaskGraphDraft. The earlier definition is at tasks[${String(first.index)}]. Rename one of them.`,
      });
      continue;
    }
    const producedKeys = new Set<string>();
    for (const p of task.produces ?? []) {
      if (typeof p.key === 'string') producedKeys.add(p.key);
    }
    indexByTaskId.set(task.taskId, { index: idx, producedKeys });
  }

  // Adjacency: from → to means "from must run before to" (producer → consumer).
  const adjacency = new Map<string, Set<string>>();
  for (const taskId of indexByTaskId.keys()) adjacency.set(taskId, new Set());

  // Pass 2: validate dependsOn + consumes references.
  for (const [idx, task] of tasks.entries()) {
    if (indexByTaskId.get(task.taskId)?.index !== idx) continue; // skip duplicates

    for (const [depIdx, dep] of (task.dependsOn ?? []).entries()) {
      if (!indexByTaskId.has(dep)) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_TASK_GRAPH_CONTRACT,
          path: ['tasks', idx, 'dependsOn', depIdx],
          message: `tasks[${String(idx)}] (taskId="${task.taskId}").dependsOn[${String(depIdx)}] references taskId="${dep}" but no such task is declared in the draft. Either remove the reference or add the missing task.`,
        });
        continue;
      }
      adjacency.get(dep)!.add(task.taskId);
    }

    // human tasks: validate approves[] references and add ordering edges.
    if (task.type === 'human') {
      for (const [appIdx, approvedId] of (task.approves ?? []).entries()) {
        if (!indexByTaskId.has(approvedId)) {
          violations.push({
            bindAs: 'draft',
            contractName: VALIDATE_TASK_GRAPH_CONTRACT,
            path: ['tasks', idx, 'approves', appIdx],
            message: `tasks[${String(idx)}] (taskId="${task.taskId}").approves[${String(appIdx)}] references taskId="${approvedId}" but no such task is declared in the draft.`,
          });
          continue;
        }
        adjacency.get(approvedId)!.add(task.taskId);
      }
    }

    // human tasks don't declare `consumes` — skip them.
    const consumes = 'consumes' in task ? (task.consumes ?? []) : [];
    for (const [consIdx, cons] of consumes.entries()) {
      // Campaign-field consumes carry no taskId/outputKey — their validity
      // (declared-field reference) is checked at the draft superRefine.
      if (isCampaignFieldConsume(cons)) continue;
      if (!indexByTaskId.has(cons.taskId)) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_TASK_GRAPH_CONTRACT,
          path: ['tasks', idx, 'consumes', consIdx, 'taskId'],
          message: `tasks[${String(idx)}] (taskId="${task.taskId}").consumes[${String(consIdx)}] references taskId="${cons.taskId}" but no such task is declared in the draft.`,
        });
        continue;
      }

      // Human tasks have no output ports — consuming from one is always wrong.
      const upstreamEntry = indexByTaskId.get(cons.taskId)!;
      const upstreamTask = tasks[upstreamEntry.index];
      if (upstreamTask?.type === 'human') {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_TASK_GRAPH_CONTRACT,
          path: ['tasks', idx, 'consumes', consIdx, 'taskId'],
          message:
            `tasks[${String(idx)}] (taskId="${task.taskId}").consumes[${String(consIdx)}] tries to read output from human task "${cons.taskId}", ` +
            `but human tasks have no typed output ports. ` +
            `Remove this consumes entry and use dependsOn: ["${cons.taskId}"] instead — ` +
            `the run pauses at the human task and only proceeds when the operator approves, ` +
            `so the downstream task will automatically run after approval without needing to read its output.`,
        });
        continue;
      }

      const upstream = upstreamEntry;
      if (cons.outputKey && !upstream.producedKeys.has(cons.outputKey)) {
        const knownKeys =
          upstream.producedKeys.size > 0 ? [...upstream.producedKeys].sort().join(', ') : '(none)';
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_TASK_GRAPH_CONTRACT,
          path: ['tasks', idx, 'consumes', consIdx, 'outputKey'],
          message: `tasks[${String(idx)}] (taskId="${task.taskId}").consumes[${String(consIdx)}] reads outputKey="${cons.outputKey}" from taskId="${cons.taskId}", but that task does not declare it in produces[]. Available keys on "${cons.taskId}": ${knownKeys}.`,
        });
      }
      adjacency.get(cons.taskId)!.add(task.taskId);
    }
  }

  // Cycle detection — only run when the graph is otherwise consistent. A
  // dangling reference would bias the cycle output toward false positives.
  if (violations.length === 0) {
    const cyclic = findCyclicTaskIds(adjacency);
    for (const taskId of [...cyclic].sort()) {
      const idx = indexByTaskId.get(taskId)?.index ?? 0;
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_TASK_GRAPH_CONTRACT,
        path: ['tasks', idx, 'taskId'],
        message: `Task "${taskId}" participates in a dependency cycle. Break the cycle by removing a dependsOn / consumes edge.`,
      });
    }
  }

  // Multiple root tasks — exactly one task may have no predecessors.
  // Only run when no other errors are present (cycles / dangling refs make
  // root-count meaningless). Roots are derived from the SAME adjacency map
  // cycle detection uses, so every predecessor edge (dependsOn, consumes,
  // AND human-task approves) is credited uniformly. A separate field-based
  // computation here would miss approves edges and false-flag an approval
  // gate as a second root.
  if (violations.length === 0) {
    const tasksWithPredecessors = new Set<string>();
    for (const successors of adjacency.values()) {
      for (const succ of successors) tasksWithPredecessors.add(succ);
    }
    const rootTaskIds = [...indexByTaskId.keys()].filter((id) => !tasksWithPredecessors.has(id));
    if (rootTaskIds.length > 1) {
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_TASK_GRAPH_CONTRACT,
        path: ['tasks'],
        message:
          `Multiple root tasks: ${rootTaskIds.map((id) => `"${id}"`).join(', ')} all have no predecessors ` +
          `(no dependsOn or consumes). A workflow must have exactly one starting task. ` +
          `If parallel execution is needed, add a single setup/initialize task and fan out ` +
          `from it using dependsOn.`,
      });
    }
  }

  return violations.length === 0 ? { valid: true } : { valid: false, violations };
}

// ============================================================================
// validate_source_coverage — verifyRequiredDataSourceAccess (lifted)
// ============================================================================

/**
 * Cross-validates that every `intent.requiredDataSources` entry has exactly
 * one task in the draft labelling its purpose AND carrying a callable api/mcp
 * grant.
 *
 * Most violations blame the `draft` binding (the draft is the producer that
 * forgot to label / wire grants). The only `intent`-bindAs case is when the
 * intent itself is structurally malformed (e.g. requiredDataSources that
 * reference an unknown sourceKind) — out of the producer-rerun routing path
 * (intent shouldn't be re-derived mid-run; consumer routes it as
 * `signal_blocked`).
 */
export function validateSourceCoverage(
  intent: ComposeIntent,
  draft: TaskGraphDraft,
): ComposeValidationResult {
  const violations: ComposeValidationViolation[] = [];

  for (const ds of intent.requiredDataSources) {
    if (!ds.sourceId) continue;
    if (ds.sourceKind !== 'api' && ds.sourceKind !== 'mcp') continue;

    interface LabeledTask {
      taskId: string;
      taskIndex: number;
      hasGrantWithCallable: boolean;
    }
    const labeledTasks: LabeledTask[] = [];
    let anyTaskHasGrant = false;

    for (const [taskIdx, task] of draft.tasks.entries()) {
      const labelsThisPurpose = (task.produces ?? []).some(
        (p) => p.providesPurposeId === ds.purposeId,
      );
      let taskHasGrantWithCallable = false;
      if (task.type === 'agent') {
        taskHasGrantWithCallable = task.context.capabilities.integrations.some(
          (grant) =>
            grant.sourceKind === ds.sourceKind &&
            (grant.integrationId === ds.sourceId || grant.bindingId === ds.sourceId) &&
            // A direct_url grant is callable without toolNames.
            (grant.grantKind === 'direct_url' || grant.toolNames.length > 0),
        );
      }
      if (taskHasGrantWithCallable) anyTaskHasGrant = true;
      if (labelsThisPurpose) {
        labeledTasks.push({
          taskId: task.taskId,
          taskIndex: taskIdx,
          hasGrantWithCallable: taskHasGrantWithCallable,
        });
      }
    }

    if (labeledTasks.length === 0) {
      const grantHint = anyTaskHasGrant
        ? ` A task in this draft already carries the ${ds.sourceKind} "${ds.sourceId}" grant — that's the producer; add the label to ITS produces[].`
        : ` No task in this draft grants ${ds.sourceKind} "${ds.sourceId}" yet — first wire the grant on the fetcher task's context.capabilities.integrations[] with { sourceKind: '${ds.sourceKind}', integrationId: '${ds.sourceId}', bindingId, toolNames: [...] }, then label its produces[].`;
      // No `path` — the violation is structural ("the draft is missing a
      // producer task for this purpose"). Keep the intent details (purpose,
      // sourceId) in the message; pinning a path into `requiredDataSources`
      // would point at the intent input, but the rerun blame routes to
      // draft-task-graph which can only edit the draft.
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_SOURCE_COVERAGE_CONTRACT,
        message:
          `requiredDataSources entry purposeId="${ds.purposeId}" (${ds.sourceKind}:${ds.sourceId}) has no producer in the draft. ` +
          `On the task that fetches this real source, add to its produces[]: ` +
          `{ key: "<output-key>", shape: { ... }, providesPurposeId: "${ds.purposeId}" }. ` +
          `Exactly one task must label this purpose; downstream tasks consume from it via consumes[].${grantHint}`,
      });
      continue;
    }

    if (labeledTasks.length > 1) {
      // Path = `tasks` (root of the draft's task array). Multiple tasks are
      // at fault; the producer needs to consolidate.
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_SOURCE_COVERAGE_CONTRACT,
        path: ['tasks'],
        message: `requiredDataSources entry purposeId="${ds.purposeId}" (${ds.sourceKind}:${ds.sourceId}) is labeled by multiple tasks: ${labeledTasks.map((l) => `"${l.taskId}"`).join(', ')}. For API/MCP real sources, exactly one task must fetch the source; downstream tasks should consume[] from it instead of re-labeling. Provenance propagates through consumes automatically.`,
      });
      continue;
    }

    const onlyLabeled = labeledTasks[0]!;
    if (!onlyLabeled.hasGrantWithCallable) {
      const hint = anyTaskHasGrant
        ? `Some other task carries the ${ds.sourceKind} grant — move it to "${onlyLabeled.taskId}" or split the dataflow.`
        : `No task in the draft grants ${ds.sourceKind} "${ds.sourceId}" with a concrete ${ds.sourceKind === 'api' ? 'endpoint' : 'tool'}. Add it to "${onlyLabeled.taskId}".context.capabilities.integrations[] with { sourceKind: '${ds.sourceKind}', integrationId: '${ds.sourceId}', bindingId, toolNames: [...the ${ds.sourceKind === 'api' ? 'endpoint(s)' : 'tool(s)'} the task needs] }.`;
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_SOURCE_COVERAGE_CONTRACT,
        path: ['tasks', onlyLabeled.taskIndex, 'context', 'capabilities'],
        message: `task="${onlyLabeled.taskId}" labels produces[*].providesPurposeId="${ds.purposeId}" but does not grant the required ${ds.sourceKind} capability "${ds.sourceId}" with a callable ${ds.sourceKind === 'api' ? 'endpoint' : 'tool'}. Without a callable ${ds.sourceKind === 'api' ? 'endpoint' : 'tool'} the runner has no platform tool to fetch real data and may fabricate it from compute. ${hint}`,
      });
    }
  }

  return violations.length === 0 ? { valid: true } : { valid: false, violations };
}

// ============================================================================
// capability.validate_grants — verifySurfaceConformance (lifted)
// ============================================================================

interface SurfaceIndex {
  apis: Map<string, Set<string>>; // apiId → bindingIds
  apiEndpoints: Map<string, Set<string>>; // `<apiId>::<bindingId>` → endpoint IDs
  directUrlApiBindings: Set<string>; // `<apiId>::<bindingId>` for callMode==='direct_url'
  mcpServers: Map<string, Set<string>>; // serverId → bindingIds
  mcpTools: Map<string, Set<string>>; // `<serverId>::<bindingId>` → tool names
}

function apiKey(apiId: string, bindingId: string): string {
  return `${apiId}::${bindingId}`;
}

function mcpKey(serverId: string, bindingId: string): string {
  return `${serverId}::${bindingId}`;
}

function buildSurfaceIndex(surface: DesignSurface): SurfaceIndex {
  const apis = new Map<string, Set<string>>();
  const apiEndpoints = new Map<string, Set<string>>();
  const directUrlApiBindings = new Set<string>();
  const mcpServers = new Map<string, Set<string>>();
  const mcpTools = new Map<string, Set<string>>();
  for (const i of surface.integrations) {
    if (i.sourceKind === 'api') {
      if (!apis.has(i.integrationId)) apis.set(i.integrationId, new Set());
      apis.get(i.integrationId)!.add(i.bindingId);
      apiEndpoints.set(apiKey(i.integrationId, i.bindingId), new Set(i.toolNames));
      if (i.callMode === 'direct_url')
        directUrlApiBindings.add(apiKey(i.integrationId, i.bindingId));
    } else {
      if (!mcpServers.has(i.integrationId)) mcpServers.set(i.integrationId, new Set());
      mcpServers.get(i.integrationId)!.add(i.bindingId);
      mcpTools.set(mcpKey(i.integrationId, i.bindingId), new Set(i.toolNames));
    }
  }
  return { apis, apiEndpoints, directUrlApiBindings, mcpServers, mcpTools };
}

const PLATFORM_OP_PREFIXES = new Set([
  'agent',
  'workflow',
  'memory',
  'user',
  'catalog',
  'platform',
  'space',
  'guardrail',
  'eval',
  'learner',
  'proposal',
  'skill',
  'ui',
  'search',
]);

let _knownOperationIds: Set<string> | null = null;
function getKnownOperationIds(): Set<string> {
  if (!_knownOperationIds) {
    _knownOperationIds = new Set(getAllOperations().keys());
  }
  return _knownOperationIds;
}

/**
 * Validates that every capability the draft grants is bound by the prepared
 * design surface. The contract: "draft grants ⊆ DesignSurface". Endpoint and
 * tool subsets are checked against the surface's bound endpoint/tool sets,
 * NOT against current space DB state — the surface is the snapshot the
 * upstream prepare-design-surface step authored, and is the authoritative
 * universe for THIS run.
 *
 * Faults blame the `draft` binding by default. A surface that omits an
 * apiId/serverId / bindingId is technically a `surface`-bindAs fault but in
 * practice manifests as the draft referencing something the surface didn't
 * include — emitting under `draft` keeps the rerun routing target consistent
 * with the producer-rerun rule (rerun draft-task-graph, not
 * prepare-design-surface).
 */
export function validateSurfaceConformance(
  draft: TaskGraphDraft,
  surface: DesignSurface,
): ComposeValidationResult {
  const violations: ComposeValidationViolation[] = [];
  const surfaceIdx = buildSurfaceIndex(surface);
  const knownOps = getKnownOperationIds();

  for (const [taskIdx, task] of draft.tasks.entries()) {
    if (task.type === 'operation') {
      if (!knownOps.has(task.operationId)) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_GRANTS_CONTRACT,
          path: ['tasks', taskIdx, 'operationId'],
          message: `task="${task.taskId}" operationId="${task.operationId}" is not in the platform operation registry. Operation tasks may only reference operations exposed by getAllOperations().`,
        });
      }
      continue;
    }
    if (task.type !== 'agent') continue;

    const caps = task.context.capabilities;

    for (const [grantIdx, grant] of caps.integrations.entries()) {
      const path = ['tasks', taskIdx, 'context', 'capabilities', 'integrations', grantIdx] as const;
      if (grant.sourceKind === 'api') {
        const bindingsForApi = surfaceIdx.apis.get(grant.integrationId);
        if (!bindingsForApi) {
          violations.push({
            bindAs: 'draft',
            contractName: VALIDATE_GRANTS_CONTRACT,
            path: [...path, 'integrationId'],
            message: `task="${task.taskId}" grants apiId="${grant.integrationId}" but the design surface does not list that API. The upstream prepare-design-surface step must have authored it; refusing to emit a workflow with an unbound capability.`,
          });
          continue;
        }
        if (!bindingsForApi.has(grant.bindingId)) {
          violations.push({
            bindAs: 'draft',
            contractName: VALIDATE_GRANTS_CONTRACT,
            path: [...path, 'bindingId'],
            message: `task="${task.taskId}" grants apiId="${grant.integrationId}" with bindingId="${grant.bindingId}", but the surface does not list that bindingId for that apiId. Available bindings: ${[...bindingsForApi].sort().join(', ') || '(none)'}.`,
          });
          continue;
        }
        const isDirectUrlBinding = surfaceIdx.directUrlApiBindings.has(
          apiKey(grant.integrationId, grant.bindingId),
        );
        if (grant.grantKind === 'direct_url') {
          // A direct_url grant is callable without toolNames — it calls
          // api.http.call direct-URL mode against the binding's egress allowlist.
          // It must target a direct_url binding and carry no endpoints.
          if (!isDirectUrlBinding) {
            violations.push({
              bindAs: 'draft',
              contractName: VALIDATE_GRANTS_CONTRACT,
              path: [...path, 'grantKind'],
              message: `task="${task.taskId}" grants grantKind="direct_url" on apiId="${grant.integrationId}"/bindingId="${grant.bindingId}", but the surface binding is endpoint-mode (callMode!=='direct_url'). Use grantKind="endpoint_tools" with specific endpoints, or bind a direct_url capability.`,
            });
          }
          if (grant.toolNames.length > 0) {
            violations.push({
              bindAs: 'draft',
              contractName: VALIDATE_GRANTS_CONTRACT,
              path: [...path, 'toolNames'],
              message: `task="${task.taskId}" grants grantKind="direct_url" with toolNames — a direct_url grant declares NO endpoints (the URL is supplied at call time). Drop toolNames or use grantKind="endpoint_tools".`,
            });
          }
          continue;
        }
        if (isDirectUrlBinding) {
          violations.push({
            bindAs: 'draft',
            contractName: VALIDATE_GRANTS_CONTRACT,
            path: [...path, 'grantKind'],
            message: `task="${task.taskId}" grants endpoint tools on apiId="${grant.integrationId}"/bindingId="${grant.bindingId}", but that binding is direct_url (no endpoints). Grant it with grantKind="direct_url" and call it via api.http.call direct-URL mode.`,
          });
          continue;
        }
        if (grant.toolNames.length === 0) {
          violations.push({
            bindAs: 'draft',
            contractName: VALIDATE_GRANTS_CONTRACT,
            path: [...path, 'toolNames'],
            message: `task="${task.taskId}" grants apiId="${grant.integrationId}"/bindingId="${grant.bindingId}" with no endpoints. compose-skill grants must list specific endpoints — empty toolNames[] produces zero callable tools at runtime, so the runner has no way to call the API.`,
          });
          continue;
        }
        const legalEndpoints =
          surfaceIdx.apiEndpoints.get(apiKey(grant.integrationId, grant.bindingId)) ?? new Set();
        for (const [tnIdx, tn] of grant.toolNames.entries()) {
          if (!legalEndpoints.has(tn)) {
            violations.push({
              bindAs: 'draft',
              contractName: VALIDATE_GRANTS_CONTRACT,
              path: [...path, 'toolNames', tnIdx],
              message: `task="${task.taskId}" grants endpoint="${tn}" on apiId="${grant.integrationId}"/bindingId="${grant.bindingId}", but the surface lists ${[...legalEndpoints].sort().join(', ') || '(no endpoints)'} for that binding.`,
            });
          }
        }
        continue;
      }
      // MCP branch.
      const bindingsForServer = surfaceIdx.mcpServers.get(grant.integrationId);
      if (!bindingsForServer) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_GRANTS_CONTRACT,
          path: [...path, 'integrationId'],
          message: `task="${task.taskId}" grants mcp serverId="${grant.integrationId}" but the design surface does not list that server.`,
        });
        continue;
      }
      if (!bindingsForServer.has(grant.bindingId)) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_GRANTS_CONTRACT,
          path: [...path, 'bindingId'],
          message: `task="${task.taskId}" grants mcp serverId="${grant.integrationId}" with bindingId="${grant.bindingId}", but the surface does not list that bindingId for that serverId.`,
        });
        continue;
      }
      if (grant.toolNames.length === 0) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_GRANTS_CONTRACT,
          path: [...path, 'toolNames'],
          message: `task="${task.taskId}" grants mcp serverId="${grant.integrationId}"/bindingId="${grant.bindingId}" with no tools. compose-skill grants must list specific tools — empty toolNames[] produces zero callable tools at runtime.`,
        });
        continue;
      }
      const legalTools =
        surfaceIdx.mcpTools.get(mcpKey(grant.integrationId, grant.bindingId)) ?? new Set();
      for (const [tnIdx, tn] of grant.toolNames.entries()) {
        if (!legalTools.has(tn)) {
          violations.push({
            bindAs: 'draft',
            contractName: VALIDATE_GRANTS_CONTRACT,
            path: [...path, 'toolNames', tnIdx],
            message: `task="${task.taskId}" grants tool="${tn}" on mcp serverId="${grant.integrationId}"/bindingId="${grant.bindingId}", but the surface lists ${[...legalTools].sort().join(', ') || '(no tools)'} for that binding.`,
          });
        }
      }
    }

    for (const [opIdx, opId] of caps.operations.entries()) {
      const prefix = opId.split('.')[0] ?? opId;
      if (PLATFORM_OP_PREFIXES.has(prefix)) continue;
      if (!knownOps.has(opId)) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_GRANTS_CONTRACT,
          path: ['tasks', taskIdx, 'context', 'capabilities', 'operations', opIdx],
          message: `task="${task.taskId}" grants operation="${opId}" but it is not in the platform operation registry. Tenant-defined external services must be granted via context.capabilities.integrations[] with the appropriate { sourceKind, integrationId, bindingId, toolNames }.`,
        });
      }
    }
  }

  // api.http.call operation tasks reference a binding via inputTemplate, not a
  // context grant — validate that static reference against the surface so the
  // compose Runner gets in-session feedback, not a propose-time failure.
  const taskIndexById = new Map(draft.tasks.map((t, i) => [t.taskId, i]));
  for (const ref of collectOperationTaskApiRefs(draft.tasks)) {
    // Numeric task index for path consistency with the grant-loop violations.
    const path = ['tasks', taskIndexById.get(ref.taskId) ?? ref.taskId, 'inputTemplate'];
    const bindingsForApi = surfaceIdx.apis.get(ref.apiId);
    if (!bindingsForApi) {
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_GRANTS_CONTRACT,
        path: [...path, 'apiId'],
        message: `task="${ref.taskId}" calls api.http.call with apiId="${ref.apiId}" but the design surface does not list that API.`,
      });
      continue;
    }
    if (ref.bindingId && !bindingsForApi.has(ref.bindingId)) {
      violations.push({
        bindAs: 'draft',
        contractName: VALIDATE_GRANTS_CONTRACT,
        path: [...path, 'bindingId'],
        message: `task="${ref.taskId}" calls api.http.call with bindingId="${ref.bindingId}" on apiId="${ref.apiId}", but the surface does not list that binding. Available: ${[...bindingsForApi].sort().join(', ') || '(none)'}.`,
      });
      continue;
    }
    if (ref.bindingId && ref.endpointId) {
      const legal = surfaceIdx.apiEndpoints.get(apiKey(ref.apiId, ref.bindingId)) ?? new Set();
      if (!legal.has(ref.endpointId)) {
        violations.push({
          bindAs: 'draft',
          contractName: VALIDATE_GRANTS_CONTRACT,
          path: [...path, 'endpointId'],
          message: `task="${ref.taskId}" calls api.http.call endpoint="${ref.endpointId}" on apiId="${ref.apiId}"/bindingId="${ref.bindingId}", but the surface lists ${[...legal].sort().join(', ') || '(no endpoints)'}.`,
        });
      }
    }
  }

  return violations.length === 0 ? { valid: true } : { valid: false, violations };
}
