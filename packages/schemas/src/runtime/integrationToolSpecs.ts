import type { ApiEndpoint } from '../models/apiDefinition.js';
import type { McpCachedTool } from '../models/mcpServerDefinition.js';
import type { AgentToolSpec } from './agentTurn.js';
import { buildVirtualToolSpec } from './agentTurn.js';
import { estimateStringTokens } from './tokenEstimate.js';

/**
 * The tools a bound integration contributes to an agent's surface.
 *
 * Shared rather than owned by the turn assembler because the operator surface
 * has to quote what pinning a connection costs per turn, and that cost is the
 * cost of these exact emitted specs. A second derivation of the name,
 * description or schema would drift from what goes on the wire — the one number
 * such a control exists to show.
 */

/**
 * The JSON Schema for an endpoint's request body, or undefined when it declares
 * none.
 *
 * ONE derivation, because two of them drift: the tool schema tells the model
 * which fields are required and the call-time validator decides whether a body
 * may leave the box, and a validator that understood fewer shapes than the
 * schema advertised let a raw caller send a body the model would have been
 * refused for.
 *
 * One body parameter is the body whatever its schema says — that has always
 * been the reading, and an endpoint declaring a single opaque body relies on
 * it. Several parameters are unambiguously fields OF one body.
 */
export function deriveEndpointBodySchema(
  endpoint: ApiEndpoint,
): Record<string, unknown> | undefined {
  const bodyParams = endpoint.params.filter((param) => param.location === 'body');
  if (bodyParams.length === 0) return undefined;

  if (bodyParams.length === 1) {
    const only = bodyParams[0];
    const schema: Record<string, unknown> = { ...(only?.schema ?? { type: 'object' }) };
    // The body's prose `description` would otherwise be dropped (the schema
    // replaces it). Carry it onto the schema when the schema omits its own.
    if (only?.description && schema['description'] === undefined) {
      schema['description'] = only.description;
    }
    return schema;
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of bodyParams) {
    const fieldSchema: Record<string, unknown> = param.schema
      ? { ...param.schema }
      : { type: 'string' };
    if (param.description && fieldSchema['description'] === undefined) {
      fieldSchema['description'] = param.description;
    }
    properties[param.name] = fieldSchema;
    if (param.required) required.push(param.name);
  }
  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

export function deriveEndpointToolSchema(endpoint: ApiEndpoint): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const bodySchema = deriveEndpointBodySchema(endpoint);
  if (bodySchema) properties['body'] = bodySchema;

  // `required` follows declaration order, and names the body ONCE however many
  // parameters compose it — repeating it is what draft 2020-12 rejects.
  let bodyRequiredNamed = false;
  for (const param of endpoint.params) {
    if (param.location === 'body') {
      // Required when any field is: a body the model may omit entirely cannot
      // carry a field the endpoint demands.
      if (param.required && !bodyRequiredNamed) {
        required.push('body');
        bodyRequiredNamed = true;
      }
      continue;
    }

    // path, query, header
    const propSchema: Record<string, unknown> = param.schema
      ? { ...param.schema }
      : { type: 'string' };
    if (param.description) propSchema['description'] = param.description;
    properties[param.name] = propSchema;

    // Path params are always required regardless of param.required
    if (param.location === 'path' || param.required) {
      required.push(param.name);
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
  };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

/**
 * Map an API endpoint to an AgentToolSpec virtual tool.
 *
 * toolId format: `api:{apiId}/{endpointId}`  (e.g., `api:stripe/charges.create`)
 * callName format: `{apiId}.{endpointId}`  (e.g., `stripe.charges.create`)
 */
export function mapApiEndpointToToolSpec(
  apiId: string,
  apiName: string,
  endpoint: ApiEndpoint,
): AgentToolSpec {
  const toolId = `api:${apiId}/${endpoint.endpointId}`;
  const callName = `${apiId}.${endpoint.endpointId}`;

  return buildVirtualToolSpec({
    operationId: toolId,
    stepType: 'api',
    name: endpoint.name || `${apiId}.${endpoint.endpointId}`,
    description: endpoint.description || `${endpoint.method} ${endpoint.pathTemplate} (${apiName})`,
    inputSchema: deriveEndpointToolSchema(endpoint),
    source: 'api',
    lowering: 'api_call',
    callName,
    apiMeta: {
      apiId,
      endpointId: endpoint.endpointId,
    },
  });
}

export function mapMcpToolToToolSpec(
  serverId: string,
  serverName: string,
  tool: McpCachedTool,
  opTaskOnly = false,
  bindingId?: string,
  /**
   * Set when the server runs on the operator's machine. The tool is otherwise
   * identical — same name, same schema, same surface — and only where the call
   * is lowered differs, which is a fact about the server rather than the tool.
   */
  hostBindingId?: string,
): AgentToolSpec {
  const toolId = hostBindingId
    ? `mcp:host-${hostBindingId}-${serverId}/${tool.name}`
    : bindingId
      ? `mcp:${bindingId}/${tool.name}`
      : `mcp:${serverId}/${tool.name}`;
  // Qualified by the folder as well as the server. Two connected folders can
  // each offer a server called `sqlite` — a monorepo and a side project, say —
  // and an unqualified name would leave one shadowing the other with nothing to
  // show a tool had gone missing. The `local_` prefix additionally keeps a
  // local `sqlite` distinct from a hosted one.
  const callName = hostBindingId
    ? `local_${hostBindingId}_${serverId}.${tool.name}`
    : `mcp_${serverId}.${tool.name}`;

  const mcpMeta: {
    serverId: string;
    toolName: string;
    bindingId?: string;
    hostBindingId?: string;
  } = {
    serverId,
    toolName: tool.name,
  };
  if (bindingId) mcpMeta.bindingId = bindingId;
  if (hostBindingId) mcpMeta.hostBindingId = hostBindingId;

  const spec = buildVirtualToolSpec({
    operationId: toolId,
    stepType: 'mcp',
    name: tool.name,
    description: tool.description || `MCP tool from ${serverName}`,
    inputSchema: tool.inputSchema ?? {
      type: 'object',
    },
    source: 'mcp',
    lowering: 'mcp_call',
    callName,
    mcpMeta,
  });
  if (opTaskOnly) {
    spec.governance = { sideEffects: true, opTaskOnly: true };
  }
  return spec;
}

/**
 * What these tools cost the model on every turn they are pinned.
 *
 * Taken over the declaration the surface actually sends —
 * `{name, description, input_schema}`, addressed by call name — so the figure an
 * operator is shown before choosing `always_on` is the figure they then pay.
 */
/**
 * The identifier a directive's `pinnedToolNames` matches a spec on — the
 * endpoint id for an API, the tool name for MCP. Derived from the spec's own
 * meta rather than re-parsed out of `toolId`, so the selector an operator
 * stores is by construction the one the pinned-tier mappers filter against.
 */
export function pinnedToolNameOf(spec: AgentToolSpec): string | undefined {
  return spec.apiMeta?.endpointId ?? spec.mcpMeta?.toolName;
}

/** Per-turn cost of one spec, so a UI can price a subset the same way. */
export function estimatePinnedToolTokensFor(spec: AgentToolSpec): number {
  return estimateStringTokens(
    JSON.stringify({
      name: spec.callName ?? spec.toolId,
      description: spec.description,
      input_schema: spec.inputSchema,
    }),
  );
}

export function estimatePinnedToolTokens(specs: readonly AgentToolSpec[]): number {
  return specs.reduce((sum, spec) => sum + estimatePinnedToolTokensFor(spec), 0);
}
