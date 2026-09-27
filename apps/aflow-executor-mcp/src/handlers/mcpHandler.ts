import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  internalError,
  validationError,
  providerError,
  pausedWithRequest,
} from '@aflow/executor-runtime';
import {
  McpToolCallInputSchema,
  McpToolListInputSchema,
  McpServerRefreshToolsInputSchema,
  McpBindingTestInputSchema,
  TenantIdSchema,
  extractUrlOrigin,
  mcpCredentialsError,
  type McpCredentialBlock,
  type McpServerBinding,
  type McpServerDefinition,
  type McpToolCallInput,
  type McpCachedTool,
  type McpSessionMetadata,
  type OAuthConsentRequestPayload,
  type OAuthConsentReason,
} from '@aflow/schemas';
import { publishMcpCatalogInvalidation } from '@aflow/redis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ToolListChangedNotificationSchema,
  ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  decryptCredentialAsync,
  withTenantSchema,
  createTenantContext,
  createTenantPolicyCache,
} from '@aflow/database';
import {
  validateUrl,
  safeFetchImpl,
  validateCredentialedUrl,
  SsrfBlockedError,
  DnsBlockedError,
} from '@aflow/network-safety';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  definitionStoreKey,
  getMcpSpaceStores,
  type McpHandlerStores,
  type BindingCacheUpdate,
} from './types.js';
import {
  assertTenantPolicyPermitsConnect,
  tenantPolicyPermittedHosts,
  type McpTenantGuardRef,
} from './tenantPolicyGuard.js';
import { ensureSpaceLoaded, invalidateSpaceCache } from './spaceLoader.js';
import {
  McpConnectionPool,
  poolKeyManaged,
  poolKeyRaw,
  type PoolEntry,
  type InflightMcpCall,
} from './connectionPool.js';
import {
  resolveDefinitionAndBinding,
  checkToolCallACL,
  isCredentialResolutionReason,
} from './resolution.js';
import {
  getValidAccessToken,
  resolveOAuthOwner,
  buildMcpOAuthDescriptor,
  type OAuthBindingTarget,
} from '@aflow/oauth';
import { suspendForElicitation, outcomeToElicitResult } from './elicitationSuspend.js';
import { McpElicitationRequestSchema } from '@aflow/schemas';
import { randomUUID } from 'crypto';
import {
  getClientCredentialsToken,
  type ClientCredentialsRedisLike,
} from '../auth/clientCredentialsToken.js';

export interface McpHandlerDeps {
  db?: unknown;
  redis?: Redis;
  redisSubscriber?: Redis;
  executorInstanceId?: string;
}

/** Check if the parsed mcp.tool.call input is the raw (serverUrl) variant. */
function isRawCallInput(input: McpToolCallInput): input is {
  serverUrl: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  authToken?: string;
  timeoutMs?: number;
} {
  return 'serverUrl' in input;
}

/**
 * Map a `getValidAccessToken` failure to a consent `reason`, or `null` when the
 * error is not a missing/unusable-token condition (a genuine resolution fault
 * that should still FAIL). `oauth_no_token` = the owner never consented;
 * `oauth_force_refresh_no_refresh_token` = the token is unusable with no refresh
 * path, so the owner must re-consent.
 */
export function oauthConsentReasonFromError(err: unknown): OAuthConsentReason | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('oauth_no_token')) return 'never_connected';
  if (message.startsWith('oauth_force_refresh_no_refresh_token')) return 'expired';
  return null;
}

export function buildOAuthConsentRequest(
  binding: McpServerBinding,
  reason: OAuthConsentReason,
): OAuthConsentRequestPayload {
  return {
    kind: 'oauth_consent',
    integrationKind: 'mcp',
    resourceKey: binding.serverId,
    bindingId: binding.bindingId,
    ownerScope: binding.ownerScope,
    consentUrlHint: `/v1/integrations/mcp/bindings/${binding.bindingId}/consent`,
    reason,
  };
}

/**
 * Park the step as a recoverable "connect your account" PAUSE instead of a
 * FAILED credential error. The orchestrator (applyResult PAUSED branch) reads
 * the `oauth_consent` request payload and parks the session with the typed
 * `needs_oauth_consent` blockedOn for the Action Center to surface.
 */
function mcpConsentPause(
  ctx: ExecutorContext,
  consent: OAuthConsentRequestPayload,
): Promise<StepResult> {
  return pausedWithRequest(ctx, consent);
}

export class McpHandler implements StepHandler {
  readonly stepType = 'mcp' as const;

  private readonly stores: McpHandlerStores = {
    bySpace: new Map(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: createTenantPolicyCache({
      onLoadError: (tenantId, err) => {
        console.warn(
          `[mcp spaceLoader] Failed to load integration policy for tenant ${tenantId}: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'Keeping the last-known-good policy (open only if never loaded).',
        );
      },
    }),
  };

  private readonly pool = new McpConnectionPool();

  constructor(private readonly deps: McpHandlerDeps = {}) {
    this.pool.start();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  invalidateSpace(
    tenantId: string,
    spaceId: string,
    opts?: { bindingId?: string; kind?: 'definition' | 'binding' | 'tool_cache' },
  ): void {
    invalidateSpaceCache(this.stores, tenantId, spaceId);

    if (opts?.kind === 'tool_cache') {
      // Pool entries stay; the in-memory slice drop above is enough — the
      // next call re-reads cachedTools from DB.
      return;
    }

    // Pool key format: `m:{tenantId}|{serverId}|{bindingId}|{spaceId}`.
    if (opts?.bindingId) {
      const needle = `|${opts.bindingId}|`;
      const spaceSuffix = `|${spaceId}`;
      void this.pool.removeMatching(
        (k) => k.startsWith(`m:${tenantId}|`) && k.includes(needle) && k.endsWith(spaceSuffix),
      );
    } else {
      const spaceSuffix = `|${spaceId}`;
      void this.pool.removeMatching(
        (k) => k.startsWith(`m:${tenantId}|`) && k.endsWith(spaceSuffix),
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  // --------------------------------------------------------------------------
  // Top-level dispatch
  // --------------------------------------------------------------------------

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const operationId = String(ctx.operationId);

    if (operationId === 'mcp.tool.call') return this.handleCall(ctx);
    if (operationId === 'mcp.tool.list') return this.handleList(ctx);
    if (operationId === 'mcp.binding.test') return this.handleBindingTest(ctx);
    if (operationId === 'mcp.server.refresh_tools') return this.handleRefreshTools(ctx);

    // Defense-in-depth: CRUD ops like `mcp.server.upsert` / `mcp.binding.get`
    // are NOT executor-handled. They live as inline orchestrator handlers
    // (mirroring `apiAdmin.ts`) or via REST routes — never as executor steps.
    // Reject explicitly so a misconfigured `coreOperations` doesn't silently
    // parse a CRUD payload as an `mcp.tool.call` input.
    return failureWithError(
      ctx,
      validationError(
        `MCP executor does not handle operation "${operationId}". ` +
          `Executor-callable ops are: mcp.tool.call, mcp.tool.list, mcp.binding.test, mcp.server.refresh_tools. ` +
          `CRUD ops (mcp.server.*, mcp.binding.{upsert,get,list,delete}) belong on inline orchestrator handlers or REST routes.`,
      ),
    );
  }

  // --------------------------------------------------------------------------
  // mcp.tool.call
  // --------------------------------------------------------------------------

  private async handleCall(ctx: ExecutorContext): Promise<StepResult> {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parseResult = McpToolCallInputSchema.safeParse(raw);
    if (!parseResult.success) {
      return failureWithError(
        ctx,
        validationError(`Invalid mcp.tool.call input: ${parseResult.error.message}`),
      );
    }

    const input = parseResult.data;

    if (isRawCallInput(input)) {
      if (process.env['NODE_ENV'] === 'production') {
        return failureWithError(
          ctx,
          validationError(
            'Raw serverUrl path is dev-only and disabled in production. Use the managed (serverId) path.',
          ),
        );
      }
      return this.handleRawCall(ctx, input);
    }

    return this.handleManagedCall(ctx, input as Extract<McpToolCallInput, { serverId: string }>);
  }

  private async handleRawCall(
    ctx: ExecutorContext,
    input: {
      serverUrl: string;
      toolName: string;
      arguments?: Record<string, unknown>;
      authToken?: string;
      timeoutMs?: number;
    },
  ): Promise<StepResult> {
    const headers: Record<string, string> = {};
    if (input.authToken) headers['Authorization'] = `Bearer ${input.authToken}`;

    const key = poolKeyRaw(input.serverUrl);
    let entry: PoolEntry;
    try {
      entry = await this.acquire(key, input.serverUrl, headers);
    } catch (err) {
      return failureWithError(
        ctx,
        internalError(
          `Failed to connect to MCP server: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true },
        ),
      );
    }

    try {
      const result = await entry.client.callTool(
        { name: input.toolName, arguments: input.arguments ?? {} },
        undefined,
        { timeout: input.timeoutMs ?? 30_000 },
      );
      this.pool.touch(key);
      return await routeToolResult(
        ctx,
        input.toolName,
        mapToolResult(
          result as {
            content?: unknown;
            isError?: boolean | undefined;
            structuredContent?: unknown;
          },
        ),
        input.arguments ?? {},
      );
    } catch (err) {
      await this.pool.remove(key);
      return await failureWithError(
        ctx,
        internalError(`MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`, {
          retryable: false,
        }),
      );
    }
  }

  private async handleManagedCall(
    ctx: ExecutorContext,
    input: {
      serverId: string;
      toolName: string;
      arguments?: Record<string, unknown> | undefined;
      bindingId?: string | undefined;
      timeoutMs?: number | undefined;
    },
  ): Promise<StepResult> {
    const resolved = await this.resolveManaged(ctx, input.serverId, input.bindingId);
    if (!resolved.ok) return resolved.failure;

    const { definition, binding, headers, key, refreshed } = resolved;

    const aclCheck = checkToolCallACL(definition, binding, input.toolName);
    if (!aclCheck.ok) {
      return failureWithError(ctx, validationError(aclCheck.message));
    }

    if (refreshed) {
      await this.pool.remove(key);
    }

    let entry: PoolEntry;
    try {
      entry = await this.acquireManaged(key, definition.serverUrl, headers, {
        tenantId: ctx.job.tenantId,
        spaceId: binding.scope.spaceId!,
        serverId: binding.serverId,
        bindingId: binding.bindingId,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError || err instanceof DnsBlockedError) {
        return failureWithError(ctx, validationError(err.message));
      }
      return failureWithError(
        ctx,
        internalError(
          `Failed to connect to MCP server "${definition.serverId}": ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true },
        ),
      );
    }

    if (binding.subscribeListChanged && binding.pinnedOrigin) {
      this.attachListChangedSubscription(
        entry,
        ctx.job.tenantId,
        binding.scope.spaceId!,
        binding.serverId,
        binding.bindingId,
        definition.name,
        binding.pinnedOrigin,
      );
    }

    // For `auth.type: 'none'` bindings without a pin, record origin from this
    if (binding.auth.type === 'none' && !binding.pinnedOrigin && this.deps.db && this.deps.redis) {
      const newPin = extractUrlOrigin(definition.serverUrl);
      try {
        await this.writeBindingPin(
          ctx.job.tenantId,
          binding.scope.spaceId!,
          binding.bindingId,
          newPin,
        );
        publishMcpCatalogInvalidation(this.deps.redis, ctx.job.tenantId, binding.scope.spaceId!, {
          kind: 'binding',
          serverId: binding.serverId,
          bindingId: binding.bindingId,
        });
      } catch (err) {
        ctx.log.warn(
          `Failed to record pinnedOrigin for binding ${binding.bindingId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const baseTimeoutMs = input.timeoutMs ?? binding.connectionPolicy.timeoutMs ?? 30_000;
    const elicitationLeaseMs = binding.connectionPolicy.elicitationLeaseMs ?? 900_000;
    const timeoutMs = resolveCallToolTimeoutMs(baseTimeoutMs, elicitationLeaseMs);
    const callArgs = { name: input.toolName, arguments: input.arguments ?? {} };

    const callTag = registerInflightCall(entry, {
      stepExecutionId: ctx.stepExecutionId,
      tenantId: ctx.job.tenantId,
      spaceId: binding.scope.spaceId!,
      bindingId: binding.bindingId,
      serverId: binding.serverId,
      ...(ctx.job.sessionId ? { sessionId: ctx.job.sessionId } : {}),
      elicitationLeaseMs,
      ...(ctx.slotController ? { slotController: ctx.slotController } : {}),
    });

    try {
      const result = await entry.client.callTool(callArgs, undefined, { timeout: timeoutMs });
      deregisterInflightCall(entry, callTag);
      this.pool.touch(key);
      return await routeToolResult(
        ctx,
        input.toolName,
        mapToolResult(
          result as {
            content?: unknown;
            isError?: boolean | undefined;
            structuredContent?: unknown;
          },
        ),
        callArgs.arguments,
      );
    } catch (err) {
      // Deregister inflight on the original entry — the retry path may
      // acquire a new entry below, but the original is being abandoned
      // either way.
      deregisterInflightCall(entry, callTag);
      if (isOAuthBinding(binding) && isUnauthorizedError(err)) {
        ctx.log.info(
          `[mcp] 401 on tool="${input.toolName}" binding="${binding.bindingId}" — forcing token refresh and retrying once`,
        );
        const retryHeadersResult = await this.buildAuthHeaders(binding, ctx, {
          forceRefresh: true,
        });
        if (!retryHeadersResult.ok) {
          await this.pool.remove(key);
          if ('consent' in retryHeadersResult) {
            return mcpConsentPause(ctx, retryHeadersResult.consent);
          }
          return failureWithError(ctx, validationError(retryHeadersResult.error));
        }
        await this.pool.remove(key);
        try {
          const retryEntry = await this.acquireManaged(
            key,
            definition.serverUrl,
            retryHeadersResult.headers,
            {
              tenantId: ctx.job.tenantId,
              spaceId: binding.scope.spaceId!,
              serverId: binding.serverId,
              bindingId: binding.bindingId,
            },
          );
          // Re-attach the list_changed subscription on the fresh entry. The
          // pinnedOrigin invariant required for credentialed bindings holds at
          // this point (gated above when binding.auth.type !== 'none').
          if (binding.subscribeListChanged && binding.pinnedOrigin) {
            this.attachListChangedSubscription(
              retryEntry,
              ctx.job.tenantId,
              binding.scope.spaceId!,
              binding.serverId,
              binding.bindingId,
              definition.name,
              binding.pinnedOrigin,
            );
          }
          // Track inflight on the freshly-acquired entry for the retry
          // attempt — elicitations during the retry must still correlate.
          const retryCallTag = registerInflightCall(retryEntry, {
            stepExecutionId: ctx.stepExecutionId,
            tenantId: ctx.job.tenantId,
            spaceId: binding.scope.spaceId!,
            bindingId: binding.bindingId,
            serverId: binding.serverId,
            ...(ctx.job.sessionId ? { sessionId: ctx.job.sessionId } : {}),
            elicitationLeaseMs,
            ...(ctx.slotController ? { slotController: ctx.slotController } : {}),
          });
          try {
            const result = await retryEntry.client.callTool(callArgs, undefined, {
              timeout: timeoutMs,
            });
            this.pool.touch(key);
            return await routeToolResult(
              ctx,
              input.toolName,
              mapToolResult(
                result as {
                  content?: unknown;
                  isError?: boolean | undefined;
                  structuredContent?: unknown;
                },
              ),
              callArgs.arguments,
            );
          } finally {
            deregisterInflightCall(retryEntry, retryCallTag);
          }
        } catch (retryErr) {
          await this.pool.remove(key);
          return failureWithError(
            ctx,
            internalError(
              `MCP tool "${input.toolName}" on server "${input.serverId}" failed after token refresh retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              { retryable: false },
            ),
          );
        }
      }
      await this.pool.remove(key);
      return await failureWithError(
        ctx,
        internalError(
          `MCP tool "${input.toolName}" on server "${input.serverId}" failed: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: false },
        ),
      );
    }
  }

  // --------------------------------------------------------------------------
  // mcp.tool.list (raw path — managed list is via mcp.binding.test)
  // --------------------------------------------------------------------------

  private async handleList(ctx: ExecutorContext): Promise<StepResult> {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parseResult = McpToolListInputSchema.safeParse(raw);
    if (!parseResult.success) {
      return failureWithError(
        ctx,
        validationError(`Invalid mcp.tool.list input: ${parseResult.error.message}`),
      );
    }

    if (process.env['NODE_ENV'] === 'production') {
      return failureWithError(
        ctx,
        validationError(
          'mcp.tool.list raw-URL path is dev-only and disabled in production. Use mcp.binding.test or mcp.server.refresh_tools.',
        ),
      );
    }

    const input = parseResult.data;
    const headers: Record<string, string> = {};
    if (input.authToken) headers['Authorization'] = `Bearer ${input.authToken}`;

    const key = poolKeyRaw(input.serverUrl);
    let entry: PoolEntry;
    try {
      entry = await this.acquire(key, input.serverUrl, headers);
    } catch (err) {
      return failureWithError(
        ctx,
        internalError(
          `Failed to connect to MCP server: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true },
        ),
      );
    }

    try {
      const result = await entry.client.listTools();
      this.pool.touch(key);
      const tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
      }));
      return await successWithData(ctx, { tools });
    } catch (err) {
      await this.pool.remove(key);
      return await failureWithError(
        ctx,
        internalError(`MCP tool list failed: ${err instanceof Error ? err.message : String(err)}`, {
          retryable: false,
        }),
      );
    }
  }

  // --------------------------------------------------------------------------
  // mcp.binding.test
  // --------------------------------------------------------------------------

  private async handleBindingTest(ctx: ExecutorContext): Promise<StepResult> {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parseResult = McpBindingTestInputSchema.safeParse(raw);
    if (!parseResult.success) {
      return failureWithError(
        ctx,
        validationError(`Invalid mcp.binding.test input: ${parseResult.error.message}`),
      );
    }
    return this.refreshBindingCache(ctx, parseResult.data.bindingId);
  }

  // --------------------------------------------------------------------------
  // mcp.server.refresh_tools
  // --------------------------------------------------------------------------

  private async handleRefreshTools(ctx: ExecutorContext): Promise<StepResult> {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parseResult = McpServerRefreshToolsInputSchema.safeParse(raw);
    if (!parseResult.success) {
      return failureWithError(
        ctx,
        validationError(`Invalid mcp.server.refresh_tools input: ${parseResult.error.message}`),
      );
    }
    const { serverId, bindingId } = parseResult.data;
    return this.refreshBindingCache(ctx, bindingId, { expectServerId: serverId });
  }

  // --------------------------------------------------------------------------
  // Shared: refresh a binding's cache by reconnecting
  // --------------------------------------------------------------------------

  private async refreshBindingCache(
    ctx: ExecutorContext,
    bindingId: string,
    opts?: { expectServerId?: string },
  ): Promise<StepResult> {
    const spaceId = (ctx.job as Record<string, unknown>)['spaceId'] as string | undefined;
    if (!spaceId) {
      return failureWithError(
        ctx,
        validationError(
          `mcp.binding.test / mcp.server.refresh_tools require a spaceId on the job context.`,
        ),
      );
    }

    await ensureSpaceLoaded(this.stores, { db: this.deps.db }, ctx.job.tenantId, spaceId);

    const slice = getMcpSpaceStores(this.stores, ctx.job.tenantId, spaceId);
    const binding = slice.bindingStore.find(
      (b) => b.bindingId === bindingId && b.scope.spaceId === spaceId,
    );
    if (!binding) {
      return failureWithError(
        ctx,
        validationError(`MCP binding "${bindingId}" not found in space "${spaceId}"`),
      );
    }

    // mcp.server.refresh_tools includes a serverId — fail fast if it doesn't
    // match the binding's serverId (caller likely passed the wrong pair).
    // mcp.binding.test omits serverId, so this only fires for refresh_tools.
    if (opts?.expectServerId && opts.expectServerId !== binding.serverId) {
      return failureWithError(
        ctx,
        validationError(
          `mcp.server.refresh_tools: binding "${bindingId}" targets server "${binding.serverId}", not "${opts.expectServerId}".`,
        ),
      );
    }

    const definition = slice.definitionStore.get(
      definitionStoreKey({ tenantId: ctx.job.tenantId, spaceId, serverId: binding.serverId }),
    );
    if (!definition) {
      return failureWithError(
        ctx,
        validationError(
          `MCP definition "${binding.serverId}" not found in space "${spaceId}" for binding "${bindingId}"`,
        ),
      );
    }

    const headersResult = await this.buildAuthHeaders(binding, ctx);
    if (!headersResult.ok) {
      if ('consent' in headersResult) {
        return mcpConsentPause(ctx, headersResult.consent);
      }
      return mcpCredentialFailure(ctx, headersResult.error, {
        bindingId: binding.bindingId,
        serverId: binding.serverId,
        bindingName: definition.name,
        reason: 'credential_unresolved',
      });
    }

    // Force a fresh connection for diagnostic — avoid reusing a stale pooled
    // entry that might have a different auth state.
    const key = poolKeyManaged(ctx.job.tenantId, binding.serverId, binding.bindingId, spaceId);
    await this.pool.remove(key);

    let entry: PoolEntry;
    try {
      entry = await this.acquireManaged(key, definition.serverUrl, headersResult.headers, {
        tenantId: ctx.job.tenantId,
        spaceId,
        serverId: binding.serverId,
        bindingId: binding.bindingId,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError || err instanceof DnsBlockedError) {
        return failureWithError(ctx, validationError(err.message));
      }
      return failureWithError(
        ctx,
        internalError(
          `Failed to connect to MCP server "${binding.serverId}" with binding "${bindingId}": ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true },
        ),
      );
    }

    let tools: McpCachedTool[];
    try {
      const result = await entry.client.listTools();
      tools = (result.tools ?? []).map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
      }));
    } catch (err) {
      await this.pool.remove(key);
      return failureWithError(
        ctx,
        internalError(
          `tools/list failed on server "${binding.serverId}": ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true },
        ),
      );
    }

    const pinnedOrigin = extractUrlOrigin(definition.serverUrl);
    const sessionMetadata: McpSessionMetadata = {
      ...(entry.transport.protocolVersion
        ? { protocolVersion: entry.transport.protocolVersion }
        : {}),
      ...(entry.serverInfo ? { serverInfo: entry.serverInfo } : {}),
      ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    };
    const cachedToolsAt = new Date().toISOString();

    const update: BindingCacheUpdate = {
      bindingId: binding.bindingId,
      serverId: binding.serverId,
      cachedTools: tools,
      cachedToolsAt,
      pinnedOrigin,
      sessionMetadata,
    };

    if (this.deps.db) {
      try {
        await this.writeBindingCacheUpdate(ctx.job.tenantId, spaceId, update);
      } catch (err) {
        return failureWithError(
          ctx,
          internalError(
            `Failed to persist binding cache update for "${bindingId}" in space "${spaceId}": ${err instanceof Error ? err.message : String(err)}`,
            { retryable: true },
          ),
        );
      }
    }

    if (binding.subscribeListChanged) {
      this.attachListChangedSubscription(
        entry,
        ctx.job.tenantId,
        spaceId,
        binding.serverId,
        binding.bindingId,
        definition.name,
        pinnedOrigin,
      );
    }

    if (this.deps.redis) {
      publishMcpCatalogInvalidation(this.deps.redis, ctx.job.tenantId, binding.scope.spaceId!, {
        kind: 'tool_cache',
        serverId: binding.serverId,
        bindingId: binding.bindingId,
      });
    }

    return await successWithData(ctx, {
      ok: true,
      bindingId: binding.bindingId,
      serverId: binding.serverId,
      tools,
      pinnedOrigin,
      sessionMetadata,
      cachedToolsAt,
    });
  }

  // --------------------------------------------------------------------------
  // Managed-path resolution helper
  // --------------------------------------------------------------------------

  private async resolveManaged(
    ctx: ExecutorContext,
    serverId: string,
    bindingIdHint?: string,
  ): Promise<
    | {
        ok: true;
        definition: McpServerDefinition;
        binding: McpServerBinding;
        headers: Record<string, string>;
        key: string;
        refreshed: boolean;
      }
    | { ok: false; failure: StepResult }
  > {
    const spaceId = (ctx.job as Record<string, unknown>)['spaceId'] as string | undefined;
    const flowId = (ctx.job as Record<string, unknown>)['flowId'] as string | undefined;
    if (!spaceId) {
      return {
        ok: false,
        failure: await failureWithError(
          ctx,
          validationError(
            `Cannot resolve managed MCP call — job has no spaceId. Integrations are space-scoped.`,
          ),
        ),
      };
    }

    await ensureSpaceLoaded(this.stores, { db: this.deps.db }, ctx.job.tenantId, spaceId);

    const resolution = resolveDefinitionAndBinding(
      this.stores,
      {
        tenantId: ctx.job.tenantId,
        ...(spaceId ? { spaceId } : {}),
        ...(flowId ? { flowId } : {}),
      },
      serverId,
      bindingIdHint,
    );

    if (!resolution.ok) {
      const failure = isCredentialResolutionReason(resolution.reason)
        ? await mcpCredentialFailure(ctx, resolution.message, {
            serverId,
            ...(bindingIdHint ? { bindingId: bindingIdHint } : {}),
            reason: resolution.reason,
          })
        : await failureWithError(ctx, validationError(resolution.message));
      return { ok: false, failure };
    }

    const { definition, binding } = resolution;

    const headersResult = await this.buildAuthHeaders(binding, ctx);
    if (!headersResult.ok) {
      if ('consent' in headersResult) {
        return { ok: false, failure: await mcpConsentPause(ctx, headersResult.consent) };
      }
      return {
        ok: false,
        failure: await mcpCredentialFailure(ctx, headersResult.error, {
          bindingId: binding.bindingId,
          serverId: binding.serverId,
          bindingName: definition.name,
          reason: 'credential_unresolved',
        }),
      };
    }

    // spaceId is guaranteed non-null here — resolveDefinitionAndBinding rejects
    // when it's missing (reason: 'no_space_id'), so we'd have returned above.
    return {
      ok: true,
      definition,
      binding,
      headers: headersResult.headers,
      key: poolKeyManaged(ctx.job.tenantId, serverId, binding.bindingId, spaceId),
      refreshed: headersResult.refreshed,
    };
  }

  private async buildAuthHeaders(
    binding: McpServerBinding,
    ctx: ExecutorContext,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<
    | { ok: true; headers: Record<string, string>; refreshed: boolean }
    | { ok: false; error: string }
    | { ok: false; consent: OAuthConsentRequestPayload }
  > {
    const headers: Record<string, string> = {};
    const auth = binding.auth;

    if (auth.type === 'none') {
      return { ok: true, headers, refreshed: false };
    }

    const spaceId =
      binding.scope.spaceId ??
      ((ctx.job as Record<string, unknown>)['spaceId'] as string | undefined);
    if (!spaceId) {
      return {
        ok: false,
        error: `Binding "${binding.bindingId}" credential resolution requires a spaceId on the job context.`,
      };
    }

    if (auth.type === 'bearer') {
      if (!auth.credentialKey) {
        return {
          ok: false,
          error: `Binding "${binding.bindingId}" bearer auth missing credentialKey`,
        };
      }
      const value = await this.decryptCredential(
        auth.credentialKey,
        binding.bindingId,
        ctx.job.tenantId,
        spaceId,
      );
      if (!value.ok) return { ok: false, error: value.error };
      headers['Authorization'] = `Bearer ${value.value}`;
      return { ok: true, headers, refreshed: false };
    }

    if (auth.type === 'header') {
      if (!auth.credentialKey) {
        return {
          ok: false,
          error: `Binding "${binding.bindingId}" header auth missing credentialKey`,
        };
      }
      const value = await this.decryptCredential(
        auth.credentialKey,
        binding.bindingId,
        ctx.job.tenantId,
        spaceId,
      );
      if (!value.ok) return { ok: false, error: value.error };
      headers[auth.headerName] = value.value;
      return { ok: true, headers, refreshed: false };
    }

    if (auth.type === 'oauth2_client_credentials') {
      // Schema marks these optional at install-time so a binding can be
      // created before credentials land. They MUST be set before the binding
      // becomes callable — fail with a clear message rather than passing
      // empty strings into the credential lookup.
      if (!auth.clientIdCredentialKey || !auth.clientSecretCredentialKey) {
        return {
          ok: false,
          error: `Binding "${binding.bindingId}" oauth2_client_credentials missing clientIdCredentialKey or clientSecretCredentialKey (auth_failed)`,
        };
      }
      try {
        const result = await getClientCredentialsToken({
          tenantId: ctx.job.tenantId,
          spaceId,
          bindingId: binding.bindingId,
          auth: {
            tokenEndpoint: auth.tokenEndpoint,
            clientIdCredentialKey: auth.clientIdCredentialKey,
            clientSecretCredentialKey: auth.clientSecretCredentialKey,
            ...(auth.scopes ? { scopes: auth.scopes } : {}),
          },
          credentialStore: getMcpSpaceStores(this.stores, ctx.job.tenantId, spaceId)
            .credentialStore,
          tenantPermittedHosts: tenantPolicyPermittedHosts(this.stores, {
            tenantId: ctx.job.tenantId,
            spaceId,
            serverId: binding.serverId,
            bindingId: binding.bindingId,
          }),
          // ioredis `Redis` has overloaded `set`; widen to the narrow
          // RedisLike surface the helper actually uses.
          ...(this.deps.redis
            ? { redis: this.deps.redis as unknown as ClientCredentialsRedisLike }
            : {}),
          ...(opts.forceRefresh ? { forceRefresh: true } : {}),
        });
        headers['Authorization'] = `Bearer ${result.accessToken}`;
        return { ok: true, headers, refreshed: result.refreshed };
      } catch (err) {
        return {
          ok: false,
          error: `Binding "${binding.bindingId}" oauth2_client_credentials failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (auth.type === 'oauth2_pkce' || auth.type === 'oauth2_cimd') {
      if (!this.deps.db) {
        return {
          ok: false,
          error: `Binding "${binding.bindingId}" ${auth.type} requires a database connection in the executor (oauth tokens persist in oauth_tokens).`,
        };
      }
      // Pinned identity resolution (Plan 185 D4): the binding's ownerScope
      // selects exactly one owner — `user` pins the run's credentialOwnerId,
      // never a fallback to the tenant. `needsConsent` (a user-scoped run with
      // no user identity) becomes a recoverable consent PAUSE, not a FAILED step.
      const credentialOwnerId = (ctx.job as Record<string, unknown>)['credentialOwnerId'] as
        string | undefined;
      const ownerResult = resolveOAuthOwner(binding.ownerScope, {
        ...(credentialOwnerId ? { userId: credentialOwnerId } : {}),
        spaceId,
        tenantId: ctx.job.tenantId,
      });
      if ('needsConsent' in ownerResult) {
        return {
          ok: false,
          consent: buildOAuthConsentRequest(binding, 'never_connected'),
        };
      }
      // We need a McpServerDefinition for PRM discovery in the refresh path.
      // Resolve it from the in-memory store (already loaded by ensureSpaceLoaded
      // upstream of any call into buildAuthHeaders).
      const definition = getMcpSpaceStores(
        this.stores,
        ctx.job.tenantId,
        spaceId,
      ).definitionStore.get(
        definitionStoreKey({ tenantId: ctx.job.tenantId, spaceId, serverId: binding.serverId }),
      );
      if (!definition) {
        return {
          ok: false,
          error: `Binding "${binding.bindingId}" cannot resolve OAuth token — definition "${binding.serverId}" not loaded in space "${spaceId}".`,
        };
      }
      const descriptor = buildMcpOAuthDescriptor(binding, definition);
      const target: OAuthBindingTarget = {
        integrationKind: 'mcp',
        resourceKey: binding.serverId,
        bindingId: binding.bindingId,
        ownerScope: binding.ownerScope,
        ownerId: ownerResult.ownerId,
        clientScope: binding.clientScope,
        issuerKey: descriptor.issuerKey,
        ...(binding.clientScope === 'platform'
          ? { platformClientId: descriptor.platformClientId }
          : {}),
      };
      try {
        const result = await getValidAccessToken({
          tenantId: ctx.job.tenantId,
          spaceId,
          target,
          discovery: descriptor.discovery,
          db: this.deps.db,
          ...(opts.forceRefresh ? { forceRefresh: true } : {}),
        });
        headers['Authorization'] = `${result.tokenType ?? 'Bearer'} ${result.accessToken}`;
        return { ok: true, headers, refreshed: result.refreshed };
      } catch (err) {
        const consentReason = oauthConsentReasonFromError(err);
        if (consentReason) {
          return { ok: false, consent: buildOAuthConsentRequest(binding, consentReason) };
        }
        return {
          ok: false,
          error: `Binding "${binding.bindingId}" ${auth.type} token resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Exhaustiveness check — every McpAuthProfile variant must be handled
    // above. If the schema grows a new auth type, the type-narrowing reaches
    // here with `never` and the unused expression flags it at compile time.
    const _exhaustive: never = auth;
    return {
      ok: false,
      error: `Binding "${binding.bindingId}" unknown auth type: ${(_exhaustive as { type?: string })?.type ?? 'unknown'}`,
    };
  }

  private async decryptCredential(
    credentialKey: string,
    bindingId: string,
    tenantId: string,
    spaceId: string,
  ): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    const encrypted = getMcpSpaceStores(this.stores, tenantId, spaceId).credentialStore.get(
      credentialKey,
    );
    if (!encrypted) {
      return {
        ok: false,
        error: `Credential "${credentialKey}" not found for binding "${bindingId}" in space "${spaceId}" — store it via the Integrations page (auth_failed)`,
      };
    }
    try {
      const value = await decryptCredentialAsync(encrypted);
      return { ok: true, value };
    } catch {
      return {
        ok: false,
        error: `Failed to decrypt credential "${credentialKey}" for binding "${bindingId}" — encryption key may have changed (auth_failed)`,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Connection acquisition
  // --------------------------------------------------------------------------

  /**
   * Managed-path connect: the serverUrl is space-authored, so SSRF-check it
   * before the handshake; when the binding's credentials ride the connect
   * headers, require https so they never travel cleartext. The raw
   * (dev-only, disabled in production) path connects via `acquire` directly.
   */
  private async acquireManaged(
    key: string,
    serverUrl: string,
    headers: Record<string, string>,
    guard: McpTenantGuardRef | null,
    ctx?: ExecutorContext,
  ): Promise<PoolEntry> {
    assertTenantPolicyPermitsConnect(this.stores, serverUrl, guard);
    if (Object.keys(headers).length > 0) {
      await validateCredentialedUrl(serverUrl);
    } else {
      await validateUrl(serverUrl, []);
    }
    return this.acquire(key, serverUrl, headers, ctx);
  }

  private async acquire(
    key: string,
    serverUrl: string,
    headers: Record<string, string>,
    ctx?: ExecutorContext,
  ): Promise<PoolEntry> {
    const cached = this.pool.get(key);
    if (cached) return cached;

    const clientCapabilities: { elicitation?: Record<string, unknown> } = {};
    if (this.deps.redis && this.deps.redisSubscriber && this.deps.executorInstanceId) {
      clientCapabilities.elicitation = {};
    }
    // The guard at the connect boundary checks the URL once; the transport then
    // opens its own connections for the life of the session, so without this
    // every request after the first is unchecked — and over http would resolve
    // the name again, which is the rebinding window the guard exists to close.
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: { headers },
      fetch: safeFetchImpl,
    });
    const client = new Client(
      { name: 'phoenix-mcp-executor', version: '1.0.0' },
      Object.keys(clientCapabilities).length > 0
        ? ({ capabilities: clientCapabilities } as ConstructorParameters<typeof Client>[1])
        : undefined,
    );
    await client.connect(transport as Parameters<Client['connect']>[0]);

    const serverInfo = client.getServerVersion();
    const capabilities = client.getServerCapabilities();

    const entry: PoolEntry = {
      client,
      transport,
      lastUsedMs: Date.now(),
      ...(serverInfo ? { serverInfo: serverInfo as unknown as Record<string, unknown> } : {}),
      ...(capabilities ? { capabilities: capabilities as unknown as Record<string, unknown> } : {}),
    };

    if (this.deps.redis && this.deps.redisSubscriber && this.deps.executorInstanceId) {
      this.attachElicitationHandler(entry, ctx);
    }

    this.pool.set(key, entry);
    return entry;
  }

  private attachElicitationHandler(entry: PoolEntry, ctxAtConnect?: ExecutorContext): void {
    const redis = this.deps.redis;
    const redisSubscriber = this.deps.redisSubscriber;
    const executorInstanceId = this.deps.executorInstanceId;
    if (!redis || !redisSubscriber || !executorInstanceId) return;

    // Idempotent re-attach — if a cleanup with the elicitation marker is
    // already on this entry, skip the install. Matters because `acquire`
    // returns a cached entry on the warm path without going through the
    // fresh-connect branch.
    if (entry.cleanups?.some((fn) => (fn as { _kind?: string })._kind === 'elicitation')) {
      return;
    }

    entry.client.setRequestHandler(ElicitRequestSchema, async (req) => {
      // Normalize the SDK's discriminated union into Phoenix's
      // `McpElicitationRequest` shape. The SDK params are stricter than
      // ours (full JSON-Schema-of-schemas); pass through what we know.
      //
      // We ALWAYS mint a Phoenix-side `elicitationId` rather than honor
      // `params.elicitationId` from the server. The server-supplied id is
      // only required to be unique within the originating server's own
      // namespace (it could be a per-server counter, a per-session id,
      // etc.). The lease key + response channel are global Redis keys —
      // honoring a non-globally-unique server id would let two concurrent
      // elicitations (across servers, tenants, or even within one tenant
      // with two bindings to the same upstream) collide, triggering
      // `lease_conflict` decline on the second flow.
      //
      // Phoenix doesn't echo the elicitationId back to the server (the
      // JSON-RPC request id correlates the response) and doesn't register
      // a handler for `notifications/elicitation/complete`, so dropping
      // the server's value here has no protocol-level effect.
      const params = req.params;
      const normalized: Record<string, unknown> = {
        mode: params.mode === 'url' ? 'url' : 'form',
        elicitationId: randomUUID(),
        message: params.message,
        ...(params.task?.ttl ? { ttlMs: params.task.ttl } : {}),
      };
      if (params.mode === 'url') {
        normalized['url'] = params.url;
      } else {
        normalized['requestedSchema'] = params.requestedSchema as Record<string, unknown>;
      }
      const parsed = McpElicitationRequestSchema.safeParse(normalized);
      if (!parsed.success) {
        // Server sent a request shape we don't understand — best to
        // decline rather than send something the server might mis-parse.
        return { action: 'decline' };
      }
      const request = parsed.data;

      // Correlate by inflight context. Single inflight wins; multi-inflight
      // without `_meta.related-task` is ambiguous → decline politely so
      // the server can retry once the others finish.
      const inflights = Array.from(entry.inflightCalls?.values() ?? []);
      if (inflights.length === 0) {
        ctxAtConnect?.log.warn(
          `[mcp-elicitation] received elicitation/create with no inflight tool call — declining`,
        );
        return { action: 'decline' };
      }
      if (inflights.length > 1) {
        ctxAtConnect?.log.warn(
          `[mcp-elicitation] received elicitation/create with ${String(inflights.length)} concurrent inflight calls — cannot correlate, declining (v1 limitation)`,
        );
        return { action: 'decline' };
      }
      const inflight = inflights[0]!;

      // Bind the suspend handler to this entry's abort registry so a
      // pool eviction (LRU, binding invalidation, force-tear) wakes us
      // with `lease_lost` before the SDK transport closes.
      entry.inflightAborters ??= new Set();

      const outcome = await suspendForElicitation({
        request,
        tenantId: inflight.tenantId,
        spaceId: inflight.spaceId,
        stepExecutionId: inflight.stepExecutionId,
        bindingId: inflight.bindingId,
        serverId: inflight.serverId,
        ...(inflight.sessionId ? { sessionId: inflight.sessionId } : {}),
        executorInstanceId,
        leaseTtlMs: inflight.elicitationLeaseMs,
        redis,
        redisSubscriber,
        // The slotController is the one bound to the current job — captured
        // when this call was registered (see registerInflightCall). The
        // handler at connect time may not be the holder of the currently-
        // active slot; the inflight ctx is the right source.
        ...(inflight.slotController ? { slotController: inflight.slotController } : {}),
        abortRegistry: entry.inflightAborters,
        log: {
          info: (msg, meta) => ctxAtConnect?.log.info(msg, meta as Record<string, unknown>),
          warn: (msg, meta) => ctxAtConnect?.log.warn(msg, meta as Record<string, unknown>),
        },
      });

      return outcomeToElicitResult(outcome);
    });

    // Register a cleanup so pool eviction tears the handler off the
    // client. Without this, `runCleanup` would close the transport but
    // the JSON-RPC dispatcher would still carry our stale handler if the
    // SDK is ever pooled again (it isn't today, but the contract should
    // be self-cleaning regardless).
    const elicitationMethod = ElicitRequestSchema.shape.method.value;
    const elicitationCleanup = Object.assign(
      (): void => {
        try {
          entry.client.removeRequestHandler(elicitationMethod);
        } catch {
          /* best-effort */
        }
      },
      { _kind: 'elicitation' as const },
    );
    (entry.cleanups ??= []).push(elicitationCleanup);
  }

  private attachListChangedSubscription(
    entry: PoolEntry,
    tenantId: string,
    spaceId: string,
    serverId: string,
    bindingId: string,
    serverName: string,
    pinnedOrigin: string,
  ): void {
    // The list_changed cleanup tags itself with a string marker so a
    // re-attach is idempotent — multiple `acquire()` calls on the same
    // cached entry must not register the handler twice.
    if (entry.cleanups?.some((fn) => (fn as { _kind?: string })._kind === 'list_changed')) {
      return;
    }

    const toolsCapability =
      (entry.capabilities?.['tools'] as Record<string, unknown> | undefined) ?? undefined;
    const supportsListChanged = toolsCapability?.['listChanged'] === true;
    if (!supportsListChanged) {
      console.info(
        `[mcp] binding="${bindingId}" server="${serverName}" does not advertise tools.listChanged — skipping push subscription (will rely on TTL-based stale check).`,
      );
      return;
    }

    const handler = async (): Promise<void> => {
      try {
        const result = await entry.client.listTools();
        const tools = (result.tools ?? []).map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
        }));
        const cachedToolsAt = new Date().toISOString();
        const sessionMetadata: McpSessionMetadata = {
          ...(entry.transport.protocolVersion
            ? { protocolVersion: entry.transport.protocolVersion }
            : {}),
          ...(entry.serverInfo ? { serverInfo: entry.serverInfo } : {}),
          ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
        };

        if (this.deps.db) {
          // pinnedOrigin is the value the binding was pinned to at consent /
          // mcp.binding.test time. list_changed never moves the URL — passing
          // the existing pin through writes the same value back.
          await this.writeBindingCacheUpdate(tenantId, spaceId, {
            bindingId,
            serverId,
            cachedTools: tools,
            cachedToolsAt,
            pinnedOrigin,
            sessionMetadata,
          });
        }
        if (this.deps.redis) {
          publishMcpCatalogInvalidation(this.deps.redis, tenantId, spaceId, {
            kind: 'tool_cache',
            serverId,
            bindingId,
          });
        }

        console.info(
          `[mcp] list_changed: refreshed cache for binding="${bindingId}" server="${serverName}" tools=${String(tools.length)}`,
        );
      } catch (err) {
        console.warn(
          `[mcp] list_changed refresh failed for binding="${bindingId}" server="${serverName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    entry.client.setNotificationHandler(ToolListChangedNotificationSchema, handler);
    // Derive the method literal from the schema so a future SDK rename can't
    // silently no-op cleanup (would leak the handler until the entry is freed).
    const methodName = ToolListChangedNotificationSchema.shape.method.value;
    const listChangedCleanup = Object.assign(
      (): void => {
        try {
          entry.client.removeNotificationHandler(methodName);
        } catch {
          /* best-effort */
        }
      },
      { _kind: 'list_changed' as const },
    );
    (entry.cleanups ??= []).push(listChangedCleanup);
  }

  // --------------------------------------------------------------------------
  // DB writes (cache + pin updates)
  // --------------------------------------------------------------------------

  private async writeBindingCacheUpdate(
    tenantId: string,
    spaceId: string,
    update: BindingCacheUpdate,
  ): Promise<void> {
    if (!this.deps.db) return;
    const tenantCtx = createTenantContext(TenantIdSchema.parse(tenantId));

    await withTenantSchema(
      this.deps.db as Parameters<typeof withTenantSchema>[0],
      tenantCtx,
      async (tx) => {
        await tx.execute(sql`
          UPDATE mcp_server_bindings
          SET cached_tools = ${JSON.stringify(update.cachedTools)}::jsonb,
              cached_tools_at = ${update.cachedToolsAt}::timestamptz,
              pinned_origin = ${update.pinnedOrigin},
              session_metadata_json = ${JSON.stringify(update.sessionMetadata)}::jsonb,
              updated_at = NOW()
          WHERE binding_id = ${update.bindingId}
            AND space_id = ${spaceId}::uuid
        `);
      },
    );
  }

  private async writeBindingPin(
    tenantId: string,
    spaceId: string,
    bindingId: string,
    pinnedOrigin: string,
  ): Promise<void> {
    if (!this.deps.db) return;
    const tenantCtx = createTenantContext(TenantIdSchema.parse(tenantId));

    await withTenantSchema(
      this.deps.db as Parameters<typeof withTenantSchema>[0],
      tenantCtx,
      async (tx) => {
        await tx.execute(sql`
          UPDATE mcp_server_bindings
          SET pinned_origin = ${pinnedOrigin}, updated_at = NOW()
          WHERE binding_id = ${bindingId}
            AND space_id = ${spaceId}::uuid
            AND pinned_origin IS NULL
        `);
      },
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

function registerInflightCall(entry: PoolEntry, call: InflightMcpCall): string {
  const tag = randomUUID();
  if (!entry.inflightCalls) entry.inflightCalls = new Map();
  entry.inflightCalls.set(tag, call);
  return tag;
}

function deregisterInflightCall(entry: PoolEntry, tag: string): void {
  entry.inflightCalls?.delete(tag);
}

/**
 * True when the binding's auth profile is one of the OAuth flavors that
 * `buildAuthHeaders` resolves through the token manager. Used to gate the
 * reactive 401 retry — non-OAuth bindings (bearer/header) cannot rotate
 * credentials on the fly; a 401 there is a real failure.
 */
export function resolveCallToolTimeoutMs(
  baseTimeoutMs: number,
  elicitationLeaseMs: number,
): number {
  const ELICITATION_RESPONSE_BUFFER_MS = 30_000;
  return Math.max(baseTimeoutMs, elicitationLeaseMs + ELICITATION_RESPONSE_BUFFER_MS);
}

function mcpCredentialFailure(
  ctx: ExecutorContext,
  message: string,
  block: McpCredentialBlock,
): Promise<StepResult> {
  return failureWithError(ctx, mcpCredentialsError(message, block));
}

export function isOAuthBinding(binding: McpServerBinding): boolean {
  return (
    binding.auth.type === 'oauth2_pkce' ||
    binding.auth.type === 'oauth2_cimd' ||
    binding.auth.type === 'oauth2_client_credentials'
  );
}

/**
 * Transport-level 401 detection — gates the reactive OAuth retry path.
 *
 * Strictly biased toward false-negatives. The cost of a missed 401 is one
 * user-visible failure; the cost of a false-positive is a refresh storm
 * against the AS plus pool churn for every application-level error whose
 * message happens to contain "unauthorized" (e.g. "User unauthorized to
 * view this competition" from a tool result). We match ONLY:
 *
 *   - Structured numeric status: `code` / `status` / `statusCode` === 401
 *   - HTTP-tagged messages: `HTTP 401`, `HTTP/1.1 401`, etc.
 *
 * We deliberately do NOT match bare "unauthorized" or "invalid_token" in
 * the message string — those leak through from application-layer errors.
 * If a transport stops setting a numeric field and only emits a bare
 * keyword, we'll miss the retry once and surface a real auth_failed error.
 * That's the safer failure mode.
 */
export function isUnauthorizedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  if (e.code === 401 || e.status === 401 || e.statusCode === 401) return true;
  // `err` is `object` per the guard above; only its `message` field can
  // be meaningfully stringified. Anything else just falls through to the
  // false branch — better than a `[object Object]` test that's
  // guaranteed not to match.
  const msg = typeof e.message === 'string' ? e.message : '';
  // Match `HTTP 401`, `HTTP/1.1 401`, `status 401`, etc. — explicit
  // HTTP-status framing only.
  return /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s*code)?)\s*[:=]?\s*401\b/i.test(msg);
}

/** The mapped tool-result envelope that becomes the op output (`McpToolCallOutput`). */
export interface MappedToolResult {
  content: Array<Record<string, string>>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function mapToolResult(result: {
  content?: unknown;
  isError?: boolean | undefined;
  structuredContent?: unknown;
}): MappedToolResult {
  const toStr = (v: unknown): string =>
    typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : String((v ?? '') as string | number | boolean);
  const content = Array.isArray(result.content)
    ? (result.content as Array<Record<string, unknown>>).map((c) => ({
        type: toStr(c['type'] ?? 'text'),
        ...(c['text'] != null ? { text: toStr(c['text']) } : {}),
        ...(c['data'] != null ? { data: toStr(c['data']) } : {}),
        ...(c['mimeType'] != null ? { mimeType: toStr(c['mimeType']) } : {}),
      }))
    : [];
  const structuredContent =
    result.structuredContent !== null &&
    typeof result.structuredContent === 'object' &&
    !Array.isArray(result.structuredContent)
      ? (result.structuredContent as Record<string, unknown>)
      : undefined;
  return {
    content,
    ...(result.isError ? { isError: true } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

// MCP protocol: a tool call returns 200-OK shaped `{ content, isError: true }`
// when the tool itself errors (auth, rate limit, invalid input, business
// logic). Pre-fix the executor treated that as success because the dispatch
// returned without throwing — so the step finished `succeeded` with an error
// payload, eval criteria couldn't measure anything, and downstream tasks
// (and learnings) processed garbage as if the call had worked.
//
// `result.isError === true` → route as a provider failure (classification
// 'provider', non-retryable by default — these are application errors, not
// transient transport faults; the skill / agent decides whether to retry).
// The original content array is preserved in `details.content` so the agent
// next turn or the operator inspecting the task can see what the server said.
export function routeToolResult(
  ctx: ExecutorContext,
  toolName: string,
  mapped: MappedToolResult,
  /**
   * The arguments we passed to the tool.
   * When `isError: true` and the server's text is opaque (e.g. Kaggle MCP
   * returns "An error occurred invoking 'X'" with no detail), the only
   * actionable info left is "what did we send?" — recording it on the
   * failure means the operator can compare against the tool's documented
   * schema to spot a missing required arg without running a separate
   * `mcp.tool.list` diagnostic. Plain JSON, truncated to a sensible cap
   * so a huge `fileContent` doesn't bloat the error payload.
   * Optional for call sites that don't have args in scope (e.g. legacy
   * paths) — those keep the old behaviour.
   */
  sentArgs?: Record<string, unknown>,
): Promise<StepResult> {
  if (!mapped.isError) {
    return successWithData(ctx, mapped);
  }
  const firstText = mapped.content.find((c) => c['type'] === 'text')?.['text'];
  const message = firstText
    ? `MCP tool "${toolName}" returned isError=true: ${firstText}`
    : `MCP tool "${toolName}" returned isError=true with no text content`;
  // Surface a list of the keys we sent so the operator can spot a missing
  // required arg at a glance; the truncated args themselves go in details.
  const sentArgKeys = sentArgs ? Object.keys(sentArgs).sort() : [];
  const friendlyMessage =
    sentArgKeys.length > 0 ? `${message} (sent args keys: ${sentArgKeys.join(', ')})` : message;
  return failureWithError(
    ctx,
    providerError(friendlyMessage, {
      retryable: false,
      details: {
        toolName,
        content: mapped.content,
        ...(sentArgs ? { sentArgs: truncateArgsForError(sentArgs) } : {}),
      },
    }),
  );
}

/**
 * Truncate large string fields in tool-call args so the error payload
 * stays under reasonable size. Keeps the first 200 chars + "…" for any
 * string field over 200 chars; preserves everything else as-is.
 * Recurses one level into objects.
 */
function truncateArgsForError(args: Record<string, unknown>): Record<string, unknown> {
  const CAP = 200;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > CAP) {
      out[k] = `${v.slice(0, CAP)}… (truncated; full length ${String(v.length)})`;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        inner[ik] =
          typeof iv === 'string' && iv.length > CAP
            ? `${iv.slice(0, CAP)}… (truncated; full length ${String(iv.length)})`
            : iv;
      }
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}
