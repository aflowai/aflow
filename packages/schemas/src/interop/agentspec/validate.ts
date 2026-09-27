import {
  AGENT_SPEC_COMPONENT_TYPES,
  type AgentSpecComponent,
  type AgentSpecAgent,
  type AgentSpecFlow,
} from './types.js';

// ============================================================================
// Validation Result
// ============================================================================

export interface AgentSpecValidationError {
  path: string;
  message: string;
}

export type AgentSpecValidationResult<T> =
  { ok: true; value: T } | { ok: false; errors: AgentSpecValidationError[] };

// ============================================================================
// Validators
// ============================================================================

/**
 * Validate raw JSON as an Agent Spec component.
 * Returns either the typed component or a list of validation errors.
 */
export function validateAgentSpec(json: unknown): AgentSpecValidationResult<AgentSpecComponent> {
  const errors: AgentSpecValidationError[] = [];

  if (typeof json !== 'object' || json === null) {
    return { ok: false, errors: [{ path: '$', message: 'Expected an object' }] };
  }

  const obj = json as Record<string, unknown>;

  // component_type is required
  if (typeof obj['component_type'] !== 'string') {
    errors.push({
      path: '$.component_type',
      message: 'Required field "component_type" must be a string',
    });
    return { ok: false, errors };
  }

  const componentType = obj['component_type'];

  // Check if it's a known top-level component type
  const topLevelTypes = ['Agent', 'Flow', 'Swarm', 'ManagerWorkers'] as const;
  if (!topLevelTypes.includes(componentType as (typeof topLevelTypes)[number])) {
    // Still accept if it's a known component type (might be a tool, node, etc.)
    if (!(AGENT_SPEC_COMPONENT_TYPES as readonly string[]).includes(componentType)) {
      errors.push({
        path: '$.component_type',
        message: `Unknown component_type "${componentType}". Expected one of: ${topLevelTypes.join(', ')}`,
      });
    } else {
      errors.push({
        path: '$.component_type',
        message: `"${componentType}" is not a top-level runnable component. Expected: ${topLevelTypes.join(', ')}`,
      });
    }
  }

  // Validate common fields
  if (typeof obj['id'] !== 'string' || obj['id'].length === 0) {
    errors.push({ path: '$.id', message: 'Required field "id" must be a non-empty string' });
  }

  if (typeof obj['name'] !== 'string' || obj['name'].length === 0) {
    errors.push({ path: '$.name', message: 'Required field "name" must be a non-empty string' });
  }

  // Type-specific validation
  if (errors.length === 0) {
    switch (componentType) {
      case 'Agent':
        validateAgent(obj, errors);
        break;
      case 'Flow':
        validateFlow(obj, errors);
        break;
      case 'Swarm':
        validateSwarm(obj, errors);
        break;
      case 'ManagerWorkers':
        validateManagerWorkers(obj, errors);
        break;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: json as AgentSpecComponent };
}

// ============================================================================
// Type-Specific Validators
// ============================================================================

function validateAgent(obj: Record<string, unknown>, errors: AgentSpecValidationError[]): void {
  // system_prompt is optional but should be string if present
  if (obj['system_prompt'] !== undefined && typeof obj['system_prompt'] !== 'string') {
    errors.push({ path: '$.system_prompt', message: 'system_prompt must be a string' });
  }

  // llm_config is optional but should be an object if present
  if (obj['llm_config'] !== undefined) {
    if (typeof obj['llm_config'] !== 'object' || obj['llm_config'] === null) {
      errors.push({ path: '$.llm_config', message: 'llm_config must be an object' });
    } else {
      validateLlmConfig(obj['llm_config'] as Record<string, unknown>, errors);
    }
  }

  // tools is optional but should be an array if present
  if (obj['tools'] !== undefined) {
    if (!Array.isArray(obj['tools'])) {
      errors.push({ path: '$.tools', message: 'tools must be an array' });
    } else {
      for (let i = 0; i < obj['tools'].length; i++) {
        const tool = obj['tools'][i] as Record<string, unknown> | undefined;
        if (typeof tool !== 'object' || tool === null) {
          errors.push({ path: `$.tools[${String(i)}]`, message: 'Each tool must be an object' });
        } else {
          validateTool(tool, `$.tools[${String(i)}]`, errors);
        }
      }
    }
  }
}

function validateFlow(obj: Record<string, unknown>, errors: AgentSpecValidationError[]): void {
  // nodes is required
  if (!Array.isArray(obj['nodes'])) {
    errors.push({ path: '$.nodes', message: 'Required field "nodes" must be an array' });
  } else {
    for (let i = 0; i < obj['nodes'].length; i++) {
      const node = obj['nodes'][i] as Record<string, unknown> | undefined;
      if (typeof node !== 'object' || node === null) {
        errors.push({ path: `$.nodes[${String(i)}]`, message: 'Each node must be an object' });
      } else if (typeof node['component_type'] !== 'string') {
        errors.push({
          path: `$.nodes[${String(i)}].component_type`,
          message: 'Each node must have a component_type string',
        });
      }
    }
  }

  // edges is required
  if (!Array.isArray(obj['edges'])) {
    errors.push({ path: '$.edges', message: 'Required field "edges" must be an array' });
  } else {
    for (let i = 0; i < obj['edges'].length; i++) {
      const edge = obj['edges'][i] as Record<string, unknown> | undefined;
      if (typeof edge !== 'object' || edge === null) {
        errors.push({ path: `$.edges[${String(i)}]`, message: 'Each edge must be an object' });
      }
    }
  }
}

function validateSwarm(obj: Record<string, unknown>, errors: AgentSpecValidationError[]): void {
  if (!Array.isArray(obj['members'])) {
    errors.push({ path: '$.members', message: 'Required field "members" must be an array' });
  }
}

function validateManagerWorkers(
  obj: Record<string, unknown>,
  errors: AgentSpecValidationError[],
): void {
  if (typeof obj['manager'] !== 'object' || obj['manager'] === null) {
    errors.push({ path: '$.manager', message: 'Required field "manager" must be an object' });
  }
  if (!Array.isArray(obj['workers'])) {
    errors.push({ path: '$.workers', message: 'Required field "workers" must be an array' });
  }
}

function validateLlmConfig(obj: Record<string, unknown>, errors: AgentSpecValidationError[]): void {
  if (typeof obj['model_id'] !== 'string') {
    errors.push({ path: '$.llm_config.model_id', message: 'llm_config.model_id must be a string' });
  }
}

function validateTool(
  obj: Record<string, unknown>,
  path: string,
  errors: AgentSpecValidationError[],
): void {
  const toolTypes = ['ServerTool', 'ClientTool', 'RemoteTool', 'MCPTool'];
  if (typeof obj['component_type'] !== 'string' || !toolTypes.includes(obj['component_type'])) {
    errors.push({
      path: `${path}.component_type`,
      message: `Tool component_type must be one of: ${toolTypes.join(', ')}`,
    });
  }

  if (obj['inputs'] !== undefined && !Array.isArray(obj['inputs'])) {
    errors.push({ path: `${path}.inputs`, message: 'Tool inputs must be an array' });
  }

  if (obj['outputs'] !== undefined && !Array.isArray(obj['outputs'])) {
    errors.push({ path: `${path}.outputs`, message: 'Tool outputs must be an array' });
  }
}

/**
 * Extract the Agent Spec version from a component.
 */
export function extractVersion(component: AgentSpecComponent): string {
  return component.agentspec_version ?? 'unknown';
}

/**
 * Check if a component is an Agent.
 */
export function isAgentComponent(component: AgentSpecComponent): component is AgentSpecAgent {
  return component.component_type === 'Agent';
}

/**
 * Check if a component is a Flow.
 */
export function isFlowComponent(component: AgentSpecComponent): component is AgentSpecFlow {
  return component.component_type === 'Flow';
}
