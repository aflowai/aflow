// ============================================================================
// Base Component
// ============================================================================

/**
 * All Agent Spec objects share a `component_type` discriminator, a unique `id`,
 * a human-readable `name`, and optional metadata.
 */
export interface AgentSpecComponentBase {
  /** Discriminator field for component type */
  component_type: string;
  /** Unique component identifier (e.g., "agent.calc.v1") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Agent Spec version (e.g., "26.1.0") — defaults to latest if omitted */
  agentspec_version?: string;
}

// ============================================================================
// Property (Tool I/O schema)
// ============================================================================

/**
 * Describes a single input or output property for a tool.
 * Analogous to a JSON Schema property but simplified.
 */
export interface AgentSpecProperty {
  /** Property name (used as the key in I/O dictionaries) */
  title: string;
  /** JSON Schema-compatible type */
  type: string;
  /** Human-readable description */
  description?: string;
  /** Default value */
  default?: unknown;
  /** Whether the property is required (defaults to true for inputs) */
  required?: boolean;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface AgentSpecToolBase extends AgentSpecComponentBase {
  inputs?: AgentSpecProperty[];
  outputs?: AgentSpecProperty[];
  /** Whether execution requires human confirmation */
  requires_confirmation?: boolean;
}

/** Tool executed server-side in the same runtime */
export interface AgentSpecServerTool extends AgentSpecToolBase {
  component_type: 'ServerTool';
}

/** Tool executed client-side (OpenAI function-calling style) */
export interface AgentSpecClientTool extends AgentSpecToolBase {
  component_type: 'ClientTool';
}

/** Tool executed via external REST/RPC call */
export interface AgentSpecRemoteTool extends AgentSpecToolBase {
  component_type: 'RemoteTool';
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  sensitive_headers?: string[];
  api_spec_uri?: string;
}

/** Tool executed via MCP server */
export interface AgentSpecMCPTool extends AgentSpecToolBase {
  component_type: 'MCPTool';
  server_url?: string;
  tool_name?: string;
}

export type AgentSpecTool =
  AgentSpecServerTool | AgentSpecClientTool | AgentSpecRemoteTool | AgentSpecMCPTool;

// ============================================================================
// MCP Toolbox
// ============================================================================

export interface AgentSpecMCPToolBox extends AgentSpecComponentBase {
  component_type: 'MCPToolBox';
  client_transport: AgentSpecClientTransport;
  tool_filter?: Array<string | AgentSpecMCPToolSpec>;
}

export interface AgentSpecClientTransport extends AgentSpecComponentBase {
  url: string;
}

export interface AgentSpecMCPToolSpec {
  component_type: 'MCPToolSpec';
  id: string;
  name: string;
  requires_confirmation?: boolean;
}

// ============================================================================
// LLM Configuration
// ============================================================================

export interface AgentSpecLlmConfig extends AgentSpecComponentBase {
  component_type: 'OpenAiCompatibleConfig';
  /** LLM API endpoint URL */
  url?: string;
  /** Model identifier (e.g., "gpt-4o-mini") */
  model_id: string;
  /** API key (may be a $component_ref for sensitive field handling) */
  api_key?: string | AgentSpecComponentRef;
  /** Temperature for generation */
  temperature?: number;
  /** Max tokens to generate */
  max_tokens?: number;
  /** Top-p sampling */
  top_p?: number;
}

/**
 * Component reference for disaggregated configuration.
 * Used for sensitive fields like API keys.
 */
export interface AgentSpecComponentRef {
  $component_ref: string;
}

// ============================================================================
// Agent Component
// ============================================================================

/**
 * Top-level Agent component — a conversational agent (e.g., ReAct-style).
 */
export interface AgentSpecAgent extends AgentSpecComponentBase {
  component_type: 'Agent';
  /** System prompt for the agent */
  system_prompt?: string;
  /** LLM configuration */
  llm_config?: AgentSpecLlmConfig;
  /** Tools available to the agent */
  tools?: AgentSpecTool[];
  /** MCP toolboxes for dynamic tool discovery */
  toolbox?: AgentSpecMCPToolBox[];
  /** Whether the agent requires human-in-the-loop */
  human_in_the_loop?: boolean;
  /** Agent inputs (top-level parameters) */
  inputs?: AgentSpecProperty[];
  /** Agent outputs */
  outputs?: AgentSpecProperty[];
}

// ============================================================================
// Flow Nodes
// ============================================================================

export interface AgentSpecNodeBase extends AgentSpecComponentBase {
  /** Position in visual editor (optional) */
  position?: { x: number; y: number };
}

export interface AgentSpecStartNode extends AgentSpecNodeBase {
  component_type: 'StartNode';
}

export interface AgentSpecEndNode extends AgentSpecNodeBase {
  component_type: 'EndNode';
}

export interface AgentSpecToolNode extends AgentSpecNodeBase {
  component_type: 'ToolNode';
  tool: AgentSpecTool;
}

export interface AgentSpecLlmNode extends AgentSpecNodeBase {
  component_type: 'LlmNode';
  /** LLM configuration for this node */
  llm_config?: AgentSpecLlmConfig;
  /** Prompt template */
  prompt?: string;
  /** System prompt */
  system_prompt?: string;
}

export interface AgentSpecAgentNode extends AgentSpecNodeBase {
  component_type: 'AgentNode';
  /** Agent definition (inline or reference) */
  agent: AgentSpecAgent;
}

export interface AgentSpecApiNode extends AgentSpecNodeBase {
  component_type: 'ApiNode';
  url: string;
  method?: string;
  headers?: Record<string, string>;
  sensitive_headers?: string[];
  body?: unknown;
  params?: Record<string, string>;
}

export interface AgentSpecBranchingNode extends AgentSpecNodeBase {
  component_type: 'BranchingNode';
  /** Branches with conditions */
  branches?: Array<{
    name: string;
    condition?: string;
  }>;
}

export interface AgentSpecMapNode extends AgentSpecNodeBase {
  component_type: 'MapNode';
  /** Source to iterate over */
  source?: string;
  /** Node to execute for each item */
  body?: AgentSpecNode;
}

export type AgentSpecNode =
  | AgentSpecStartNode
  | AgentSpecEndNode
  | AgentSpecToolNode
  | AgentSpecLlmNode
  | AgentSpecAgentNode
  | AgentSpecApiNode
  | AgentSpecBranchingNode
  | AgentSpecMapNode;

// ============================================================================
// Flow Edges
// ============================================================================

/** Control flow edge — determines execution order */
export interface AgentSpecControlFlowEdge {
  component_type: 'ControlFlowEdge';
  /** Source node ID */
  source_node: string;
  /** Target node ID */
  target_node: string;
  /** Branch name (for BranchingNode) — e.g., "next", "error", "true", "false" */
  from_branch?: string;
}

/** Data flow edge — maps outputs to inputs between nodes */
export interface AgentSpecDataFlowEdge {
  component_type: 'DataFlowEdge';
  /** Source node ID */
  source_node: string;
  /** Output name from source */
  source_output: string;
  /** Target node ID */
  destination_node: string;
  /** Input name on target */
  destination_input: string;
}

export type AgentSpecEdge = AgentSpecControlFlowEdge | AgentSpecDataFlowEdge;

// ============================================================================
// Flow Component
// ============================================================================

/**
 * Flow component — a structured workflow with nodes and edges.
 */
export interface AgentSpecFlow extends AgentSpecComponentBase {
  component_type: 'Flow';
  /** Nodes in the flow */
  nodes: AgentSpecNode[];
  /** Edges connecting nodes (control flow and data flow) */
  edges: AgentSpecEdge[];
  /** Flow-level inputs */
  inputs?: AgentSpecProperty[];
  /** Flow-level outputs */
  outputs?: AgentSpecProperty[];
}

// ============================================================================
// Multi-Agent Patterns
// ============================================================================

/** Swarm — relationship graph of agents with handoff semantics */
export interface AgentSpecSwarm extends AgentSpecComponentBase {
  component_type: 'Swarm';
  /** Members of the swarm */
  members: AgentSpecAgent[];
  /** Handoff mode */
  handoff_mode?: 'round_robin' | 'random' | 'conditional';
}

/** ManagerWorkers — hierarchical agent pattern */
export interface AgentSpecManagerWorkers extends AgentSpecComponentBase {
  component_type: 'ManagerWorkers';
  /** Manager agent */
  manager: AgentSpecAgent;
  /** Worker agents */
  workers: AgentSpecAgent[];
}

// ============================================================================
// Union Type for All Components
// ============================================================================

export type AgentSpecComponent =
  AgentSpecAgent | AgentSpecFlow | AgentSpecSwarm | AgentSpecManagerWorkers;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a value is a $component_ref (disaggregated configuration).
 */
export function isComponentRef(value: unknown): value is AgentSpecComponentRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$component_ref' in value &&
    typeof (value as Record<string, unknown>)['$component_ref'] === 'string'
  );
}

/**
 * Known component_type discriminator values for quick lookup.
 */
export const AGENT_SPEC_COMPONENT_TYPES = [
  'Agent',
  'Flow',
  'Swarm',
  'ManagerWorkers',
  'ServerTool',
  'ClientTool',
  'RemoteTool',
  'MCPTool',
  'MCPToolBox',
  'OpenAiCompatibleConfig',
  'StartNode',
  'EndNode',
  'ToolNode',
  'LlmNode',
  'AgentNode',
  'ApiNode',
  'BranchingNode',
  'MapNode',
  'ControlFlowEdge',
  'DataFlowEdge',
] as const;
