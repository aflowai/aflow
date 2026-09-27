/**
 * URL construction for API calls.
 */
import type { ApiCallInput, ApiDefinition, ApiEndpoint } from '@aflow/schemas';
import { resolveBaseUrl } from '@aflow/schemas';
import { apiError } from '../../lib/api-errors.js';
import { ApiExecutionError } from './types.js';

export function buildEndpointUrl(
  definition: ApiDefinition,
  endpoint: ApiEndpoint,
  params: Record<string, unknown>,
  variableValues: Record<string, string> | undefined,
): string {
  const baseUrl = resolveBaseUrl(definition, variableValues).replace(/\/+$/, '');
  return `${baseUrl}${buildEndpointPathAndQuery(endpoint, params)}`;
}

/**
 * The part of the request the endpoint decides: path parameters substituted,
 * query parameters constructed. Split from the origin so a caller that must
 * substitute an unavailable origin still builds the same path and query the
 * live call would — the shape a fixture matches and a promoted binding sends.
 */
export function buildEndpointPathAndQuery(
  endpoint: ApiEndpoint,
  params: Record<string, unknown>,
): string {
  let path = endpoint.pathTemplate;

  // A null param value means "not provided" for URL parts — a URL has no null.
  for (const param of endpoint.params) {
    if (param.location === 'path') {
      const value = params[param.name] ?? param.defaultValue;
      if (value !== undefined && value !== null) {
        const encoded = encodeURIComponent(
          typeof value === 'object'
            ? JSON.stringify(value)
            : String(value as string | number | boolean | undefined),
        );
        // Support both {param} (OpenAPI) and :param (Express) path template formats
        path = path.replace(`{${param.name}}`, encoded);
        path = path.replace(`:${param.name}`, encoded);
      } else if (param.required) {
        throw new ApiExecutionError(
          apiError('API_DEFINITION_NOT_FOUND', `Required path parameter "${param.name}" missing`, {
            details: { param: param.name, endpointId: endpoint.endpointId },
          }),
        );
      }
    }
  }

  const queryEntries: Array<[string, string]> = [];
  for (const param of endpoint.params) {
    if (param.location === 'query') {
      const value = params[param.name] ?? param.defaultValue;
      if (value !== undefined && value !== null) {
        queryEntries.push([
          param.name,
          typeof value === 'object'
            ? JSON.stringify(value)
            : String(value as string | number | boolean | undefined),
        ]);
      }
    }
  }

  path = path.startsWith('/') ? path : `/${path}`;
  if (queryEntries.length === 0) return path;
  return `${path}?${new URLSearchParams(queryEntries).toString()}`;
}

export function buildDirectUrl(input: ApiCallInput): string {
  let url = input.url ?? '';

  if (input.queryParams && Object.keys(input.queryParams).length > 0) {
    const separator = url.includes('?') ? '&' : '?';
    const params = new URLSearchParams(input.queryParams);
    url += `${separator}${params.toString()}`;
  }

  return url;
}
