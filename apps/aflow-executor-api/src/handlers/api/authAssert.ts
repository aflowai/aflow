/**
 * Assert no auth material in API call inputs.
 */
import type { ApiBinding, ApiCallInput, ApiDefinition } from '@aflow/schemas';
import { apiError } from '../../lib/api-errors.js';
import { ApiExecutionError } from './types.js';

export function assertNoAuthMaterialInInput(
  input: ApiCallInput,
  binding: ApiBinding,
  apiId: string,
  definition?: Pick<ApiDefinition, 'requestIdHeader'>,
): void {
  const forbiddenHeaderNames = new Set<string>(['authorization', 'cookie', 'set-cookie']);

  // A caller-supplied correlation id is fresh on every attempt, which inverts
  // the header's purpose on a provider that deduplicates writes on it. The
  // executor is the only writer.
  if (definition?.requestIdHeader !== undefined) {
    forbiddenHeaderNames.add(definition.requestIdHeader.toLowerCase());
  }
  const forbiddenQueryParamNames = new Set<string>();

  const auth = binding.auth;
  if (auth.type === 'api_key') {
    if (auth.placement === 'header') {
      forbiddenHeaderNames.add(auth.headerName.toLowerCase());
    } else if (auth.placement === 'query') {
      forbiddenQueryParamNames.add((auth.queryParamName ?? 'api_key').toLowerCase());
    }
  } else if (auth.type === 'api_key_pair') {
    forbiddenHeaderNames.add(auth.primaryHeaderName.toLowerCase());
    forbiddenHeaderNames.add(auth.secondaryHeaderName.toLowerCase());
  }

  if (input.headers) {
    for (const key of Object.keys(input.headers)) {
      if (forbiddenHeaderNames.has(key.toLowerCase())) {
        throw new ApiExecutionError(
          apiError(
            'API_FORBIDDEN',
            `Do not provide authentication headers in api.http.call inputs (API "${apiId}").`,
            { retryable: false, details: { apiId, header: key } },
          ),
        );
      }
    }
  }

  const params = input.params ?? {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (forbiddenHeaderNames.has(lower) || forbiddenQueryParamNames.has(lower)) {
      throw new ApiExecutionError(
        apiError(
          'API_FORBIDDEN',
          `Do not provide authentication values in api.http.call params (API "${apiId}").`,
          { retryable: false, details: { apiId, param: key } },
        ),
      );
    }
  }

  if (input.queryParams) {
    for (const key of Object.keys(input.queryParams)) {
      if (forbiddenQueryParamNames.has(key.toLowerCase())) {
        throw new ApiExecutionError(
          apiError(
            'API_FORBIDDEN',
            `Do not provide authentication query params in api.http.call inputs (API "${apiId}").`,
            { retryable: false, details: { apiId, queryParam: key } },
          ),
        );
      }
    }
  }
}
