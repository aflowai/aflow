import type { ApiBinding, ApiCallInput, ApiDefinition, ApiEndpoint } from '@aflow/schemas';
import { resolveBaseUrlResult } from '@aflow/schemas';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { resolveBindingByScope } from '@aflow/lib';
import { allowlistHostPatterns, catalogGrantKey } from '@aflow/database';
import { apiError } from '../../lib/api-errors.js';
import { DEFAULT_EGRESS_POLICY, INTEGRATIONS_URL } from './config.js';
import { buildEndpointUrl, buildEndpointPathAndQuery, buildDirectUrl } from './urlBuilders.js';
import { extractBody } from './body.js';
import { buildHeaders, applyAuth } from './headers.js';
import { ensureSpaceLoaded, ensureTenantPolicyLoaded, getSpaceCredentials } from './spaceLoader.js';
import { assertNoAuthMaterialInInput } from './authAssert.js';
import type { ApiHandlerStores, ResolvedCall, TenantHostGuard } from './types.js';
import { ApiExecutionError, definitionStoreKey, spaceScopeKey } from './types.js';

export function resolveBinding(
  spaceBindings: readonly ApiBinding[],
  tenantId: string,
  apiId: string,
  ctx: ExecutorContext,
  /** 104n: explicit binding ID from task capability grant. */
  bindingIdHint?: string,
): ApiBinding | undefined {
  const scopeCtx = {
    tenantId,
    spaceId: (ctx.job as Record<string, unknown>)['spaceId'] as string | undefined,
    flowId: (ctx.job as Record<string, unknown>)['flowId'] as string | undefined,
  };

  if (bindingIdHint) {
    const candidates = spaceBindings.filter(
      (b) => b.bindingId === bindingIdHint && b.apiId === apiId && b.scope.tenantId === tenantId,
    );
    return resolveBindingByScope(candidates, scopeCtx);
  }

  const candidates = spaceBindings.filter(
    (b) => b.apiId === apiId && b.scope.tenantId === tenantId,
  );
  return resolveBindingByScope(candidates, scopeCtx);
}

/**
 * Pull `ctx.job.spaceId` (typed as unknown by the runtime). Returns undefined
 * if missing; callers decide whether that's fatal.
 */
function getJobSpaceId(ctx: ExecutorContext): string | undefined {
  return (ctx.job as Record<string, unknown>)['spaceId'] as string | undefined;
}

/**
 * A host reserved by RFC 2606 and therefore unresolvable. Used when the
 * binding's `baseUrlTemplate` variables are unfilled — the normal state for an
 * API that does not exist yet — so the simulated path still produces the
 * canonical request shape the fixtures match and the operator inspects.
 */
const SIMULATED_HOST = 'https://simulated.invalid';

/**
 * The canonical non-secret headers a call carries. Deliberately excludes every
 * auth header: the identity between simulated and live is the request SHAPE,
 * not its bytes, and authentication is absent from a simulated call by design.
 */
function buildCanonicalHeaders(
  definition: ApiDefinition,
  input: ApiCallInput,
): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(definition.defaultHeaders ?? {}),
    ...(input.headers ?? {}),
  };
}

/**
 * A direct-URL call names no endpoint, so a simulation has no declared contract
 * to answer it with — while the binding's credentials and allowed hosts are the
 * REAL ones, because they stay populated for the day the API ships. Falling
 * through would reach the real host with the real credential through a binding
 * the operator declared simulated, which is fulfillment becoming live by
 * inference. Refusal is the only fail-closed answer.
 */
function refuseSimulatedDirectUrl(params: {
  apiId: string;
  bindingId: string;
  simulationId: string;
}): ApiExecutionError {
  return new ApiExecutionError(
    apiError(
      'API_FORBIDDEN',
      `The connection "${params.bindingId}" for API "${params.apiId}" is fulfilled by simulation ` +
        `"${params.simulationId}", which answers declared endpoints only. Call the endpoint by id ` +
        '(apiId + endpointId) instead of passing a URL, or point the connection at a live ' +
        'fulfillment to reach the real host.',
      { retryable: false, details: { apiId: params.apiId, bindingId: params.bindingId } },
    ),
  );
}

/**
 * The simulated call's URL: the real path and query, on a substituted origin.
 *
 * ONLY an origin nobody has supplied yet is substituted. Every other failure
 * propagates, because the claim simulation makes is that the canonical request
 * shape is the one the promoted binding will send — and a call that passes
 * simulation while missing a required path parameter, or while carrying a
 * variable value the host guard rejects, would fail the day the API ships.
 */
function buildSimulatedUrl(
  definition: ApiDefinition,
  endpoint: ApiEndpoint,
  input: ApiCallInput,
  binding: ApiBinding,
): string {
  const base = resolveBaseUrlResult(definition, binding.variableValues);
  if (!base.ok && base.reason !== 'unavailable') {
    throw new ApiExecutionError(
      apiError('API_DEFINITION_NOT_FOUND', base.message, {
        retryable: false,
        details: { apiId: definition.apiId, endpointId: endpoint.endpointId },
      }),
    );
  }
  const origin = base.ok
    ? base.baseUrl.replace(/\/+$/, '')
    : `${SIMULATED_HOST}/${definition.apiId}`;
  return `${origin}${buildEndpointPathAndQuery(endpoint, input.params ?? {})}`;
}

export async function resolveCall(
  stores: ApiHandlerStores,
  opts: { db?: unknown; redis?: unknown; cacheTtlMs?: number },
  ctx: ExecutorContext,
  input: ApiCallInput,
): Promise<ResolvedCall> {
  const resolved = await resolveCallRoute(stores, opts, ctx, input);
  return attachTenantHostGuard(stores, opts, ctx, resolved);
}

async function resolveCallRoute(
  stores: ApiHandlerStores,
  opts: { db?: unknown; redis?: unknown; cacheTtlMs?: number },
  ctx: ExecutorContext,
  input: ApiCallInput,
): Promise<ResolvedCall> {
  if (input.apiId && input.endpointId) {
    return resolveDefinitionCall(stores, opts, ctx, input);
  }

  if (input.apiId && input.bindingId && input.url) {
    return resolveBindingAllowlistedDirectCall(stores, opts, ctx, input);
  }

  // Host-binding matching.
  // When direct-URL mode is invoked without an explicit binding, the
  // runtime can look up a binding in the caller's space whose
  // egressPolicy.allowedHosts matches the URL's host.
  //   - 0 bindings match by host → fall through to default policy
  //   - 1 binding matches → use its policy transparently
  //   - 2+ bindings match → fail with API_AMBIGUOUS_BINDING
  if (input.url && !input.apiId) {
    const resolved = await tryResolveByHostMatching(stores, opts, ctx, input);
    if (resolved) return resolved;
  }

  return resolveDirectUrlCall(input);
}

/**
 * Allowlist-mode guard for one resolved artifact: the union of the tenant
 * allowlist and the artifact's captured catalog grant. Computed before auth is
 * applied so credentialed side-fetches (the OAuth token exchange) are judged
 * by the same guard as the call itself.
 */
export async function computeTenantHostGuard(
  stores: ApiHandlerStores,
  opts: { db?: unknown; cacheTtlMs?: number },
  ctx: ExecutorContext,
  ref: { apiId?: string | undefined; bindingId?: string | undefined },
): Promise<TenantHostGuard | undefined> {
  const tenantId = ctx.job.tenantId;
  const policy = await ensureTenantPolicyLoaded(stores, opts, tenantId);
  if (policy.mode !== 'allowlist') return undefined;

  const permitted = allowlistHostPatterns(policy, 'api');
  const spaceId = getJobSpaceId(ctx);
  if (spaceId) {
    const grantMap = stores.catalogGrantStore.get(spaceScopeKey(tenantId, spaceId));
    if (grantMap) {
      if (ref.bindingId) {
        permitted.push(...(grantMap.get(catalogGrantKey('api_binding', ref.bindingId)) ?? []));
      }
      if (ref.apiId) {
        permitted.push(...(grantMap.get(catalogGrantKey('api_definition', ref.apiId)) ?? []));
      }
    }
  }
  return { permittedHosts: [...new Set(permitted)] };
}

/**
 * Allowlist-mode recompute-at-use: every resolved call carries the union of
 * the tenant allowlist and the artifact's captured catalog grant, which the
 * execution path intersects with the binding's own egress policy. Attached
 * centrally so no resolution route (endpoint, direct-URL, host-matched, or
 * unbound direct) can skip it; routes that computed the guard pre-auth keep
 * theirs.
 */
export async function attachTenantHostGuard(
  stores: ApiHandlerStores,
  opts: { db?: unknown; cacheTtlMs?: number },
  ctx: ExecutorContext,
  resolved: ResolvedCall,
): Promise<ResolvedCall> {
  if (resolved.tenantHostGuard !== undefined) return resolved;
  const guard = await computeTenantHostGuard(stores, opts, ctx, resolved);
  return guard === undefined ? resolved : { ...resolved, tenantHostGuard: guard };
}

export type HostBindingMatchResult =
  | { kind: 'match'; binding: ApiBinding }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: ApiBinding[] };

export function matchBindingByHost(
  spaceBindings: readonly ApiBinding[],
  urlHost: string,
  jobScope: {
    tenantId: string;
    spaceId: string | undefined;
    flowId: string | undefined;
  },
): HostBindingMatchResult {
  const hostMatches = spaceBindings.filter(
    (b) =>
      b.scope.tenantId === jobScope.tenantId &&
      b.enabled &&
      hostMatchesAnyPattern(urlHost, b.egressPolicy.allowedHosts),
  );

  if (hostMatches.length === 0) return { kind: 'none' };

  let bestScore = -1;
  let bestMatches: ApiBinding[] = [];
  for (const binding of hostMatches) {
    let score: number;
    if (binding.scope.flowId && jobScope.flowId && binding.scope.flowId === jobScope.flowId) {
      score = 3;
    } else if (
      binding.scope.spaceId &&
      jobScope.spaceId &&
      binding.scope.spaceId === jobScope.spaceId
    ) {
      score = 2;
    } else {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatches = [binding];
    } else if (score === bestScore) {
      bestMatches.push(binding);
    }
  }

  if (bestMatches.length === 0) return { kind: 'none' };
  if (bestMatches.length > 1) return { kind: 'ambiguous', candidates: bestMatches };
  return { kind: 'match', binding: bestMatches[0]! };
}

/**
 * Look up a host-matching binding in the caller's space.
 */
async function tryResolveByHostMatching(
  stores: ApiHandlerStores,
  opts: { db?: unknown; redis?: unknown; cacheTtlMs?: number },
  ctx: ExecutorContext,
  input: ApiCallInput,
): Promise<ResolvedCall | undefined> {
  let urlHost: string;
  try {
    urlHost = new URL(input.url!).hostname;
  } catch {
    return undefined;
  }

  const tenantId = ctx.job.tenantId;
  const spaceId = getJobSpaceId(ctx);
  if (!spaceId) return undefined;

  await ensureSpaceLoaded(stores, opts, tenantId, spaceId);

  const spaceBindings = stores.bindingStore.get(spaceScopeKey(tenantId, spaceId)) ?? [];
  const result = matchBindingByHost(spaceBindings, urlHost, {
    tenantId,
    spaceId,
    flowId: (ctx.job as Record<string, unknown>)['flowId'] as string | undefined,
  });

  if (result.kind === 'none') return undefined;

  if (result.kind === 'ambiguous') {
    const bindingIds = result.candidates.map((b) => `"${b.apiId}/${b.bindingId}"`).join(', ');
    throw new ApiExecutionError(
      apiError(
        'API_AMBIGUOUS_BINDING',
        `Direct-URL host "${urlHost}" matches multiple bindings (${bindingIds}) at the same scope level. ` +
          `Pass apiId + bindingId explicitly to disambiguate.`,
        {
          retryable: false,
          details: {
            url: input.url,
            urlHost,
            matchedBindings: result.candidates.map((b) => ({
              apiId: b.apiId,
              bindingId: b.bindingId,
            })),
          },
        },
      ),
    );
  }

  const binding = result.binding;
  if (binding.fulfillment.mode === 'simulated') {
    throw refuseSimulatedDirectUrl({
      apiId: binding.apiId,
      bindingId: binding.bindingId,
      simulationId: binding.fulfillment.simulationId,
    });
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...input.headers,
  };

  const tenantHostGuard = await computeTenantHostGuard(stores, opts, ctx, {
    apiId: binding.apiId,
    bindingId: binding.bindingId,
  });

  // Host-matched to this binding's allowed host — apply its auth, same as the
  // explicit apiId+bindingId direct path. The token only reaches that host.
  const redis = opts.redis as
    | {
        get: (k: string) => Promise<string | null>;
        set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
      }
    | undefined;
  const spaceCredentials = getSpaceCredentials(stores, tenantId, spaceId);
  const authQueryParams = await applyAuth(
    spaceCredentials,
    redis,
    opts.db,
    headers,
    binding,
    ctx,
    binding.apiId,
    tenantHostGuard,
    stores.definitionStore.get(definitionStoreKey({ tenantId, spaceId, apiId: binding.apiId }))
      ?.requestIdHeader,
  );

  let url = input.url!;
  if (authQueryParams.length > 0) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}${new URLSearchParams(authQueryParams).toString()}`;
  }

  return {
    url,
    method: input.method,
    headers,
    body: input.body,
    egressPolicy: binding.egressPolicy,
    apiId: binding.apiId,
    bindingId: binding.bindingId,
    ...(tenantHostGuard !== undefined ? { tenantHostGuard } : {}),
  };
}

async function resolveBindingAllowlistedDirectCall(
  stores: ApiHandlerStores,
  opts: { db?: unknown; redis?: unknown; cacheTtlMs?: number },
  ctx: ExecutorContext,
  input: ApiCallInput,
): Promise<ResolvedCall> {
  const apiId = input.apiId!;
  const tenantId = ctx.job.tenantId;
  const spaceId = getJobSpaceId(ctx);
  if (!spaceId) {
    throw new ApiExecutionError(
      apiError(
        'API_CREDENTIALS_NOT_CONFIGURED',
        `Cannot resolve binding "${input.bindingId}" — no spaceId on job. Integrations are space-scoped.`,
        { retryable: false, details: { apiId } },
      ),
    );
  }

  await ensureSpaceLoaded(stores, opts, tenantId, spaceId);

  const spaceBindings = stores.bindingStore.get(spaceScopeKey(tenantId, spaceId)) ?? [];
  const binding = resolveBinding(spaceBindings, tenantId, apiId, ctx, input.bindingId);
  if (!binding) {
    throw new ApiExecutionError(
      apiError(
        'API_CREDENTIALS_NOT_CONFIGURED',
        `The API "${apiId}" has no binding "${input.bindingId}" in space ${spaceId}. ` +
          `Setup: 1) Create a binding via api.binding.upsert with auth and egressPolicy. ` +
          `2) Store the credential value at: ${INTEGRATIONS_URL}. ` +
          'Once both are configured, retry the call.',
        { retryable: false, details: { apiId, tenantId, spaceId } },
      ),
    );
  }
  if (!binding.enabled) {
    throw new ApiExecutionError(
      apiError(
        'API_FORBIDDEN',
        `The connection for API "${apiId}" is currently disabled. Enable it at: ${INTEGRATIONS_URL}`,
        { retryable: false, details: { apiId, bindingId: binding.bindingId } },
      ),
    );
  }

  if (binding.fulfillment.mode === 'simulated') {
    throw refuseSimulatedDirectUrl({
      apiId,
      bindingId: binding.bindingId,
      simulationId: binding.fulfillment.simulationId,
    });
  }

  // The URL host must be in the binding's allowedHosts — that's the
  // safety boundary that justifies allowing literal URLs in production.
  let urlHost: string;
  try {
    urlHost = new URL(input.url!).hostname;
  } catch {
    throw new ApiExecutionError(
      apiError(
        'API_BINDING_EGRESS_BLOCKED',
        `Egress blocked: direct-URL call has a malformed URL: ${String(input.url)}`,
        { retryable: false, details: { url: input.url } },
      ),
    );
  }
  const allowedHosts = binding.egressPolicy.allowedHosts;
  if (!hostMatchesAnyPattern(urlHost, allowedHosts)) {
    throw new ApiExecutionError(
      apiError(
        'API_BINDING_EGRESS_BLOCKED',
        `Egress blocked: host "${urlHost}" is not in binding "${binding.bindingId}" egressPolicy.allowedHosts (${allowedHosts.join(', ')}).`,
        {
          retryable: false,
          details: {
            url: input.url,
            urlHost,
            allowedHosts,
            blockKind: 'direct_url_host_not_allowed',
            blockedHost: urlHost,
            bindingId: binding.bindingId,
          },
        },
      ),
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...input.headers,
  };

  const tenantHostGuard = await computeTenantHostGuard(stores, opts, ctx, {
    apiId,
    bindingId: binding.bindingId,
  });

  // The URL is validated to be on the binding's own allowed host, so this is a
  // direct call to the binding's API — apply the binding's auth exactly as the
  // endpoint path does (Plan 185: oauth2_authorization_code on a same-host
  // direct-URL call; an absent user token throws the consent pause). The token
  // only ever reaches the binding's allowed host, never an arbitrary URL.
  const redis = opts.redis as
    | {
        get: (k: string) => Promise<string | null>;
        set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
      }
    | undefined;
  const spaceCredentials = getSpaceCredentials(stores, tenantId, spaceId);
  const authQueryParams = await applyAuth(
    spaceCredentials,
    redis,
    opts.db,
    headers,
    binding,
    ctx,
    apiId,
    tenantHostGuard,
    stores.definitionStore.get(definitionStoreKey({ tenantId, spaceId, apiId }))?.requestIdHeader,
  );

  let url = input.url!;
  if (authQueryParams.length > 0) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}${new URLSearchParams(authQueryParams).toString()}`;
  }

  return {
    url,
    method: input.method,
    headers,
    body: input.body,
    egressPolicy: binding.egressPolicy,
    apiId,
    bindingId: binding.bindingId,
    ...(tenantHostGuard !== undefined ? { tenantHostGuard } : {}),
  };
}

/**
 * Match a hostname against an allowedHosts pattern list. Supports exact
 * matches and `*.example.com` wildcard subdomain matches (the same
 * convention used by the rest of the egress policy plumbing).
 */
function hostMatchesAnyPattern(hostname: string, patterns: readonly string[]): boolean {
  const lower = hostname.toLowerCase();
  for (const raw of patterns) {
    const pattern = raw.toLowerCase();
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (lower.endsWith(suffix) && lower.length > suffix.length) return true;
      if (lower === suffix.slice(1)) return true;
    } else if (lower === pattern) {
      return true;
    }
  }
  return false;
}

async function resolveDefinitionCall(
  stores: ApiHandlerStores,
  opts: { db?: unknown; redis?: unknown; cacheTtlMs?: number },
  ctx: ExecutorContext,
  input: ApiCallInput,
): Promise<ResolvedCall> {
  const apiId = input.apiId!;
  const endpointId = input.endpointId!;
  const tenantId = ctx.job.tenantId;
  const spaceId = getJobSpaceId(ctx);

  if (!spaceId) {
    throw new ApiExecutionError(
      apiError(
        'API_DEFINITION_NOT_FOUND',
        `API definition "${apiId}" not found — no spaceId on job. Integrations are space-scoped.`,
        { details: { apiId } },
      ),
    );
  }

  await ensureSpaceLoaded(stores, opts, tenantId, spaceId);

  const definition = stores.definitionStore.get(definitionStoreKey({ tenantId, spaceId, apiId }));
  if (!definition) {
    const invalidIssues = stores.invalidDefinitions.get(
      definitionStoreKey({ tenantId, spaceId, apiId }),
    );
    if (invalidIssues) {
      throw new ApiExecutionError(
        apiError(
          'API_DEFINITION_NOT_FOUND',
          `API definition "${apiId}" exists in space ${spaceId} but fails validation and was not loaded: ${invalidIssues}. ` +
            'Fix the stored definition_json (re-install its bundle with overwrite, or repair the row) so it parses under the runtime ApiDefinition schema.',
          { retryable: false, details: { apiId, spaceId, issues: invalidIssues } },
        ),
      );
    }
    throw new ApiExecutionError(
      apiError(
        'API_DEFINITION_NOT_FOUND',
        `API definition "${apiId}" not found in space ${spaceId}`,
        { details: { apiId, spaceId } },
      ),
    );
  }

  const endpoint = definition.endpoints.find((e) => e.endpointId === endpointId);
  if (!endpoint) {
    throw new ApiExecutionError(
      apiError('API_ENDPOINT_NOT_FOUND', `Endpoint "${endpointId}" not found in API "${apiId}"`, {
        details: { apiId, endpointId },
      }),
    );
  }

  const spaceBindings = stores.bindingStore.get(spaceScopeKey(tenantId, spaceId)) ?? [];
  const binding = resolveBinding(spaceBindings, tenantId, apiId, ctx, input.bindingId);
  if (!binding) {
    throw new ApiExecutionError(
      apiError(
        'API_CREDENTIALS_NOT_CONFIGURED',
        `The API "${apiId}" has no binding in space ${spaceId}. ` +
          'Setup: 1) Create a binding via api.binding.upsert with auth and egressPolicy. ' +
          `2) Store the credential value at: ${INTEGRATIONS_URL}. ` +
          'Once both are configured, retry the call.',
        { retryable: false, details: { apiId, tenantId, spaceId } },
      ),
    );
  }

  if (!binding.enabled) {
    throw new ApiExecutionError(
      apiError(
        'API_FORBIDDEN',
        `The connection for API "${apiId}" is currently disabled. Enable it at: ${INTEGRATIONS_URL}`,
        {
          retryable: false,
          details: { apiId, bindingId: binding.bindingId },
        },
      ),
    );
  }

  assertNoAuthMaterialInInput(input, binding, apiId, definition);

  // ── Simulated fulfillment ───────────────────────────────────────────────
  // Diverges BEFORE the credential store is touched and before an unresolved
  // baseUrlTemplate can throw. Both would fire on the case the feature exists
  // for: an API nobody has provisioned has no filled variables and no secret.
  //
  // `getSpaceCredentials` is not reachable from this branch, so "no credential
  // is read" is a property of the call graph rather than a promise in a
  // comment. The host falls back to a reserved-TLD name that can never
  // resolve, so a future bug reaching fetch fails closed.
  if (binding.fulfillment.mode === 'simulated') {
    const simulatedUrl = buildSimulatedUrl(definition, endpoint, input, binding);
    return {
      url: simulatedUrl,
      method: endpoint.method,
      headers: buildCanonicalHeaders(definition, input),
      body: extractBody(endpoint, input.params ?? {}),
      egressPolicy: binding.egressPolicy,
      apiId,
      bindingId: binding.bindingId,
      endpointId,
      endpoint,
      simulation: {
        simulationId: binding.fulfillment.simulationId,
        bindingId: binding.bindingId,
        apiId,
      },
    };
  }

  let url: string;
  try {
    url = buildEndpointUrl(definition, endpoint, input.params ?? {}, binding.variableValues);
  } catch (err) {
    if (err instanceof ApiExecutionError) throw err;
    throw new ApiExecutionError(
      apiError(
        'API_CREDENTIALS_NOT_CONFIGURED',
        `The connection for API "${apiId}" needs configuration: ${
          err instanceof Error ? err.message : String(err)
        } Fill the binding's variable values at: ${INTEGRATIONS_URL}`,
        { retryable: false, details: { apiId, bindingId: binding.bindingId, spaceId } },
      ),
    );
  }

  const egressPolicy = binding.egressPolicy;
  const method = endpoint.method;
  const tenantHostGuard = await computeTenantHostGuard(stores, opts, ctx, {
    apiId,
    bindingId: binding.bindingId,
  });
  const redis = opts.redis as
    | {
        get: (k: string) => Promise<string | null>;
        set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
      }
    | undefined;
  const spaceCredentials = getSpaceCredentials(stores, tenantId, spaceId);
  const { headers, authQueryParams } = await buildHeaders(
    spaceCredentials,
    redis,
    opts.db,
    definition,
    input,
    binding,
    ctx,
    apiId,
    tenantHostGuard,
  );
  const body = extractBody(endpoint, input.params ?? {});

  if (authQueryParams.length > 0) {
    const separator = url.includes('?') ? '&' : '?';
    const qs = new URLSearchParams(authQueryParams);
    url += `${separator}${qs.toString()}`;
  }

  return {
    url,
    method,
    headers,
    body,
    egressPolicy,
    apiId,
    bindingId: binding.bindingId,
    endpointId,
    endpoint,
    ...(tenantHostGuard !== undefined ? { tenantHostGuard } : {}),
  };
}

function resolveDirectUrlCall(input: ApiCallInput): ResolvedCall {
  const url = buildDirectUrl(input);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...input.headers,
  };

  return {
    url,
    method: input.method,
    headers,
    body: input.body,
    egressPolicy: DEFAULT_EGRESS_POLICY,
  };
}
