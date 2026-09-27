/**
 * Header construction and auth injection for API calls.
 */
import type { ApiBinding, ApiCallInput, ApiDefinition } from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { resolveCredentialOrThrow } from './credentials.js';
import { INTEGRATIONS_URL } from './config.js';
import { ApiExecutionError, type TenantHostGuard } from './types.js';
import { apiError } from '../../lib/api-errors.js';
import { resolveOAuth2Token } from './oauth2.js';
import { resolveOAuth2AuthCodeToken } from './oauth2AuthCode.js';
import { mintRequestId } from './requestId.js';

/**
 * Throws if a credential key is missing (undefined) on a non-"none" auth profile.
 * This happens when the agent created a binding with just the auth type but didn't
 * (and can't) set credential keys — the user must configure them in the Integrations page.
 */
function requireCredentialKey(
  apiId: string,
  authType: string,
  fieldName: string,
  value: string | undefined,
): asserts value is string {
  if (!value) {
    throw new ApiExecutionError(
      apiError(
        'API_CREDENTIALS_NOT_CONFIGURED',
        `The API binding for "${apiId}" uses "${authType}" auth but "${fieldName}" is not set. ` +
          `Go to ${INTEGRATIONS_URL}, find the "${apiId}" integration, ` +
          `and configure the credential key for "${fieldName}".`,
        { retryable: false, details: { apiId, authType, fieldName } },
      ),
    );
  }
}
/**
 * Write a header the executor owns, clearing any case-variant a caller already
 * placed. Plain assignment is not enough: header records are case-sensitive
 * objects but HTTP headers are not, and undici COMBINES differing-case
 * duplicates into one comma-joined value with the caller's first — so
 * `headers['x-api-key'] = real` on top of a caller's `X-Api-Key: spoofed`
 * ships `x-api-key: spoofed, real`, and a gateway reading the first token sees
 * the caller's. Deleting first is what makes "the executor wins" true on the
 * wire rather than only in this object.
 */
function setOwnedHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lower) delete headers[existing];
  }
  headers[name] = value;
}

function getCurrentEndpointParams(
  definition: ApiDefinition,
  endpointId: string,
): Array<{ name: string; location: string }> {
  const endpoint = definition.endpoints.find((e) => e.endpointId === endpointId);
  return endpoint?.params ?? [];
}

export async function buildHeaders(
  credentialStore: ReadonlyMap<string, string>,
  redis:
    | {
        get: (k: string) => Promise<string | null>;
        set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
      }
    | undefined,
  db: unknown,
  definition: ApiDefinition,
  input: ApiCallInput,
  binding: ApiBinding,
  ctx: ExecutorContext,
  apiId: string,
  tenantHostGuard?: TenantHostGuard,
): Promise<{ headers: Record<string, string>; authQueryParams: Array<[string, string]> }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...definition.defaultHeaders,
  };

  for (const param of getCurrentEndpointParams(definition, input.endpointId!)) {
    if (param.location === 'header') {
      const value = input.params?.[param.name];
      if (value !== undefined && value !== null) {
        const lower = param.name.toLowerCase();
        if (lower === 'authorization' || lower === 'cookie' || lower === 'set-cookie') {
          continue;
        }
        headers[param.name] =
          typeof value === 'object'
            ? JSON.stringify(value)
            : String(value as string | number | boolean | undefined);
      }
    }
  }

  if (input.headers) {
    for (const [key, value] of Object.entries(input.headers)) {
      const lower = key.toLowerCase();
      if (lower !== 'authorization' && lower !== 'cookie') {
        headers[key] = value;
      }
    }
  }

  const authQueryParams = await applyAuth(
    credentialStore,
    redis,
    db,
    headers,
    binding,
    ctx,
    apiId,
    tenantHostGuard,
    definition.requestIdHeader,
  );

  return { headers, authQueryParams };
}

export async function applyAuth(
  credentialStore: ReadonlyMap<string, string>,
  redis:
    | {
        get: (k: string) => Promise<string | null>;
        set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
      }
    | undefined,
  db: unknown,
  headers: Record<string, string>,
  binding: ApiBinding,
  ctx: ExecutorContext,
  apiId: string,
  tenantHostGuard?: TenantHostGuard,
  requestIdHeader?: string,
): Promise<Array<[string, string]>> {
  const auth = binding.auth;
  const queryParams: Array<[string, string]> = [];

  // Minted here rather than at the one call site that assembles endpoint
  // headers, because the direct-URL routes reach auth without passing through
  // that assembly — and `callMode` gates none of them, so an endpoint-mode
  // definition is reachable by URL. Written before auth so that a definition
  // naming an auth header here loses to auth rather than clobbering it.
  if (requestIdHeader !== undefined) {
    setOwnedHeader(headers, requestIdHeader, mintRequestId(ctx));
  }

  switch (auth.type) {
    case 'none':
      break;
    case 'bearer':
      requireCredentialKey(apiId, auth.type, 'credentialKey', auth.credentialKey);
      setOwnedHeader(
        headers,
        'Authorization',
        `Bearer ${await resolveCredentialOrThrow(credentialStore, apiId, auth.credentialKey)}`,
      );
      break;
    case 'api_key':
      requireCredentialKey(apiId, auth.type, 'credentialKey', auth.credentialKey);
      if (auth.placement === 'header') {
        setOwnedHeader(
          headers,
          auth.headerName,
          await resolveCredentialOrThrow(credentialStore, apiId, auth.credentialKey),
        );
      } else if (auth.placement === 'query') {
        const paramName = auth.queryParamName ?? 'api_key';
        queryParams.push([
          paramName,
          await resolveCredentialOrThrow(credentialStore, apiId, auth.credentialKey),
        ]);
      }
      break;
    case 'api_key_pair': {
      requireCredentialKey(apiId, auth.type, 'credentialKey', auth.credentialKey);
      requireCredentialKey(apiId, auth.type, 'secondaryCredentialKey', auth.secondaryCredentialKey);
      setOwnedHeader(
        headers,
        auth.primaryHeaderName,
        await resolveCredentialOrThrow(credentialStore, apiId, auth.credentialKey),
      );
      setOwnedHeader(
        headers,
        auth.secondaryHeaderName,
        await resolveCredentialOrThrow(credentialStore, apiId, auth.secondaryCredentialKey),
      );
      break;
    }
    case 'basic': {
      requireCredentialKey(apiId, auth.type, 'usernameCredentialKey', auth.usernameCredentialKey);
      requireCredentialKey(apiId, auth.type, 'passwordCredentialKey', auth.passwordCredentialKey);
      const username = await resolveCredentialOrThrow(
        credentialStore,
        apiId,
        auth.usernameCredentialKey,
      );
      const password = await resolveCredentialOrThrow(
        credentialStore,
        apiId,
        auth.passwordCredentialKey,
      );
      const credentials = Buffer.from(`${username}:${password}`).toString('base64');
      setOwnedHeader(headers, 'Authorization', `Basic ${credentials}`);
      break;
    }
    case 'oauth2_client_credentials': {
      requireCredentialKey(apiId, auth.type, 'clientIdCredentialKey', auth.clientIdCredentialKey);
      requireCredentialKey(
        apiId,
        auth.type,
        'clientSecretCredentialKey',
        auth.clientSecretCredentialKey,
      );
      const token = await resolveOAuth2Token(
        credentialStore,
        redis,
        ctx,
        apiId,
        {
          tokenEndpoint: auth.tokenEndpoint,
          clientIdCredentialKey: auth.clientIdCredentialKey,
          clientSecretCredentialKey: auth.clientSecretCredentialKey,
          scopes: auth.scopes,
        },
        tenantHostGuard,
      );
      setOwnedHeader(headers, 'Authorization', `Bearer ${token}`);
      break;
    }
    case 'oauth2_authorization_code': {
      const spaceId =
        binding.scope.spaceId ??
        ((ctx.job as Record<string, unknown>)['spaceId'] as string | undefined);
      if (!spaceId) {
        throw new ApiExecutionError(
          apiError(
            'API_CREDENTIALS_NOT_CONFIGURED',
            `The API binding for "${apiId}" uses 3-legged OAuth but no space context is available to resolve the owner's token.`,
            { retryable: false, details: { apiId, authType: auth.type } },
          ),
        );
      }
      setOwnedHeader(
        headers,
        'Authorization',
        await resolveOAuth2AuthCodeToken({
          ctx,
          db,
          apiId,
          binding,
          auth,
          spaceId,
        }),
      );
      break;
    }
  }

  return queryParams;
}
