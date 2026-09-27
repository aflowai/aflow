import type { AgentDefinition } from '../../artifact/flowDefinition.js';
import type { StepDefinition } from '../../artifact/stepDefinition.js';
import type {
  AgentSpecComponent,
  AgentSpecAgent,
  AgentSpecFlow,
  AgentSpecNode,
  AgentSpecEdge,
  AgentSpecTool,
  AgentSpecLlmConfig,
} from './types.js';
import {
  OPERATION_TO_NODE_TYPE,
  STEP_TYPE_TO_TOOL_TYPE,
  jsonSchemaToProperties,
} from './mapping.js';

// ============================================================================
// Export Options
// ============================================================================

export interface ExportOptions {
  /** Agent Spec version to emit (default: "26.1.0") */
  agentspecVersion?: string;
  /** Whether to include _phoenix extension metadata for round-trip fidelity */
  includePhoenixMetadata?: boolean;
}

// ============================================================================
// Export Result
// ============================================================================

export interface ExportResult {
  /** The exported Agent Spec component */
  component: AgentSpecComponent;
  /** Warnings about lossy fields that couldn't be exported */
  warnings: string[];
}

// ============================================================================
// Helpers for exactOptionalPropertyTypes compliance
// ============================================================================

/** Only include a key if the value is defined (avoids assigning undefined to optional props). */
function optField<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  if (value === undefined) return {};
  return { [key]: value } as Record<K, V>;
}

// ============================================================================
// Main Export Function
// ============================================================================

/**
 * Export a Phoenix AgentDefinition to an Agent Spec component.
 *
 * Decision logic:
 * - If the flow has a single `ai.agent.turn` step as start with tool steps,
 *   export as an Agent Spec Agent component.
 * - Otherwise, export as an Agent Spec Flow component.
 */
export function exportToAgentSpec(flow: AgentDefinition, options?: ExportOptions): ExportResult {
  const warnings: string[] = [];
  const version = options?.agentspecVersion ?? '26.1.0';
  const includePhoenix = options?.includePhoenixMetadata !== false;

  // Check if this is a simple agent pattern (single agent turn + tools)
  const startStep = flow.steps.find((s) => s.stepId === flow.startStepId);
  if (startStep?.operation === 'ai.agent.turn') {
    const toolSteps = findToolSteps(flow, startStep);
    if (toolSteps.length > 0 || flow.steps.length <= 2) {
      return exportAsAgent(flow, startStep, toolSteps, version, includePhoenix, warnings);
    }
  }

  return exportAsFlow(flow, version, includePhoenix, warnings);
}

// ============================================================================
// Export as Agent
// ============================================================================

function exportAsAgent(
  flow: AgentDefinition,
  agentStep: StepDefinition,
  toolSteps: StepDefinition[],
  version: string,
  includePhoenix: boolean,
  warnings: string[],
): ExportResult {
  const config = agentStep.config ?? {};
  const tools: AgentSpecTool[] = toolSteps.map((step) => exportToolFromStep(step, warnings));

  const agent: AgentSpecAgent = {
    component_type: 'Agent',
    agentspec_version: version,
    id: String(flow.flowId),
    name: flow.metadata.name,
    ...optField('description', flow.metadata.description),
    ...optField('system_prompt', config['systemPrompt'] as string | undefined),
    ...(tools.length > 0 ? { tools } : {}),
    inputs: [],
    outputs: [],
    metadata: includePhoenix
      ? {
          _phoenix: {
            flowId: flow.flowId,
            version: flow.version,
            operationId: agentStep.operation,
            stepType: agentStep.stepType,
            ...(config['agentRole'] ? { agentRole: config['agentRole'] } : {}),
            ...(config['turnPolicy'] ? { turnPolicy: config['turnPolicy'] } : {}),
          },
        }
      : {},
  };

  // LLM config
  if (config['model']) {
    const llmConfig: AgentSpecLlmConfig = {
      component_type: 'OpenAiCompatibleConfig',
      id: `llm.${flow.flowId}`,
      name: 'llm-config',
      model_id: config['model'] as string,
    };
    if (config['temperature'] !== undefined) {
      llmConfig.temperature = config['temperature'] as number;
    }
    if (config['maxTokens'] !== undefined) {
      llmConfig.max_tokens = config['maxTokens'] as number;
    }
    agent.llm_config = llmConfig;
  }

  // Input/output from state variables
  if (flow.inputSchema) {
    agent.inputs = jsonSchemaToProperties(flow.inputSchema);
  }
  if (flow.outputSchema) {
    agent.outputs = jsonSchemaToProperties(flow.outputSchema);
  }

  // Track lossy fields
  if (config['agentRole']) warnings.push('agentRole has no Agent Spec equivalent');
  if (config['turnPolicy']) warnings.push('turnPolicy/budgetHints have no Agent Spec equivalent');
  if (config['contextProfile']) warnings.push('contextProfile has no Agent Spec equivalent');
  if (config['historyPolicy']) warnings.push('historyPolicy has no Agent Spec equivalent');
  if (agentStep.retryPolicy) warnings.push('retryPolicy has no Agent Spec equivalent');
  if (agentStep.timeout) warnings.push('timeout has no Agent Spec equivalent');

  return { component: agent, warnings };
}

// ============================================================================
// Export as Flow
// ============================================================================

function exportAsFlow(
  flow: AgentDefinition,
  version: string,
  includePhoenix: boolean,
  warnings: string[],
): ExportResult {
  const nodes: AgentSpecNode[] = [];
  const edges: AgentSpecEdge[] = [];
  const stepIdToNodeId = new Map<string, string>();

  // Add StartNode
  const startNodeId = `start-${flow.startStepId}`;
  nodes.push({
    component_type: 'StartNode',
    id: startNodeId,
    name: 'Start',
  });

  // Convert steps to nodes
  for (const step of flow.steps) {
    const nodeId = String(step.stepId);
    stepIdToNodeId.set(step.stepId, nodeId);
    const node = exportStepToNode(step, includePhoenix, warnings);
    nodes.push(node);
  }

  // Add edge from start to first step
  edges.push({
    component_type: 'ControlFlowEdge',
    source_node: startNodeId,
    target_node: String(flow.startStepId),
  });

  // Convert onSuccess/onFailure to edges
  let endNodeNeeded = false;
  for (const step of flow.steps) {
    const isTerminal = step.onSuccess.next.length === 0;
    if (isTerminal) {
      endNodeNeeded = true;
    }

    for (const edge of step.onSuccess.next) {
      if (edge.stepId === null) {
        endNodeNeeded = true;
        continue;
      }
      edges.push({
        component_type: 'ControlFlowEdge',
        source_node: String(step.stepId),
        target_node: String(edge.stepId),
        ...optField('from_branch', edge.when ? edge.when : undefined),
      });
    }

    for (const edge of step.onFailure.next) {
      if (edge.stepId === null) continue;
      edges.push({
        component_type: 'ControlFlowEdge',
        source_node: String(step.stepId),
        target_node: String(edge.stepId),
        from_branch: 'error',
      });
    }
  }

  // Add EndNode if needed
  if (endNodeNeeded) {
    const endNodeId = 'end';
    nodes.push({
      component_type: 'EndNode',
      id: endNodeId,
      name: 'End',
    });

    // Link terminal steps to EndNode
    for (const step of flow.steps) {
      if (step.onSuccess.next.length === 0) {
        edges.push({
          component_type: 'ControlFlowEdge',
          source_node: String(step.stepId),
          target_node: endNodeId,
        });
      }
    }
  }

  const flowComponent: AgentSpecFlow = {
    component_type: 'Flow',
    agentspec_version: version,
    id: String(flow.flowId),
    name: flow.metadata.name,
    ...optField('description', flow.metadata.description),
    nodes,
    edges,
    metadata: includePhoenix
      ? {
          _phoenix: {
            flowId: flow.flowId,
            version: flow.version,
            supportedModes: flow.supportedModes,
          },
        }
      : {},
  };

  // Input/output
  if (flow.inputSchema) {
    flowComponent.inputs = jsonSchemaToProperties(flow.inputSchema);
  }
  if (flow.outputSchema) {
    flowComponent.outputs = jsonSchemaToProperties(flow.outputSchema);
  }

  return { component: flowComponent, warnings };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find tool steps connected to an agent step via onSuccess edges.
 * A tool step is one where the agent's onSuccess points to it AND
 * it points back to the agent.
 */
function findToolSteps(flow: AgentDefinition, agentStep: StepDefinition): StepDefinition[] {
  const toolStepIds = new Set(agentStep.onSuccess.next.map((e) => e.stepId).filter(Boolean));
  return flow.steps.filter(
    (s) =>
      toolStepIds.has(s.stepId) && s.stepId !== agentStep.stepId && s.operation !== 'ai.agent.turn',
  );
}

function exportStepToNode(
  step: StepDefinition,
  includePhoenix: boolean,
  warnings: string[],
): AgentSpecNode {
  const nodeType = OPERATION_TO_NODE_TYPE[step.operation] ?? 'ToolNode';
  const config = step.config ?? {};

  const base = {
    id: String(step.stepId),
    name: step.name ?? String(step.stepId),
    ...optField('description', step.description),
    metadata: includePhoenix
      ? {
          _phoenix: {
            operationId: step.operation,
            stepType: step.stepType,
          },
        }
      : {},
  };

  switch (nodeType) {
    case 'AgentNode':
      return {
        ...base,
        component_type: 'AgentNode',
        agent: {
          component_type: 'Agent',
          id: `agent.${step.stepId}`,
          name: step.name ?? String(step.stepId),
          ...optField('system_prompt', config['systemPrompt'] as string | undefined),
          ...optField(
            'llm_config',
            config['model']
              ? ({
                  component_type: 'OpenAiCompatibleConfig',
                  id: `llm.${step.stepId}`,
                  name: 'llm-config',
                  model_id: config['model'] as string,
                } as AgentSpecLlmConfig)
              : undefined,
          ),
        },
      };

    case 'LlmNode':
      return {
        ...base,
        component_type: 'LlmNode',
        ...optField('prompt', config['prompt'] as string | undefined),
        ...optField('system_prompt', config['systemPrompt'] as string | undefined),
        ...optField(
          'llm_config',
          config['model']
            ? ({
                component_type: 'OpenAiCompatibleConfig',
                id: `llm.${step.stepId}`,
                name: 'llm-config',
                model_id: config['model'] as string,
              } as AgentSpecLlmConfig)
            : undefined,
        ),
      };

    case 'ApiNode':
      return {
        ...base,
        component_type: 'ApiNode',
        url: (config['url'] as string) ?? '',
        ...optField('method', config['method'] as string | undefined),
        ...optField('headers', config['headers'] as Record<string, string> | undefined),
      };

    default:
      return {
        ...base,
        component_type: 'ToolNode',
        tool: exportToolFromStep(step, warnings),
      };
  }
}

function exportToolFromStep(step: StepDefinition, _warnings: string[]): AgentSpecTool {
  const config = step.config ?? {};
  const toolType = STEP_TYPE_TO_TOOL_TYPE[step.stepType] ?? 'ServerTool';

  const tool: AgentSpecTool = {
    component_type: toolType as 'ServerTool',
    id: `tool.${step.stepId}`,
    name: step.name ?? String(step.stepId),
    ...optField('description', step.description),
  };

  // Convert input schema to Property[]
  const inputSchema = config['inputSchema'] as Record<string, unknown> | undefined;
  if (inputSchema) {
    tool.inputs = jsonSchemaToProperties(inputSchema);
  }

  // Output schema
  const outputSchema = config['outputSchema'] as Record<string, unknown> | undefined;
  if (outputSchema) {
    tool.outputs = jsonSchemaToProperties(outputSchema);
  }

  if (config['opTaskOnly']) {
    tool.requires_confirmation = true;
  }

  return tool;
}
