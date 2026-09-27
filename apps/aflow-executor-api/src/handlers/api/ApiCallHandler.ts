/**
 * API step handler v2 — executes HTTP API calls.
 *
 * - Scope-aware Definition/Binding resolution (flowId > spaceId)
 * - DNS-pinned fetch (resolved IP is used for the actual connection — no TOCTOU)
 * - SSRF/egress guardrails (private IP blocking, DNS rebinding defense)
 * - Sensitive header redaction
 * - Response budget enforcement with PayloadStore dataRef for large responses
 * - Retry with exponential backoff (idempotent methods only by default)
 * - Redirect safety (no cross-host by default)
 * - Simulated fulfillment: a binding that names a simulation is answered from
 *   its own world, reads no credential and reaches no host
 *
 * Also supports dev-only "direct URL mode" when ALLOW_UNSAFE_DIRECT_URL=true.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  validationError,
  internalError,
  pausedWithRequest,
  successWithData,
} from '@aflow/executor-runtime';
import type { AflowError } from '@aflow/schemas';
import {
  ApiCallInputSchema,
  ApiHttpDownloadInputSchema,
  SIMULATED_PROVENANCE,
} from '@aflow/schemas';
import type { ApiCallInput } from '@aflow/schemas';
import type { Redis } from '@aflow/redis';
import { ALLOW_UNSAFE_DIRECT_URL } from './config.js';
import { resolveCall } from './resolution.js';
import { executeWithRetry, fetchWithRetry, type ExecuteOpts } from './execution.js';
import {
  API_HTTP_DOWNLOAD_OPERATION_ID,
  buildDownloadApiCallInput,
  mapDownloadOutput,
} from './download.js';
import { handleExecutionError } from './errors.js';
import { createTenantPolicyCache } from '@aflow/database';
import { invalidateSpaceCache } from './spaceLoader.js';
import { resolveBodyFromMemory, buildContentRangeHeader } from './bodyFromPath.js';
import { ApiExecutionError, spaceScopeKey, type ApiHandlerStores } from './types.js';
import { ApiOAuthConsentRequired } from './oauth2AuthCode.js';
import { ApiWriteApprovalRequired, enforceWriteApprovalGate } from './writeApprovalGate.js';
import { validateEndpointBody } from './validateBody.js';
import { processResponse } from './response.js';
import { executeSimulatedCall, toSimulatedFetchResponse } from './simulation/execute.js';
import { hashResponseBody, writeSourceEvidence } from './sourceEvidence.js';

export class ApiCallHandler implements StepHandler {
  readonly stepType = 'api';

  private readonly stores: ApiHandlerStores = {
    definitionStore: new Map(),
    invalidDefinitions: new Map(),
    bindingStore: new Map(),
    credentialStore: new Map<string, Map<string, string>>(),
    loadedAtMs: new Map(),
    loadPromises: new Map(),
    tenantPolicyCache: createTenantPolicyCache({
      onLoadError: (tenantId, err) => {
        console.warn(
          `[spaceLoader] Failed to load integration policy for tenant ${tenantId}: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'Keeping the last-known-good policy (open only if never loaded).',
        );
      },
    }),
    catalogGrantStore: new Map(),
    spaceWritePolicyStore: new Map(),
    simulationStore: new Map(),
    simulationLoadPromises: new Map(),
    simulationSnapshotStore: new Map(),
  };

  constructor(
    private opts?: { db?: unknown; redis?: unknown; payloadStore?: unknown; cacheTtlMs?: number },
  ) {}

  invalidateSpace(tenantId: string, spaceId: string): void {
    invalidateSpaceCache(this.stores, tenantId, spaceId);
  }

  private parseInput(ctx: ExecutorContext, raw: unknown): ApiCallInput {
    // api.http.download is a narrowing of api.http.call: parse its
    // destination-mandated schema, then synthesize the equivalent call with
    // `saveTo` forced so the rest of the handler is op-agnostic.
    if (ctx.job.operationId === API_HTTP_DOWNLOAD_OPERATION_ID) {
      return buildDownloadApiCallInput(ApiHttpDownloadInputSchema.parse(raw));
    }
    return ApiCallInputSchema.parse(raw);
  }

  async validate(ctx: ExecutorContext): Promise<AflowError | null> {
    const input = await ctx.readPayload(ctx.job.inputRef);
    try {
      const parsed = this.parseInput(ctx, input);
      if (parsed.url && (!parsed.bindingId || !parsed.apiId) && !ALLOW_UNSAFE_DIRECT_URL) {
        return validationError(
          'Direct URL mode requires apiId + bindingId + url (binding-allowlisted). Provide all three for direct URL, or apiId + endpointId for registered-endpoint mode.',
        );
      }
      return null;
    } catch (err) {
      return validationError(err instanceof Error ? err.message : String(err));
    }
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const inputRaw = await ctx.readPayload(ctx.job.inputRef);
    const isDownload = ctx.job.operationId === API_HTTP_DOWNLOAD_OPERATION_ID;
    const input = this.parseInput(ctx, inputRaw);

    try {
      const resolved = await resolveCall(this.stores, this.opts ?? {}, ctx, input);
      // The account of what answered this call, declared the moment fulfillment
      // is known and before anything can pause, fail or throw. Everything the
      // run reports about being a rehearsal is read from here — a step's own
      // dispatch metadata predates this resolution and can disagree with it.
      if (resolved.simulation) {
        ctx.reportSimulatedFulfillment?.({
          bindingId: resolved.simulation.bindingId,
          simulationId: resolved.simulation.simulationId,
        });
      }
      const db = this.opts?.db as PostgresJsDatabase | undefined;
      const payloadStore = this.opts?.payloadStore as PayloadStore | undefined;
      const redis = this.opts?.redis as Redis | undefined;

      if (input.response.saveTo) {
        if (!db || !payloadStore) {
          throw new ApiExecutionError(
            internalError(
              'response.saveTo requires database + payload store access (server misconfiguration).',
              { retryable: false },
            ),
          );
        }
        if (!ctx.job.spaceId) {
          throw new ApiExecutionError(
            internalError('response.saveTo requires a space context.', { retryable: false }),
          );
        }
      }

      if (input.bodySource?.fromPath) {
        const spaceId = ctx.job.spaceId;
        if (!db || !payloadStore) {
          // Server misconfiguration (deps not wired) — NOT a bad caller path.
          throw new ApiExecutionError(
            internalError(
              'bodySource.fromPath requires database + payload store access (server misconfiguration).',
              { retryable: false },
            ),
          );
        }
        if (!spaceId) {
          throw new ApiExecutionError(
            internalError('bodySource.fromPath requires a space context.', { retryable: false }),
          );
        }
        // The schema refine forbids top-level `body` + `bodySource`, but a
        // registered-endpoint call can also derive a body from `params` via
        // extractBody(). Fail clearly rather than silently overriding it.
        if (resolved.body !== undefined) {
          throw new ApiExecutionError(
            validationError(
              'bodySource.fromPath cannot be combined with a request body derived from params/body. ' +
                'Provide exactly one body source.',
            ),
          );
        }
        const { bytes, mimeType } = await resolveBodyFromMemory({
          db,
          payloadStore,
          tenantId: ctx.tenantId,
          spaceId,
          fromPath: input.bodySource.fromPath,
          maxBytes: resolved.egressPolicy.maxRequestBodyBytes,
        });
        resolved.body = bytes;
        // Content-Type precedence: explicit caller header wins; otherwise the
        // Memory doc's mimeType labels the body.
        if (mimeType && !resolved.headers['Content-Type'] && !resolved.headers['content-type']) {
          resolved.headers['Content-Type'] = mimeType;
        }

        if (input.bodySource.emitContentRange) {
          const existing = Object.keys(resolved.headers).find(
            (k) => k.toLowerCase() === 'content-range',
          );
          if (existing) {
            throw new ApiExecutionError(
              validationError(
                'bodySource.emitContentRange conflicts with a Content-Range header from the ' +
                  'API definition/binding default headers — remove one (one source of truth).',
              ),
            );
          }
          resolved.headers['Content-Range'] = buildContentRangeHeader(bytes.length);
          // Content-Length needs no explicit handling: undici computes it
          // from Buffer bodies (verified — no chunked transfer-encoding).
        }
      }

      // Call-time body-schema backstop (Plan 253 §P0): a raw api.http.call or
      // operation-task call reaches here unvalidated (Plan 210 only covers
      // promoted agent tools) — reject a schema-invalid body before it is sent
      // or pauses for approval.
      if (resolved.endpoint) {
        const bodyErr = validateEndpointBody(resolved.endpoint, resolved.body);
        if (bodyErr) throw new ApiExecutionError(bodyErr);
      }

      // Gate a resolved write against its endpoint's risk tier, AFTER the body
      // is fully resolved (params-derived and bodySource bytes loaded) so the
      // approval preview and requestHash cover the exact bytes that will be
      // sent — a gated call with no matching approval parks as a
      // `write_approval` PAUSE before any HTTP side effect (Plan 253). The
      // space's write-policy override (loaded with the space slice) composes
      // with the tier default via requiresWriteApproval.
      const spaceWritePolicy = ctx.job.spaceId
        ? (this.stores.spaceWritePolicyStore.get(spaceScopeKey(ctx.tenantId, ctx.job.spaceId)) ??
          null)
        : null;
      // Ahead of the simulated branch deliberately: `writeRiskTier` is a
      // property of the endpoint and the endpoint is the same object either
      // way, so a simulated high-tier write raises the same Action Center card
      // a real one does. That card IS the control in production, so an agent
      // rehearsed without it was not rehearsed. An unattended run that cannot
      // answer one lowers the tier through the space's write policy rather
      // than through fulfillment.
      await enforceWriteApprovalGate(ctx, resolved, redis, spaceWritePolicy);

      const executeOpts: ExecuteOpts = {
        ...(db ? { db } : {}),
        ...(payloadStore ? { payloadStore } : {}),
        ...(redis ? { redis } : {}),
      };

      // A simulated binding answers from its own world instead of the network,
      // then rejoins the live path at the response boundary — so the transform,
      // the inline/PayloadRef split and saveTo behave exactly as they will
      // against the real service.
      if (resolved.simulation) {
        if (!db || !payloadStore || !redis) {
          throw new ApiExecutionError(
            internalError(
              'A simulated call requires database, payload store and Redis access (server misconfiguration).',
              { retryable: false },
            ),
          );
        }
        const simulated = await executeSimulatedCall(ctx, resolved, {
          stores: this.stores,
          input,
          db,
          payloadStore,
          redis,
          ...(this.opts?.cacheTtlMs !== undefined ? { cacheTtlMs: this.opts.cacheTtlMs } : {}),
        });
        const simulatedResult = await processResponse(
          ctx,
          input,
          toSimulatedFetchResponse(simulated),
          simulated.delayMs ?? 0,
          resolved.url,
          resolved,
          executeOpts,
        );
        // Evidence on the same terms the live path files it, marked for what it
        // is. Skipping it here would make the simulated run behave unlike the
        // one that ships — the agent would receive no `sourceEvidenceRef` to
        // cite, and the provenance record a later reader needs would not exist.
        const evidence =
          ctx.job.spaceId !== undefined && simulatedResult.statusCode < 400
            ? await writeSourceEvidence({
                db,
                tenantId: ctx.tenantId,
                spaceId: ctx.job.spaceId,
                runId: ctx.runId,
                apiId: resolved.simulation.apiId,
                bindingId: resolved.simulation.bindingId,
                endpointId: resolved.endpoint?.endpointId ?? 'unknown',
                responseStatus: simulatedResult.statusCode,
                provenance: SIMULATED_PROVENANCE,
                ...(simulatedResult.data !== undefined
                  ? { responseHash: hashResponseBody(simulatedResult.data) ?? '' }
                  : {}),
              })
            : null;
        const simulatedOutput = evidence?.ok
          ? { ...simulatedResult, sourceEvidenceRef: evidence.callId }
          : simulatedResult;
        const simulatedData = isDownload ? mapDownloadOutput(simulatedOutput) : simulatedOutput;
        // Generation spends real tokens, so a simulated call reports them the
        // way every other model-spending step does — durable `costJson` on the
        // step result, not an in-memory usage recorder.
        return simulated.usage === undefined
          ? await successWithData(ctx, simulatedData)
          : await successWithData(ctx, simulatedData, { costJson: simulated.usage });
      }

      if (isDownload) {
        const data = await fetchWithRetry(ctx, input, resolved, executeOpts);
        return await successWithData(ctx, mapDownloadOutput(data));
      }
      return await executeWithRetry(ctx, input, resolved, executeOpts);
    } catch (error) {
      // 3-legged OAuth with no usable owner token is recoverable: park the
      // step as the same `oauth_consent` PAUSE the MCP executor uses (Plan 185
      // §9.3) rather than FAILing — the OAuth callback resumes it.
      if (error instanceof ApiOAuthConsentRequired) {
        return await pausedWithRequest(ctx, error.consent);
      }
      if (error instanceof ApiWriteApprovalRequired) {
        return await pausedWithRequest(ctx, error.request);
      }
      return await handleExecutionError(ctx, error);
    }
  }
}
