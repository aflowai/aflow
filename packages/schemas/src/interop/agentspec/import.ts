import type {
  AgentSpecComponent,
  AgentSpecAgent,
  AgentSpecFlow,
  AgentSpecTool,
  AgentSpecNode,
  AgentSpecControlFlowEdge,
  AgentSpecLlmConfig,
  AgentSpecSwarm,
  AgentSpecManagerWorkers,
} from './types.js';
import { isComponentRef } from './types.js';
import { isAgentComponent, isFlowComponent } from './validate.js';
import {
  NODE_TYPE_TO_OPERATION,
  TOOL_TYPE_TO_OPERATION,
  propertiesToJsonSchema,
  toStepId,
  toToolStepId,
} from './mapping.js';
import type { AgentDefinition } from '../../artifact/flowDefinition.js';
import type { StepDefinition } from '../../artifact/stepDefinition.js';
import type { StepId, AgentSlug, OperationId } from '../../runtime/ids.js';
import { slugify } from '../../runtime/slugReservation.js';
import type { StepType } from '../../artifact/operationDefinition.js';

// Branded type cast helpers — interop data comes from external JSON,
// so we must cast plain strings to Phoenix's branded types.
const sid = (s: string) => s as StepId;
const oid = (s: string) => s as OperationId;
const stype = (s: string) => s as StepType;

function importedFlowId(name: string, fallback: string): AgentSlug {
  const candidate = slugify(name) || slugify(fallback) || 'imported-agent';
  return candidate as AgentSlug;
}

// ============================================================================
// Import Result
// ============================================================================

export interface ImportResult {
  /** The converted flow definition */
  flow: AgentDefinition;
  /** Warnings about lossy conversions or unsupported features */
  warnings: string[];
  /** Unresolved $component_ref placeholders (need secret injection) */
  unresolvedSecrets: string[];
}

// ============================================================================
// Main Import Function
// ============================================================================

/**
 * Import an Agent Spec component and convert it to a Phoenix AgentDefinition.
 */
export function importAgentSpec(spec: AgentSpecComponent): ImportResult {
  if (isAgentComponent(spec)) {
    return importAgent(spec);
  }
  if (isFlowComponent(spec)) {
    return importFlow(spec);
  }
  if (spec.component_type === 'Swarm') {
    return importSwarm(spec);
  }
  if (spec.component_type === 'ManagerWorkers') {
    return importManagerWorkers(spec);
  }
  throw new Error(
    `Unsupported component_type for import: ${(spec as { component_type: string }).component_type}`,
  );
}

// ============================================================================
// Agent Import
// ============================================================================

function importAgent(agent: AgentSpecAgent): ImportResult {
  const warnings: string[] = [];
  const unresolvedSecrets: string[] = [];

  const agentStepId = sid('agent');
  const steps: StepDefinition[] = [];

  // Build agent step config
  const config: Record<string, unknown> = {};
  if (agent.system_prompt) {
    config['systemPrompt'] = agent.system_prompt;
  }
  if (agent.llm_config) {
    const modelId = agent.llm_config.model_id;
    config['model'] = modelId;
    if (agent.llm_config.api_key) {
      if (isComponentRef(agent.llm_config.api_key)) {
        unresolvedSecrets.push(agent.llm_config.api_key.$component_ref);
      }
    }
    if (agent.llm_config.temperature !== undefined) {
      config['temperature'] = agent.llm_config.temperature;
    }
    if (agent.llm_config.max_tokens !== undefined) {
      config['maxTokens'] = agent.llm_config.max_tokens;
    }
  }
  config['prompt'] = '${input.message}';

  // Build tool steps
  const toolSteps: StepDefinition[] = [];
  if (agent.tools) {
    for (const tool of agent.tools) {
      const toolStep = importTool(tool, agentStepId, warnings, unresolvedSecrets);
      toolSteps.push(toolStep);
    }
  }

  // MCP toolboxes
  if (agent.toolbox && agent.toolbox.length > 0) {
    warnings.push(
      'MCPToolBox references require the MCP client step type (Phase 4). ' +
        'Toolbox entries are not imported.',
    );
  }

  // Agent step — links to tools via onSuccess
  const toolEdges = toolSteps.map((t) => ({ stepId: t.stepId, priority: 50 as const }));
  const agentStep: StepDefinition = {
    stepId: agentStepId,
    name: agent.name,
    description: agent.description,
    stepType: stype('ai'),
    operation: oid('ai.agent.turn'),
    config,
    onSuccess: { next: toolEdges.length > 0 ? toolEdges : [] },
    onFailure: { next: [] },
    tags: [],
    optional: false,
  };

  steps.push(agentStep, ...toolSteps);

  const flow: AgentDefinition = {
    schemaVersion: 1,
    flowId: importedFlowId(agent.name, agent.id),
    systemRole: null,
    version: '1',
    metadata: {
      name: agent.name,
      description: agent.description,
      tags: ['imported:agentspec', `agentspec_version:${agent.agentspec_version ?? 'unknown'}`],
      public: false,
      system: false,
      custom: {
        _agentspec: {
          sourceId: agent.id,
          version: agent.agentspec_version ?? 'unknown',
          componentType: 'Agent',
        },
      },
    },
    stateVariables: [],
    steps,
    startStepId: sid(agentStepId),
    allowedOperations: [],
    supportedModes: ['api', 'chat'],
    status: 'draft',
  };

  return { flow, warnings, unresolvedSecrets };
}

// ============================================================================
// Flow Import
// ============================================================================

function importFlow(spec: AgentSpecFlow): ImportResult {
  const warnings: string[] = [];
  const unresolvedSecrets: string[] = [];

  const steps: StepDefinition[] = [];
  const nodeIdToStepId = new Map<string, string>();

  // Find start and end nodes
  let startNodeId: string | undefined;
  const endNodeIds = new Set<string>();

  for (const node of spec.nodes) {
    if (node.component_type === 'StartNode') {
      startNodeId = node.id;
    } else if (node.component_type === 'EndNode') {
      endNodeIds.add(node.id);
    }
  }

  // Map nodes to steps
  for (const node of spec.nodes) {
    if (node.component_type === 'StartNode' || node.component_type === 'EndNode') {
      nodeIdToStepId.set(node.id, toStepId(node.id));
      continue;
    }

    const stepId = toStepId(node.id);
    nodeIdToStepId.set(node.id, stepId);

    const step = importNode(node, warnings, unresolvedSecrets);
    steps.push(step);
  }

  // Apply control flow edges
  const controlEdges = spec.edges.filter(
    (e): e is AgentSpecControlFlowEdge => e.component_type === 'ControlFlowEdge',
  );

  for (const edge of controlEdges) {
    const sourceStepId = nodeIdToStepId.get(edge.source_node);
    const targetStepId = nodeIdToStepId.get(edge.target_node);

    if (!sourceStepId || !targetStepId) continue;

    // If source is StartNode, this determines startStepId
    if (edge.source_node === startNodeId) continue; // Handled below

    // If target is EndNode, this is a terminal edge (no next step)
    if (endNodeIds.has(edge.target_node)) continue;

    const sourceStep = steps.find((s) => s.stepId === sid(sourceStepId));
    if (!sourceStep) continue;

    const isError = edge.from_branch === 'error' || edge.from_branch === 'failure';
    if (isError) {
      sourceStep.onFailure.next.push({ stepId: sid(targetStepId), priority: 50 });
    } else {
      sourceStep.onSuccess.next.push({ stepId: sid(targetStepId), priority: 50 });
    }
  }

  // Determine start step: first control edge from StartNode
  let startStepId: StepId = steps[0]?.stepId ?? sid('start');
  if (startNodeId) {
    const startEdge = controlEdges.find((e) => e.source_node === startNodeId);
    if (startEdge) {
      const mapped = nodeIdToStepId.get(startEdge.target_node);
      if (mapped) startStepId = sid(mapped);
    }
  }

  // Handle data flow edges (best-effort)
  const dataEdges = spec.edges.filter((e) => e.component_type === 'DataFlowEdge');
  if (dataEdges.length > 0) {
    warnings.push(
      `${String(dataEdges.length)} DataFlowEdge(s) found. ` +
        'Data flow mapping to Phoenix outputMapping/input bindings is best-effort.',
    );
  }

  const flow: AgentDefinition = {
    schemaVersion: 1,
    flowId: importedFlowId(spec.name, spec.id),
    systemRole: null,
    version: '1',
    metadata: {
      name: spec.name,
      description: spec.description,
      tags: ['imported:agentspec', `agentspec_version:${spec.agentspec_version ?? 'unknown'}`],
      public: false,
      system: false,
      custom: {
        _agentspec: {
          sourceId: spec.id,
          version: spec.agentspec_version ?? 'unknown',
          componentType: 'Flow',
        },
      },
    },
    stateVariables: [],
    steps,
    startStepId,
    allowedOperations: [],
    supportedModes: ['api'],
    status: 'draft',
  };

  return { flow, warnings, unresolvedSecrets };
}

// ============================================================================
// Node Import
// ============================================================================

function importNode(
  node: AgentSpecNode,
  warnings: string[],
  _unresolvedSecrets: string[],
): StepDefinition {
  const stepId = toStepId(node.id);
  const operation = NODE_TYPE_TO_OPERATION[node.component_type] ?? 'api.http.call';
  const stepType = operation.split('.')[0] ?? 'api';
  const config: Record<string, unknown> = {};

  switch (node.component_type) {
    case 'StartNode':
    case 'EndNode':
      break;
    case 'ToolNode': {
      const toolNode = node as { tool?: AgentSpecTool } & AgentSpecNode;
      if (toolNode.tool) {
        if (toolNode.tool.inputs) {
          config['inputSchema'] = propertiesToJsonSchema(toolNode.tool.inputs);
        }
        if (toolNode.tool.requires_confirmation) {
          config['opTaskOnly'] = true;
        }
      }
      break;
    }
    case 'LlmNode': {
      const llmNode = node as {
        llm_config?: AgentSpecLlmConfig;
        prompt?: string;
        system_prompt?: string;
      } & AgentSpecNode;
      if (llmNode.llm_config?.model_id) {
        config['model'] = llmNode.llm_config.model_id;
      }
      if (llmNode.prompt) {
        config['prompt'] = llmNode.prompt;
      }
      if (llmNode.system_prompt) {
        config['systemPrompt'] = llmNode.system_prompt;
      }
      break;
    }
    case 'AgentNode': {
      const agentNode = node as { agent?: AgentSpecAgent } & AgentSpecNode;
      if (agentNode.agent) {
        if (agentNode.agent.system_prompt) {
          config['systemPrompt'] = agentNode.agent.system_prompt;
        }
        if (agentNode.agent.llm_config?.model_id) {
          config['model'] = agentNode.agent.llm_config.model_id;
        }
      }
      break;
    }
    case 'ApiNode': {
      const apiNode = node as {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
      } & AgentSpecNode;
      if (apiNode.url) config['url'] = apiNode.url;
      if (apiNode.method) config['method'] = apiNode.method;
      if (apiNode.headers) config['headers'] = apiNode.headers;
      break;
    }
    case 'BranchingNode': {
      warnings.push(
        `BranchingNode "${node.id}" imported as a generic step. Conditions may need manual adjustment.`,
      );
      break;
    }
    case 'MapNode': {
      warnings.push(
        `MapNode "${node.id}" has no Phoenix equivalent. Imported as a placeholder step.`,
      );
      break;
    }
  }

  return {
    stepId: sid(stepId),
    name: node.name,
    description: node.description,
    stepType: stype(stepType),
    operation: oid(operation),
    config,
    onSuccess: { next: [] },
    onFailure: { next: [] },
    tags: [],
    optional: false,
  };
}

// ============================================================================
// Tool Import
// ============================================================================

function importTool(
  tool: AgentSpecTool,
  agentStepId: string,
  warnings: string[],
  _unresolvedSecrets: string[],
): StepDefinition {
  const stepId = toToolStepId(tool.name ?? tool.id);
  const operation = TOOL_TYPE_TO_OPERATION[tool.component_type] ?? 'api.http.call';
  const stepType = operation.split('.')[0] ?? 'api';
  const config: Record<string, unknown> = {};

  if (tool.inputs) {
    config['inputSchema'] = propertiesToJsonSchema(tool.inputs);
  }
  if (tool.requires_confirmation) {
    config['opTaskOnly'] = true;
  }

  // RemoteTool-specific
  if (tool.component_type === 'RemoteTool') {
    const remote = tool as { url?: string; method?: string };
    if (remote.url) config['url'] = remote.url;
    if (remote.method) config['method'] = remote.method;
  }

  // MCPTool-specific
  if (tool.component_type === 'MCPTool') {
    warnings.push(
      `MCPTool "${tool.name}" requires mcp.tool.call operation (Phase 4). Imported as api.http.call placeholder.`,
    );
  }

  return {
    stepId: sid(stepId),
    name: tool.name,
    description: tool.description,
    stepType: stype(stepType),
    operation: oid(operation),
    config,
    onSuccess: { next: [{ stepId: sid(agentStepId), priority: 50 }] },
    onFailure: { next: [{ stepId: sid(agentStepId), priority: 50 }] },
    tags: [],
    optional: false,
  };
}

// ============================================================================
// Multi-Agent Pattern Import (simplified)
// ============================================================================

function importSwarm(spec: AgentSpecSwarm): ImportResult {
  const warnings = [
    'Swarm pattern imported as a simplified multi-agent flow. ' +
      'Handoff semantics may need manual adjustment.',
  ];

  // Import each member as an agent step, chain them sequentially
  const steps: StepDefinition[] = [];
  for (let i = 0; i < spec.members.length; i++) {
    const member = spec.members[i]!;
    const result = importAgent(member);
    // Prefix step IDs to avoid collision
    for (const step of result.flow.steps) {
      step.stepId = sid(`swarm-${String(i)}-${step.stepId}`);
    }
    steps.push(...result.flow.steps);
    warnings.push(...result.warnings);
  }

  const flow: AgentDefinition = {
    schemaVersion: 1,
    flowId: importedFlowId(spec.name, spec.id),
    systemRole: null,
    version: '1',
    metadata: {
      name: spec.name,
      description: spec.description,
      tags: ['imported:agentspec', 'pattern:swarm'],
      public: false,
      system: false,
      custom: { _agentspec: { sourceId: spec.id, componentType: 'Swarm' } },
    },
    stateVariables: [],
    steps,
    startStepId: steps[0]?.stepId ?? sid('start'),
    allowedOperations: [],
    supportedModes: ['api'],
    status: 'draft',
  };

  return { flow, warnings, unresolvedSecrets: [] };
}

function importManagerWorkers(spec: AgentSpecManagerWorkers): ImportResult {
  const warnings = [
    'ManagerWorkers pattern imported as a simplified multi-agent flow. ' +
      'Manager-worker delegation semantics may need manual adjustment.',
  ];

  const managerResult = importAgent(spec.manager);
  const steps = [...managerResult.flow.steps];

  for (let i = 0; i < spec.workers.length; i++) {
    const worker = spec.workers[i]!;
    const workerResult = importAgent(worker);
    for (const step of workerResult.flow.steps) {
      step.stepId = sid(`worker-${String(i)}-${step.stepId}`);
    }
    steps.push(...workerResult.flow.steps);
    warnings.push(...workerResult.warnings);
  }

  const flow: AgentDefinition = {
    schemaVersion: 1,
    flowId: importedFlowId(spec.name, spec.id),
    systemRole: null,
    version: '1',
    metadata: {
      name: spec.name,
      description: spec.description,
      tags: ['imported:agentspec', 'pattern:manager-workers'],
      public: false,
      system: false,
      custom: { _agentspec: { sourceId: spec.id, componentType: 'ManagerWorkers' } },
    },
    stateVariables: [],
    steps,
    startStepId: steps[0]?.stepId ?? sid('start'),
    allowedOperations: [],
    supportedModes: ['api'],
    status: 'draft',
  };

  return { flow, warnings, unresolvedSecrets: [] };
}
