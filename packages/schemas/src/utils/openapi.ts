/**
 * Utilities for generating OpenAPI specifications from Zod schemas.
 */
import { type z } from 'zod';
import { type JsonSchema, toJsonSchema } from './jsonSchema.js';

// ============================================================================
// OpenAPI Types
// ============================================================================

/**
 * OpenAPI 3.1 specification subset.
 */
export interface OpenAPISpec {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: {
      name?: string;
      email?: string;
      url?: string;
    };
    license?: {
      name: string;
      url?: string;
    };
  };
  servers?: Array<{
    url: string;
    description?: string;
  }>;
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, SecurityScheme>;
    parameters?: Record<string, Parameter>;
    responses?: Record<string, Response>;
  };
  security?: Array<Record<string, string[]>>;
  tags?: Array<{
    name: string;
    description?: string;
  }>;
}

export interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
  options?: Operation;
  head?: Operation;
  trace?: Operation;
  parameters?: Parameter[];
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

export interface Parameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: JsonSchema;
  deprecated?: boolean;
}

export interface RequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, MediaType>;
}

export interface Response {
  description: string;
  content?: Record<string, MediaType>;
  headers?: Record<string, { schema: JsonSchema; description?: string }>;
}

export interface MediaType {
  schema?: JsonSchema;
  example?: unknown;
  examples?: Record<string, { value: unknown; summary?: string }>;
}

export interface SecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
}

// ============================================================================
// Endpoint Definition
// ============================================================================

/**
 * Definition of an API endpoint for OpenAPI generation.
 */
export interface EndpointDefinition {
  /** HTTP method */
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** URL path (with path parameters like /runs/{runId}) */
  path: string;
  /** Operation ID for code generation */
  operationId: string;
  /** Summary for documentation */
  summary: string;
  /** Detailed description */
  description?: string;
  /** Tags for grouping */
  tags?: string[];
  /** Path parameters */
  pathParams?: Array<{
    name: string;
    schema: z.ZodType;
    description?: string;
  }>;
  /** Query parameters */
  queryParams?: Array<{
    name: string;
    schema: z.ZodType;
    required?: boolean;
    description?: string;
  }>;
  /** Request body schema */
  requestBody?: {
    schema: z.ZodType;
    description?: string;
    required?: boolean;
  };
  /** Response schemas by status code */
  responses: Record<
    number,
    {
      schema?: z.ZodType;
      description: string;
    }
  >;
  /** Whether endpoint is deprecated */
  deprecated?: boolean;
}

// ============================================================================
// OpenAPI Generation
// ============================================================================

/**
 * Options for OpenAPI generation.
 */
export interface ToOpenApiOptions {
  /** API title */
  title: string;
  /** API version */
  version: string;
  /** API description */
  description?: string;
  /** Server URLs */
  servers?: Array<{ url: string; description?: string }>;
  /** Security schemes */
  securitySchemes?: Record<string, SecurityScheme>;
  /** Default security requirements */
  security?: Array<Record<string, string[]>>;
}

/**
 * Generate an OpenAPI 3.1 specification from endpoint definitions.
 */
export async function toOpenApiSpec(
  endpoints: EndpointDefinition[],
  options: ToOpenApiOptions,
): Promise<OpenAPISpec> {
  const paths: Record<string, PathItem> = {};
  const schemas: Record<string, JsonSchema> = {};

  // Process each endpoint
  for (const endpoint of endpoints) {
    const pathItem = paths[endpoint.path] ?? {};
    const operation = await buildOperation(endpoint, schemas);
    pathItem[endpoint.method] = operation;
    paths[endpoint.path] = pathItem;
  }

  // Build info object, only adding optional fields if defined
  const info: OpenAPISpec['info'] = {
    title: options.title,
    version: options.version,
  };
  if (options.description !== undefined) {
    info.description = options.description;
  }

  // Build components object, only adding optional fields if defined
  const components: OpenAPISpec['components'] = {};
  if (Object.keys(schemas).length > 0) {
    components.schemas = schemas;
  }
  if (options.securitySchemes !== undefined) {
    components.securitySchemes = options.securitySchemes;
  }

  const spec: OpenAPISpec = {
    openapi: '3.1.0',
    info,
    paths,
  };

  if (options.servers !== undefined) {
    spec.servers = options.servers;
  }
  if (Object.keys(components).length > 0) {
    spec.components = components;
  }
  if (options.security !== undefined) {
    spec.security = options.security;
  }

  return spec;
}

/**
 * Build an OpenAPI operation from an endpoint definition.
 */
async function buildOperation(
  endpoint: EndpointDefinition,
  schemas: Record<string, JsonSchema>,
): Promise<Operation> {
  const operation: Operation = {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    responses: {},
  };

  // Only add optional fields if they are defined
  if (endpoint.description !== undefined) {
    operation.description = endpoint.description;
  }
  if (endpoint.tags !== undefined) {
    operation.tags = endpoint.tags;
  }
  if (endpoint.deprecated !== undefined) {
    operation.deprecated = endpoint.deprecated;
  }

  // Build parameters
  const parameters: Parameter[] = [];

  // Path parameters
  if (endpoint.pathParams) {
    for (const param of endpoint.pathParams) {
      const schema = await toJsonSchema(param.schema);
      const parameter: Parameter = {
        name: param.name,
        in: 'path',
        required: true,
        schema,
      };
      if (param.description !== undefined) {
        parameter.description = param.description;
      }
      parameters.push(parameter);
    }
  }

  // Query parameters
  if (endpoint.queryParams) {
    for (const param of endpoint.queryParams) {
      const schema = await toJsonSchema(param.schema);
      const parameter: Parameter = {
        name: param.name,
        in: 'query',
        required: param.required ?? false,
        schema,
      };
      if (param.description !== undefined) {
        parameter.description = param.description;
      }
      parameters.push(parameter);
    }
  }

  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  // Request body
  if (endpoint.requestBody) {
    const schema = await toJsonSchema(endpoint.requestBody.schema);
    const schemaName = `${endpoint.operationId}Request`;
    schemas[schemaName] = schema;

    const requestBody: RequestBody = {
      required: endpoint.requestBody.required ?? true,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
    if (endpoint.requestBody.description !== undefined) {
      requestBody.description = endpoint.requestBody.description;
    }
    operation.requestBody = requestBody;
  }

  // Responses
  for (const [status, response] of Object.entries(endpoint.responses)) {
    const statusCode = status;
    const responseSchema = response.schema ? await toJsonSchema(response.schema) : undefined;

    if (responseSchema) {
      const schemaName = `${endpoint.operationId}Response${statusCode}`;
      schemas[schemaName] = responseSchema;

      operation.responses[statusCode] = {
        description: response.description,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${schemaName}` },
          },
        },
      };
    } else {
      operation.responses[statusCode] = {
        description: response.description,
      };
    }
  }

  return operation;
}

/**
 * Serialize OpenAPI spec to deterministic JSON.
 */
export function serializeOpenApiSpec(spec: OpenAPISpec): string {
  return JSON.stringify(spec, null, 2);
}
