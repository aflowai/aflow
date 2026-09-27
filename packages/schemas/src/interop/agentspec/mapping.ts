import type { AgentSpecProperty } from './types.js';

// ============================================================================
// Node Type ↔ Operation ID Mapping
// ============================================================================

/**
 * Maps Agent Spec node component_type to Phoenix operation ID.
 */
export const NODE_TYPE_TO_OPERATION: Record<string, string> = {
  ToolNode: 'api.http.call', // Generic — refined by tool type
  LlmNode: 'ai.text.generate',
  AgentNode: 'ai.agent.turn',
  ApiNode: 'api.http.call',
};

/**
 * Maps Agent Spec tool component_type to Phoenix operation ID.
 */
export const TOOL_TYPE_TO_OPERATION: Record<string, string> = {
  ServerTool: 'api.http.call',
  ClientTool: 'user.approval.request',
  RemoteTool: 'api.http.call',
  MCPTool: 'mcp.tool.call',
};

/**
 * Maps Phoenix operation ID to Agent Spec node component_type (for export).
 */
export const OPERATION_TO_NODE_TYPE: Record<string, string> = {
  'ai.agent.turn': 'AgentNode',
  'ai.text.generate': 'LlmNode',
  'ai.text.generateJson': 'LlmNode',
  'ai.text.generateStream': 'LlmNode',
  'api.http.call': 'ApiNode',
  'user.request_input': 'ToolNode',
  'user.approval.request': 'ToolNode',
};

/**
 * Maps Phoenix step type to Agent Spec tool component_type (for export).
 */
export const STEP_TYPE_TO_TOOL_TYPE: Record<string, string> = {
  ai: 'ServerTool',
  api: 'ServerTool',
  memory: 'ServerTool',
  user: 'ClientTool',
  mcp: 'MCPTool',
};

// ============================================================================
// Property ↔ JSON Schema Conversion
// ============================================================================

/**
 * Convert Agent Spec Property[] to JSON Schema object.
 *
 * Agent Spec: `[{ title: "url", type: "string", description: "..." }]`
 * JSON Schema: `{ type: "object", properties: { url: { type: "string", description: "..." } } }`
 */
export function propertiesToJsonSchema(properties: AgentSpecProperty[]): Record<string, unknown> {
  const schemaProps: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const prop of properties) {
    const schemaProp: Record<string, unknown> = {
      type: prop.type,
    };
    if (prop.description) {
      schemaProp['description'] = prop.description;
    }
    if (prop.default !== undefined) {
      schemaProp['default'] = prop.default;
    }
    schemaProps[prop.title] = schemaProp;

    // Properties are required by default in Agent Spec
    if (prop.required !== false) {
      required.push(prop.title);
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties: schemaProps,
  };
  if (required.length > 0) {
    schema['required'] = required;
  }

  return schema;
}

/**
 * Convert JSON Schema object to Agent Spec Property[].
 *
 * Reverse of propertiesToJsonSchema. Handles the common case of
 * `{ type: "object", properties: { ... } }`.
 */
export function jsonSchemaToProperties(schema: Record<string, unknown>): AgentSpecProperty[] {
  const properties: AgentSpecProperty[] = [];
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!props) return properties;

  const required = new Set<string>(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );

  for (const [key, value] of Object.entries(props)) {
    const prop: AgentSpecProperty = {
      title: key,
      type: (value['type'] as string) ?? 'string',
    };
    if (value['description']) {
      prop.description = value['description'] as string;
    }
    if (value['default'] !== undefined) {
      prop.default = value['default'];
    }
    if (!required.has(key)) {
      prop.required = false;
    }
    properties.push(prop);
  }

  return properties;
}

// ============================================================================
// Step ID Generation
// ============================================================================

/**
 * Generate a Phoenix step ID from an Agent Spec node/tool.
 * Sanitizes to valid step ID format (alphanumeric + hyphens).
 */
export function toStepId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Generate a Phoenix step ID for a tool step.
 */
export function toToolStepId(toolName: string): string {
  return `tool-${toStepId(toolName)}`;
}
