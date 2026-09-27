import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  permissionError,
  validationError,
  internalError,
} from '@aflow/executor-runtime';
import {
  ComputeExecInputSchema,
  SpaceComputePolicySchema,
  type ComputeExecInput,
  type SpaceComputePolicy,
} from '@aflow/schemas';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  createTenantContext,
  withTenantSchema,
  spaces,
  createMemoryDocRepository,
  createMemoryDirRepository,
  createComputeBudgetLimitsLoader,
  type ComputeBudgetLimitsView,
} from '@aflow/database';
import { reserveComputeSeconds, settleComputeSeconds } from '@aflow/redis';
import type { Redis as IORedis } from 'ioredis';
import {
  isVirtualPath,
  resolveMemoryPath,
  MemoryPathError,
  type PathResolveContext,
  type ToolOutputIndex,
} from '@aflow/memory-paths';

import {
  type ContainerRunner,
  type ContainerRunRequest,
  type ContainerRunResult,
  DockerRunner,
  getImageForRuntime,
  buildCommand,
  resolveEffectiveLimits,
  MAX_INLINE_OUTPUT_BYTES,
} from './containerRunner.js';
import { type SessionManager, makeSessionKey } from './sessionManager.js';
import { buildTimeoutTeaching, type TimeoutSource } from './timeoutTeaching.js';
import {
  type WorkspaceManager,
  WorkspaceError,
  DEFAULT_WORKSPACE_QUOTAS,
  type WorkspaceQuotas,
  type WorkspaceStatus,
  type FlushResult,
} from './workspaceManager.js';
import {
  runEphemeralWorkspaceExec,
  applyEphemeralFlushToOutput,
  missingFileOutputs,
  buildCleanExitContractFailure,
} from './ephemeralWorkspace.js';
import { WORKSPACE_MANIFEST_DEFAULT_TTL_SECONDS } from '@aflow/redis';

/** Max preview size when output is truncated (bytes). */
const PREVIEW_BYTES = 500;

// ============================================================================

/**
 * Semantic resource presets. Applied before resolveEffectiveLimits, then capped by policy.
 * Explicit limits in input override preset values.
 */
const RUNTIME_PRESETS: Record<
  string,
  { timeoutSeconds: number; memoryMB: number; cpuCores: number }
> = {
  quick: { timeoutSeconds: 60, memoryMB: 256, cpuCores: 0.5 },
  standard: { timeoutSeconds: 180, memoryMB: 512, cpuCores: 1 },
  'ml-training': { timeoutSeconds: 1800, memoryMB: 4096, cpuCores: 2 },
};

/** Schema default for limits.timeoutSeconds (mirrors ComputeExecInputSchema). */
const DEFAULT_TIMEOUT_SECONDS = 180;
/** Schema hard cap on limits.timeoutSeconds — the largest inner wall-clock possible. */
const MAX_TIMEOUT_SECONDS = 3600;

/**
 * Slack added to the sandbox's own docker wall-clock to size the executor-level
 * (outer) timeout and the watchdog's zombie-reap deadline. Must cover docker
 * stop-grace + output read + workspace flush + result emission + stream latency,
 * so the OUTER guard never reaps before the inner timer returns its graceful
 * exitCode-124 timeout result.
 */
const OUTER_TIMEOUT_MARGIN_MS = 60_000;

/**
 * Mirrors applyPreset's timeout precedence: a present `limits` object governs
 * (Zod fills its timeoutSeconds default), else the preset, else the default.
 */
function resolveTimeoutSource(input: ComputeExecInput): TimeoutSource {
  if (input.limits !== undefined) {
    return { kind: 'explicit', requestedSeconds: input.limits.timeoutSeconds };
  }
  const preset =
    input.runtimePreset !== undefined ? RUNTIME_PRESETS[input.runtimePreset] : undefined;
  if (input.runtimePreset !== undefined && preset !== undefined) {
    return {
      kind: 'preset',
      presetName: input.runtimePreset,
      presetSeconds: preset.timeoutSeconds,
    };
  }
  return { kind: 'default', defaultSeconds: DEFAULT_TIMEOUT_SECONDS };
}

/**
 * Apply runtime preset defaults, then overlay explicit limits.
 * Returns the merged limits object ready for resolveEffectiveLimits.
 */
function applyPreset(
  presetName: string | undefined,
  inputLimits: ComputeExecInput['limits'],
): ComputeExecInput['limits'] {
  if (!presetName) return inputLimits;

  const preset = RUNTIME_PRESETS[presetName];
  if (!preset) return inputLimits;

  return {
    timeoutSeconds: inputLimits?.timeoutSeconds ?? preset.timeoutSeconds,
    memoryMB: inputLimits?.memoryMB ?? preset.memoryMB,
    cpuCores: inputLimits?.cpuCores ?? preset.cpuCores,
    maxOutputBytes: inputLimits?.maxOutputBytes ?? 1_000_000,
  };
}

// ============================================================================
// Handler
// ============================================================================

export interface ComputeExecHandlerOptions {
  db?: PostgresJsDatabase | undefined;
  runner?: ContainerRunner | undefined;
  sessionManager?: SessionManager | undefined;
  redis?: IORedis | undefined;
  workspaceManager?: WorkspaceManager | undefined;
}

export class ComputeExecHandler implements StepHandler {
  readonly stepType = 'compute';

  private readonly db: PostgresJsDatabase | undefined;
  private readonly runner: ContainerRunner;
  private readonly redis: IORedis | undefined;
  private readonly sessionManager: SessionManager | undefined;
  private readonly workspaceManager: WorkspaceManager | undefined;
  private readonly loadBudgetLimits:
    ((tenantId: string) => Promise<ComputeBudgetLimitsView>) | undefined;

  constructor(opts?: ComputeExecHandlerOptions) {
    this.db = opts?.db;
    this.runner = opts?.runner ?? new DockerRunner();
    this.sessionManager = opts?.sessionManager;
    this.redis = opts?.redis;
    this.workspaceManager = opts?.workspaceManager;
    this.loadBudgetLimits = opts?.db ? createComputeBudgetLimitsLoader(opts.db) : undefined;
  }

  /**
   * The sandbox self-enforces its wall-clock with its OWN docker `--stop-timeout`
   * (limits.timeoutSeconds, possibly via runtimePreset). The executor-level outer
   * timeout must exceed that, or processJob's withTimeout — and the watchdog reap
   * deadline derived from it — kills the step before the container's graceful
   * timeout can return. Space policy only LOWERS the inner cap, so an upper bound
   * from the input alone is always safe and skips loading policy on this path.
   */
  async resolveTimeoutMs(ctx: ExecutorContext): Promise<number | undefined> {
    const rawInput = await ctx.readPayload(ctx.job.inputRef);
    const parsed = ComputeExecInputSchema.safeParse(rawInput);
    if (!parsed.success) return undefined;
    const merged = applyPreset(parsed.data.runtimePreset, parsed.data.limits);
    const innerSeconds = Math.min(
      merged?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      MAX_TIMEOUT_SECONDS,
    );
    return innerSeconds * 1000 + OUTER_TIMEOUT_MARGIN_MS;
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    // 1. Read and validate input
    // Use readPayload + Zod parse directly instead of resolveAndValidateInput,
    // because dynamic agent tool calls may not have a resolutionContextRef.
    const rawInput = await ctx.readPayload(ctx.job.inputRef);
    const parsed = ComputeExecInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return failureWithError(
        ctx,
        permissionError(`Invalid compute input: ${parsed.error.message}`),
      );
    }
    const input = parsed.data;

    // 2. Load space compute policy (defaults to enabled with conservative limits)
    const spaceId = ctx.job.spaceId;
    if (!spaceId) {
      return failureWithError(ctx, permissionError('Compute requires a space context (spaceId)'));
    }

    const policy = await this.loadComputePolicy(ctx, spaceId);

    // If policy is explicitly set to disabled, reject
    if (policy && !policy.enabled) {
      return failureWithError(
        ctx,
        permissionError('Compute is disabled for this space. Enable it in space settings.'),
      );
    }

    let code: string;
    if (input.codePath !== undefined) {
      const resolved = await this.resolveCodePath(ctx, input.codePath, spaceId);
      if (typeof resolved !== 'string') {
        return resolved; // StepResult (error)
      }
      code = resolved;
    } else if (input.code !== undefined) {
      code = input.code;
    } else {
      // Should not happen — Zod refinement enforces code XOR codePath
      return failureWithError(ctx, validationError('Either code or codePath must be provided'));
    }

    const workspaceEnabled = input.workspace !== undefined;
    if (workspaceEnabled && !this.workspaceManager) {
      return failureWithError(
        ctx,
        internalError(
          'Compute workspace is enabled but WorkspaceManager is not configured. ' +
            'This is a server misconfiguration.',
        ),
      );
    }

    if (workspaceEnabled && policy?.sessions?.workspace?.enabled === false) {
      return failureWithError(
        ctx,
        permissionError(
          'Workspace mode is disabled by the space compute policy. ' +
            'Ask the space admin to enable sessions.workspace in compute policy.',
        ),
      );
    }

    // 2.7 Resolve inputPaths from memory — mount memory files at /tmp/input/
    // (skipped in workspace mode; data flows through /workspace/ instead)
    let resolvedFiles: Record<string, string> = {};
    if (!workspaceEnabled && input.inputPaths && input.inputPaths.length > 0) {
      const pathResult = await this.resolveInputPaths(ctx, input.inputPaths, spaceId);
      if ('stepResult' in pathResult) {
        return pathResult.stepResult;
      }
      resolvedFiles = pathResult.files;
    }
    // Merge: explicit files overlay on top of inputPaths-resolved files
    if (!workspaceEnabled && input.files) {
      Object.assign(resolvedFiles, input.files);
    }
    const hasFiles = Object.keys(resolvedFiles).length > 0;

    if (input.networkAccess) {
      const networkPolicy = policy?.networkEgress ?? { mode: 'blocked' as const };

      if (networkPolicy.mode === 'blocked') {
        return failureWithError(
          ctx,
          permissionError(
            'Network access is disabled for this space. ' +
              'Enable it in space settings: Compute → Network Egress → Allowlist mode.',
          ),
        );
      }

      // Validate requested hosts against the space policy allowlist
      const policyHosts = networkPolicy.allowedHosts ?? [];
      const requestedHosts = input.allowedHosts ?? [];

      if (requestedHosts.length === 0) {
        return failureWithError(
          ctx,
          validationError(
            'networkAccess is true but no allowedHosts specified. ' +
              'Provide the hosts this execution needs to reach, e.g., allowedHosts: ["storage.googleapis.com"].',
          ),
        );
      }

      const denied = requestedHosts.filter((h) => !matchesAllowlist(h, policyHosts));
      if (denied.length > 0) {
        return failureWithError(
          ctx,
          permissionError(
            `Host(s) not in space allowlist: ${denied.join(', ')}. ` +
              `Approved hosts: ${policyHosts.length > 0 ? policyHosts.join(', ') : '(none)'}. ` +
              'Request additional hosts via tenant admin or space settings.',
          ),
        );
      }

      // Policy check passed — but runtime egress is not yet wired (Phase 2).
      // Containers still run with --network=none. Log and inform the agent.
      ctx.log.info('Network egress policy check passed (runtime not yet wired)', {
        requestedHosts,
        policyHosts,
      });
      return failureWithError(
        ctx,
        permissionError(
          'Network egress policy check passed — the requested hosts are approved. ' +
            'However, runtime network egress (proxy-gated containers) is not yet deployed. ' +
            'Containers still run with --network=none. ' +
            'Use api.http.call for HTTP requests, or wait for Phase 2 compute egress.',
        ),
      );
    }

    // 4. Apply runtime preset, then resolve effective limits (input capped by policy)
    const mergedLimits = applyPreset(input.runtimePreset, input.limits);
    const limits = resolveEffectiveLimits(mergedLimits, policy);

    // Warn if policy capped the requested timeout significantly
    if (mergedLimits?.timeoutSeconds && limits.timeoutSeconds < mergedLimits.timeoutSeconds) {
      ctx.log.warn('Space policy capped execution timeout', {
        requested: mergedLimits.timeoutSeconds,
        effective: limits.timeoutSeconds,
        preset: input.runtimePreset,
      });
    }

    // 5. Determine execution mode: session vs ephemeral
    const sessionEnabled = input.session?.enabled === true;
    const useSession = sessionEnabled && this.sessionManager;

    // A session kill does not flush /workspace/ (the session container survives and
    // flushes at teardown), so the flushed-to-Memory clause is only true ephemeral.
    const timeoutTeaching = buildTimeoutTeaching({
      policyMaxTimeoutSeconds: limits.policyMaxTimeoutSeconds,
      source: resolveTimeoutSource(input),
      workspaceEnabled: workspaceEnabled && !useSession,
    });

    if (sessionEnabled && !this.sessionManager) {
      ctx.log.warn(
        'Session mode requested but SessionManager not available — falling back to ephemeral',
      );
    }

    // Check session policy
    if (useSession && policy?.sessions && !policy.sessions.enabled) {
      return failureWithError(
        ctx,
        permissionError(
          'Compute sessions are disabled for this space. Enable sessions in the space compute policy.',
        ),
      );
    }

    const image = getImageForRuntime(input.runtime);

    ctx.log.debug('Executing code in sandbox', {
      runtime: input.runtime,
      timeoutSeconds: limits.timeoutSeconds,
      memoryMb: limits.memoryMb,
      cpuCores: limits.cpuCores,
      hasFiles,
      inputPathCount: input.inputPaths?.length,
      hasEntryPoint: input.entryPoint !== undefined,
      codePath: input.codePath,
      sessionEnabled: useSession ? true : undefined,
      runtimePreset: input.runtimePreset,
    });

    // 6. Reserve the day's sandbox seconds at the worst case this call can
    // consume. Charging the measured duration afterwards instead would let an
    // unbounded number of calls start before any of them was counted.
    const budgetLimits =
      this.redis && this.loadBudgetLimits ? await this.loadBudgetLimits(ctx.tenantId) : undefined;
    const reservedSeconds = budgetLimits ? limits.timeoutSeconds : 0;
    let reservedDay: string | undefined;
    if (this.redis && budgetLimits) {
      const reservation = await reserveComputeSeconds(this.redis, {
        tenantId: ctx.tenantId,
        spaceId,
        seconds: reservedSeconds,
        limits: budgetLimits,
      });
      reservedDay = reservation.day;
      if (!reservation.allowed) {
        const scope = reservation.exceededScope === 'tenant' ? 'tenant' : 'space';
        return failureWithError(
          ctx,
          permissionError(
            `Compute sandbox budget exhausted for this ${scope} today ` +
              `(limit: ${String(reservation.limitSeconds ?? 0)} seconds/day; this call reserves ` +
              `${String(reservedSeconds)}). Retrying will not help until the budget resets at ` +
              `00:00 UTC. Reduce sandbox time by lowering limits.timeoutSeconds or using a ` +
              `smaller runtimePreset, or ask a tenant admin to raise the quota under ` +
              `Settings → Capability Governance → Quotas.`,
            { exceededScope: scope, limitSeconds: reservation.limitSeconds },
          ),
        );
      }
    }

    // 7. Execute
    let result;
    let sessionRestoreSource: 'warm' | 'checkpoint' | 'fresh' | undefined;
    let ephemeralFlush: FlushResult | undefined;
    let ephemeralHydratedPaths: string[] = [];
    let ephemeralMissingOutputs: string[] = [];
    const executionStartedAt = Date.now();
    const settleBudget = async (): Promise<void> => {
      if (!this.redis || !budgetLimits || reservedDay === undefined) return;
      try {
        await settleComputeSeconds(this.redis, {
          tenantId: ctx.tenantId,
          spaceId,
          reservedSeconds,
          actualSeconds: Math.ceil((Date.now() - executionStartedAt) / 1000),
          limits: budgetLimits,
          day: reservedDay,
        });
      } catch (err: unknown) {
        // A lost refund over-charges the day; it must never fail the exec.
        ctx.log.warn('Compute budget settle failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    try {
      if (useSession) {
        // Session mode: use persistent container
        result = await this.executeInSession(
          ctx,
          code,
          image,
          limits,
          input,
          policy,
          timeoutTeaching,
          hasFiles ? resolvedFiles : undefined,
          spaceId,
        );
        if ('stepResult' in result) {
          return result.stepResult;
        }
        sessionRestoreSource = result.restoreSource;
      } else {
        // Ephemeral mode: one-shot container
        const command = buildCommand(input.runtime, code, input.entryPoint, input.args);
        const request: ContainerRunRequest = {
          image,
          command,
          networkMode: 'none',
          memory: `${String(limits.memoryMb)}m`,
          cpus: String(limits.cpuCores),
          timeoutSeconds: limits.timeoutSeconds,
          timeoutTeaching,
          signal: ctx.signal,
        };
        if (input.env) {
          request.env = input.env;
        }
        if (hasFiles) {
          request.files = resolvedFiles;
        }
        if (workspaceEnabled && this.workspaceManager && spaceId) {
          const outcome = await runEphemeralWorkspaceExec({
            workspaceManager: this.workspaceManager,
            runner: this.runner,
            log: ctx.log,
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            spaceId,
            scope: { stepExecutionId: ctx.stepExecutionId, attempt: ctx.attempt },
            inputs: input.workspace?.inputs ?? [],
            outputs: input.workspace?.outputs ?? [],
            quotas: resolveWorkspaceQuotas(input.workspace?.quotas, policy?.sessions?.workspace),
            manifestTtlSeconds: WORKSPACE_MANIFEST_DEFAULT_TTL_SECONDS,
            request,
          });
          if (outcome.kind === 'workspace_error') {
            return await failureWithError(ctx, workspaceErrorToAflow(outcome.error));
          }
          if (outcome.kind === 'flush_error') {
            return await failureWithError(
              ctx,
              internalError(
                `Workspace flush failed — output may not be durable: ${outcome.error.message}. ` +
                  'Retry the exec.',
                { retryable: true },
              ),
            );
          }
          result = outcome.result;
          ephemeralFlush = outcome.flush;
          ephemeralHydratedPaths = outcome.hydratedPaths;
          ephemeralMissingOutputs = outcome.missingOutputs;
        } else {
          result = await this.runner.run(request);
        }
      }
    } finally {
      await settleBudget();
    }

    // 8. Build output with smart inline/preview strategy
    const output = await this.buildOutput(ctx, result);

    if (ephemeralFlush) {
      const flushFailure = await applyEphemeralFlushToOutput(
        ctx,
        output,
        ephemeralFlush,
        ephemeralHydratedPaths,
        ephemeralMissingOutputs,
        result,
      );
      if (flushFailure) return flushFailure;
    }

    // 8. Add session info if session mode
    if (useSession && sessionRestoreSource) {
      const sessionKey = makeSessionKey(ctx.tenantId, ctx.runId);
      const info = useSession.getSessionInfo(sessionKey);
      const sessionInfoBlock: Record<string, unknown> = {
        sessionActive: info?.sessionActive ?? true,
        sessionAge: info?.sessionAge ?? 0,
        restoreSource: sessionRestoreSource,
        remainingIdleTtlSeconds: info?.remainingIdleTtlSeconds,
      };

      if (this.workspaceManager) {
        let wsStatus: WorkspaceStatus | null = null;
        try {
          wsStatus = await this.workspaceManager.getStatus(ctx.tenantId, ctx.runId);
        } catch (err: unknown) {
          ctx.log.warn('Failed to read workspace status', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (wsStatus) {
          sessionInfoBlock['workspace'] = {
            hydratedPathsCount: wsStatus.hydratedPathsCount,
            bytesUsed: wsStatus.bytesUsed,
            dirtyPathsCount: wsStatus.dirtyPathsCount,
            pendingDeletesCount: wsStatus.pendingDeletesCount,
            lastFlushedAt: wsStatus.lastFlushedAt,
          };
        }
      }

      output['sessionInfo'] = sessionInfoBlock;

      // Warn the agent when session was restored from checkpoint (Python state lost)
      if (sessionRestoreSource !== 'warm') {
        output['sessionWarning'] =
          `Session was restored from ${sessionRestoreSource} — all Python variables, ` +
          'DataFrames, and models from prior executions are lost. ' +
          'Only files saved to /tmp/output/ were preserved. ' +
          'Re-import libraries and reload any needed state from files.';
      }
    }

    const completionLogPayload = {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: output['truncated'] === true,
      stdoutLen: result.stdout.length,
      stderrLen: result.stderr.length,
      sessionMode: useSession ? true : undefined,
      restoreSource: sessionRestoreSource,
    };
    const completionNotable =
      result.exitCode !== 0 || result.timedOut || output['truncated'] === true;
    if (completionNotable) {
      ctx.log.info('Code execution completed', completionLogPayload);
    } else {
      ctx.log.debug('Code execution completed', completionLogPayload);
    }

    return successWithData(ctx, output);
  }

  // ============================================================================

  private async executeInSession(
    ctx: ExecutorContext,
    code: string,
    image: string,
    limits: { timeoutSeconds: number; memoryMb: number; cpuCores: number; maxOutputBytes: number },
    input: ComputeExecInput,
    policy: SpaceComputePolicy | undefined,
    timeoutTeaching: string,
    filesOverride?: Record<string, string>,
    spaceId?: string,
  ): Promise<
    | ({ restoreSource: 'warm' | 'checkpoint' | 'fresh' } & ContainerRunResult)
    | { stepResult: StepResult }
  > {
    const sm = this.sessionManager!;
    const sessionKey = makeSessionKey(ctx.tenantId, ctx.runId);

    // Resolve session TTLs (input capped by policy)
    const sessionPolicy = policy?.sessions;
    const idleTtlSeconds = Math.min(
      input.session?.idleTtlSeconds ?? 1800,
      sessionPolicy?.maxIdleTtlSeconds ?? 3600,
    );
    const maxLifetimeSeconds = sessionPolicy?.maxSessionLifetimeSeconds ?? 7200;
    const checkpointTtlSeconds = Math.min(
      input.session?.checkpointTtlSeconds ?? 86400,
      sessionPolicy?.maxCheckpointTtlSeconds ?? 86400,
    );

    const netMismatch = sm.validateNetworkConfig(
      sessionKey,
      input.networkAccess,
      input.allowedHosts,
    );
    if (netMismatch) {
      return {
        stepResult: await failureWithError(ctx, permissionError(netMismatch)),
      };
    }

    const wsCfg = input.workspace;
    const wsMismatch = sm.validateWorkspaceConfig(sessionKey, wsCfg !== undefined, spaceId);
    if (wsMismatch) {
      return {
        stepResult: await failureWithError(ctx, permissionError(wsMismatch)),
      };
    }

    let workspaceMount: { hostDir: string; spaceId: string; quotas: WorkspaceQuotas } | undefined;
    let hydratedThisCall = false;
    // Host dir of the live /workspace/ bind-mount, captured in whichever branch
    // set it up, so we can verify declared FILE outputs after exec (§4.F).
    let workspaceHostDir: string | undefined;
    if (wsCfg !== undefined && this.workspaceManager && spaceId) {
      const liveWorkspace = sm.getSessionWorkspace(sessionKey);
      if (liveWorkspace) {
        workspaceHostDir = liveWorkspace.hostDir;
        // Live session already has a workspace bind-mount; reuse it.
        ctx.log.debug('Reusing live session workspace', {
          hostDir: liveWorkspace.hostDir,
          spaceId: liveWorkspace.spaceId,
        });
        try {
          await this.workspaceManager.refresh({
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            spaceId,
            hostDir: liveWorkspace.hostDir,
            inputs: wsCfg.inputs ?? [],
            outputs: wsCfg.outputs ?? [],
            quotas: liveWorkspace.quotas,
          });
        } catch (err: unknown) {
          if (err instanceof WorkspaceError) {
            return { stepResult: await failureWithError(ctx, workspaceErrorToAflow(err)) };
          }
          throw err;
        }
      } else {
        // No live session (or live session has no workspace) — hydrate fresh.
        // This also overwrites any stale Redis manifest from a prior crashed
        // session at the same key.
        const quotas = resolveWorkspaceQuotas(wsCfg.quotas, sessionPolicy?.workspace);
        try {
          const hydrated = await this.workspaceManager.hydrate({
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            spaceId,
            inputs: wsCfg.inputs ?? [],
            outputs: wsCfg.outputs ?? [],
            quotas,
            manifestTtlSeconds: checkpointTtlSeconds,
          });
          // Carry the resolved quotas into the session entry so the lifecycle
          workspaceMount = { hostDir: hydrated.hostDir, spaceId, quotas };
          workspaceHostDir = hydrated.hostDir;
          hydratedThisCall = true;
          ctx.log.info('Workspace hydrated', {
            hydratedPathsCount: hydrated.hydratedPathsCount,
            bytesUsed: hydrated.bytesUsed,
            inputs: wsCfg.inputs,
            outputs: wsCfg.outputs,
            quotas,
          });
        } catch (err: unknown) {
          if (err instanceof WorkspaceError) {
            return {
              stepResult: await failureWithError(ctx, workspaceErrorToAflow(err)),
            };
          }
          throw err;
        }
      }
    }

    let acquireSucceeded = false;
    try {
      const networkConfig =
        input.networkAccess && input.allowedHosts
          ? { networkAccess: true, allowedHosts: input.allowedHosts }
          : undefined;

      const handle = await sm.acquire(sessionKey, {
        image,
        memory: `${String(limits.memoryMb)}m`,
        cpus: String(limits.cpuCores),
        env: input.env,
        files: filesOverride,
        idleTtlSeconds,
        maxLifetimeSeconds,
        networkConfig,
        workspace: workspaceMount,
      });
      acquireSucceeded = true;

      // For session mode, we send code directly to the persistent Python process
      // (entryPoint is handled in the code itself, not via command wrapping)
      let execCode = code;
      if (input.entryPoint) {
        // Wrap to call the entry point after exec-ing the code
        const argsJson = JSON.stringify(input.args ?? []);
        execCode =
          `${code}\n` +
          `import json as __json\n` +
          `__result = ${input.entryPoint}(*__json.loads(${JSON.stringify(argsJson)}))\n` +
          `if __result is not None:\n` +
          `    print(__json.dumps(__result))`;
      }

      const inputMode = input.inputMode ?? 'replace';
      // Merge resolved inputPaths files with inline files for exec injection.
      // filesOverride contains resolved inputPaths; input.files has inline content.
      // Both need to be injected on every exec call (not just on acquire).
      const execFiles = { ...filesOverride, ...input.files };
      const hasExecFiles = Object.keys(execFiles).length > 0;
      const result = await sm.exec(
        sessionKey,
        execCode,
        limits.timeoutSeconds,
        hasExecFiles ? execFiles : undefined,
        inputMode,
        timeoutTeaching,
      );

      // §4.F: verify this call produced the FILE outputs it declared — but ONLY
      // when it exited cleanly. A non-zero exit / timeout already carries the
      // agent's signal (exitCode + stderr in the successful output); failing the
      // contract on top would suppress the traceback (a FAILED step delivers no
      // output). A declared file output is a per-call contract: a run that exits
      // 0 must write it. Shared with the one-shot path (no drift). A write target
      // filled on a LATER turn is declared as a trailing-"/" directory output,
      // which is not verified here.
      if (
        workspaceHostDir &&
        result.exitCode === 0 &&
        !result.timedOut &&
        (wsCfg?.outputs?.length ?? 0) > 0
      ) {
        const missing = await missingFileOutputs(workspaceHostDir, wsCfg!.outputs!);
        const failure = await buildCleanExitContractFailure(ctx, {
          missingOutputs: missing,
          conflicts: [],
          skipped: [],
        });
        if (failure) return { stepResult: failure };
      }

      return {
        ...result,
        restoreSource: handle.restoreSource,
      };
    } catch (err: unknown) {
      ctx.log.error('Session execution failed', {
        error: err instanceof Error ? err.message : String(err),
      });

      // If admission denied, return a helpful error
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('admission denied')) {
        return {
          stepResult: await failureWithError(
            ctx,
            internalError(
              `Compute session could not be created: ${msg}. ` +
                'Try again later or reduce resource limits.',
              { retryable: true },
            ),
          ),
        };
      }

      return {
        stepResult: await failureWithError(ctx, internalError(`Session execution failed: ${msg}`)),
      };
    } finally {
      // W2: roll back the just-hydrated workspace if we never made it past
      // sm.acquire. (If acquire succeeded, the lifecycle hook owns cleanup.)
      if (hydratedThisCall && !acquireSucceeded && workspaceMount && this.workspaceManager) {
        await this.workspaceManager
          .release(ctx.tenantId, ctx.runId, workspaceMount.hostDir)
          .catch((cleanupErr: unknown) => {
            ctx.log.warn('Failed to clean up hydrated workspace after acquire failure', {
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          });
      }
    }
  }

  // ============================================================================
  // Output building — smart inline vs preview+ref
  // ============================================================================

  /**
   * Build the output object with smart truncation:
   * - Small output (<=64KB total): inline everything, no ref needed.
   * - Large output (>64KB): truncated inline + preview + summary + PayloadRef.
   */
  private async buildOutput(
    ctx: ExecutorContext,
    result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
      timedOut: boolean;
      outputFiles?: Record<string, string> | undefined;
    },
  ): Promise<Record<string, unknown>> {
    const stdoutBytes = Buffer.byteLength(result.stdout, 'utf-8');
    const stderrBytes = Buffer.byteLength(result.stderr, 'utf-8');
    const stdoutTruncated = stdoutBytes > MAX_INLINE_OUTPUT_BYTES;
    const stderrTruncated = stderrBytes > MAX_INLINE_OUTPUT_BYTES;
    const truncated = stdoutTruncated || stderrTruncated;

    const output: Record<string, unknown> = {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };

    if (result.timedOut) {
      output['timedOut'] = true;
    }

    if (!truncated) {
      // Small output — inline everything, agent sees it all directly
      output['data'] = result.stdout;
      output['stderr'] = result.stderr;
      if (result.outputFiles) {
        output['outputFiles'] = result.outputFiles;
      }
      return output;
    }

    // Large output — store full data in PayloadRef, inline a truncated version
    output['truncated'] = true;
    output['data'] = stdoutTruncated
      ? result.stdout.slice(0, MAX_INLINE_OUTPUT_BYTES)
      : result.stdout;
    output['stderr'] = stderrTruncated
      ? result.stderr.slice(0, MAX_INLINE_OUTPUT_BYTES)
      : result.stderr;

    // Store full stdout as PayloadRef — use 'body' kind so path is .../body.json,
    // distinct from the step output at .../output.json (avoids overwrite collision).
    const ref = await ctx.writePayload('body', result.stdout);
    output['dataRef'] = ref;

    // Summary so agent can assess size without loading full output
    const stdoutLines = countLines(result.stdout);
    const stderrLines = countLines(result.stderr);
    const summary: Record<string, unknown> = {
      stdoutBytes,
      stderrBytes,
      stdoutLines,
      stderrLines,
    };
    if (stdoutTruncated) {
      summary['stdoutPreview'] = result.stdout.slice(0, PREVIEW_BYTES);
    }
    if (stderrTruncated) {
      summary['stderrPreview'] = result.stderr.slice(0, PREVIEW_BYTES);
    }
    output['outputSummary'] = summary;

    if (result.outputFiles) {
      output['outputFiles'] = result.outputFiles;
    }

    return output;
  }

  // ============================================================================
  // Policy loading
  // ============================================================================

  /**
   * Load and parse the space's compute policy from Postgres.
   * Returns undefined if no policy is set (compute not configured).
   */
  private async loadComputePolicy(
    ctx: ExecutorContext,
    spaceId: string,
  ): Promise<SpaceComputePolicy | undefined> {
    if (!this.db) {
      ctx.log.warn('Database not available — cannot load compute policy');
      return undefined;
    }

    try {
      const tenantContext = createTenantContext(ctx.tenantId);
      const rows = await withTenantSchema(this.db, tenantContext, async (tx) => {
        return tx
          .select({ computePolicy: spaces.computePolicy })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .limit(1);
      });

      const row = rows[0];
      if (!row?.computePolicy) return undefined;

      // Parse through Zod for validation and defaults
      const parsed = SpaceComputePolicySchema.safeParse(row.computePolicy);
      if (!parsed.success) {
        ctx.log.warn('Invalid compute policy in database', {
          spaceId,
          errors: parsed.error.issues,
        });
        return undefined;
      }

      return parsed.data;
    } catch (err: unknown) {
      ctx.log.error('Failed to load compute policy', {
        spaceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  // ============================================================================
  // Input path resolution — mount memory files at /tmp/input/
  // ============================================================================

  private async resolveInputPaths(
    ctx: ExecutorContext,
    inputPaths: string[],
    spaceId: string,
  ): Promise<{ files: Record<string, string> } | { stepResult: StepResult }> {
    const files: Record<string, string> = {};

    for (const memPath of inputPaths) {
      try {
        let content: string;

        if (isVirtualPath(memPath)) {
          const resolveCtx = this.buildResolveContext(ctx, spaceId);
          const resolved = await resolveMemoryPath(memPath, resolveCtx);
          content = resolved.content;
        } else {
          // Persistent path — Postgres lookup.
          if (!this.db) {
            return {
              stepResult: await failureWithError(
                ctx,
                validationError('Database not available — cannot resolve inputPaths.'),
              ),
            };
          }

          const tenantContext = createTenantContext(ctx.tenantId);
          const repo = createMemoryDocRepository(this.db, tenantContext);
          const doc = spaceId ? await repo.getByPath(memPath, spaceId) : null;

          if (!doc) {
            // No exact file here — treat the path as a directory prefix and mount
            // every document directly under it (inputPaths directory support). A
            // skill passing a data-root prefix (".../data/") gets all its files,
            // matching the "give the sandbox this folder" mental model instead of
            // failing. `listDir` returns direct child docs only; recursing over
            // them reuses the single-file load + mount path below.
            const dirRepo = createMemoryDirRepository(this.db, tenantContext);
            const items = spaceId ? await dirRepo.listDir(memPath, { scope: { spaceId } }) : [];
            const childPaths = items
              .filter((it) => it.entryType === 'document')
              .map((it) => it.path);
            if (childPaths.length === 0) {
              return {
                stepResult: await failureWithError(
                  ctx,
                  validationError(
                    `inputPath not found: "${memPath}". If it is a file, check the exact path; ` +
                      `if it is a directory, it contains no readable documents. ` +
                      `List available paths with memory.store.list.`,
                  ),
                ),
              };
            }
            const sub = await this.resolveInputPaths(ctx, childPaths, spaceId);
            if ('stepResult' in sub) return sub;
            Object.assign(files, sub.files);
            continue;
          }

          if (doc.inlineContent !== null) {
            content = doc.inlineContent;
          } else if (doc.payloadRef) {
            try {
              const payload = await ctx.readPayload(doc.payloadRef);
              content = typeof payload === 'string' ? payload : JSON.stringify(payload);
            } catch (_err) {
              return {
                stepResult: await failureWithError(
                  ctx,
                  validationError(
                    `Failed to load memory file "${memPath}": content may have expired. ` +
                      'Re-upload the file via memory.store.put.',
                  ),
                ),
              };
            }
          } else {
            return {
              stepResult: await failureWithError(
                ctx,
                validationError(`Memory file "${memPath}" has no content`),
              ),
            };
          }
        }

        // Mount using the full memory path (minus leading /) to preserve structure
        // and guarantee collision-free mounting. Agent rule: /tmp/input/<memoryPath>.
        const mountKey = memPath.startsWith('/') ? memPath.slice(1) : memPath;
        files[mountKey] = content;
        const contentBytes = Buffer.byteLength(content, 'utf-8');
        const first4Hex = Buffer.from(content.slice(0, 4), 'utf-8').toString('hex');
        ctx.log.info('Resolved inputPath', {
          memPath,
          mountKey,
          sizeBytes: contentBytes,
          isVirtual: isVirtualPath(memPath),
          first4Hex,
          looksLikeCsv: content.startsWith('PassengerId') || content.startsWith('"'),
          looksCompressed: first4Hex.startsWith('3dab') || first4Hex.startsWith('1f8b'),
        });
      } catch (err) {
        if (err instanceof MemoryPathError) {
          return {
            stepResult: await failureWithError(
              ctx,
              validationError(`Failed to resolve inputPath "${memPath}": ${err.message}`),
            ),
          };
        }
        throw err;
      }
    }

    return { files };
  }

  private buildResolveContext(ctx: ExecutorContext, spaceId: string): PathResolveContext {
    return {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      spaceId,
      payloadStore: { retrieve: (ref: string) => ctx.readPayload(ref) },
      memoryDocReader: { getByPath: () => Promise.resolve(null) }, // Virtual paths don't need this
      toolOutputIndexReader: {
        readToolOutputIndex: async (
          tenantId: string,
          runId: string,
        ): Promise<ToolOutputIndex | null> => {
          if (!this.redis) return null;
          const stateKey = `aflow:session:${tenantId}:${runId}:state`;
          const raw = await this.redis.hget(stateKey, 'runtimeState');
          if (!raw) return null;
          try {
            const state = JSON.parse(raw) as {
              variables?: Record<string, { ref?: { kind: string; value?: unknown } } | undefined>;
            };
            const entry = state.variables?.['_tool_outputs'];
            if (entry?.ref?.kind === 'inline' && typeof entry.ref.value === 'object') {
              return entry.ref.value as ToolOutputIndex;
            }
            return null;
          } catch {
            return null;
          }
        },
      },
    };
  }

  // ============================================================================

  /**
   * Resolve a codePath to its content by reading the memory document.
   * Returns the code string on success, or a StepResult (error) on failure.
   */
  private async resolveCodePath(
    ctx: ExecutorContext,
    codePath: string,
    spaceId: string,
  ): Promise<string | StepResult> {
    if (!this.db) {
      return failureWithError(
        ctx,
        validationError(
          'Database not available — cannot resolve codePath. Use inline code instead.',
        ),
      );
    }

    try {
      const tenantContext = createTenantContext(ctx.tenantId);
      const repo = createMemoryDocRepository(this.db, tenantContext);

      // Look up document by path, scoped to the space
      const doc = spaceId ? await repo.getByPath(codePath, spaceId) : null;
      if (!doc) {
        return await failureWithError(
          ctx,
          validationError(`Code artifact not found at path: ${codePath}`),
        );
      }

      // Resolve content: inline first, then PayloadStore
      if (doc.inlineContent !== null) {
        ctx.log.info('Resolved codePath from inline content', {
          codePath,
          sizeBytes: doc.sizeBytes,
        });
        return doc.inlineContent;
      }

      if (doc.payloadRef) {
        const payload = await ctx.readPayload(doc.payloadRef);
        if (typeof payload === 'string') {
          ctx.log.info('Resolved codePath from PayloadStore', {
            codePath,
            sizeBytes: doc.sizeBytes,
          });
          return payload;
        }
        // If payload is JSON, stringify it (unusual for code but handle gracefully)
        ctx.log.info('Resolved codePath from PayloadStore (JSON content)', {
          codePath,
          sizeBytes: doc.sizeBytes,
        });
        return JSON.stringify(payload);
      }

      return await failureWithError(
        ctx,
        validationError(`Code artifact at path "${codePath}" has no content`),
      );
    } catch (err: unknown) {
      ctx.log.error('Failed to resolve codePath', {
        codePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return failureWithError(
        ctx,
        validationError(
          `Failed to load code from memory path "${codePath}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a hostname matches an allowlist entry.
 * Supports exact match and wildcard prefix (e.g., "*.googleapis.com").
 */
function hostMatchesEntry(host: string, entry: string): boolean {
  if (entry === host) return true;
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1); // ".googleapis.com"
    return host.endsWith(suffix) || host === entry.slice(2);
  }
  return false;
}

/**
 * Check if a requested host is covered by any entry in the allowlist.
 */
function matchesAllowlist(host: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => hostMatchesEntry(host, entry));
}

/**
 * Map a WorkspaceError to the right AflowError classification. Hydrate failures
 * (invalid inputs/outputs, quota / per-file / file-count caps) are user-supplied
 * input problems → validation, NOT permission. DB unavailability is a server issue.
 */
function workspaceErrorToAflow(err: WorkspaceError) {
  return err.code === 'WORKSPACE_DB_UNAVAILABLE'
    ? internalError(`${err.code}: ${err.message}`, { retryable: false })
    : validationError(`${err.code}: ${err.message}`);
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let count = 1;
  for (const ch of s) {
    if (ch === '\n') count++;
  }
  return count;
}

function resolveWorkspaceQuotas(
  agentQuotas: { maxBytes?: number; maxFileBytes?: number; maxFileCount?: number } | undefined,
  policyCeiling: { maxBytes?: number; maxFileBytes?: number; maxFileCount?: number } | undefined,
): WorkspaceQuotas {
  const ceiling = {
    maxBytes: policyCeiling?.maxBytes ?? DEFAULT_WORKSPACE_QUOTAS.maxBytes,
    maxFileBytes: policyCeiling?.maxFileBytes ?? DEFAULT_WORKSPACE_QUOTAS.maxFileBytes,
    maxFileCount: policyCeiling?.maxFileCount ?? DEFAULT_WORKSPACE_QUOTAS.maxFileCount,
  };
  return {
    maxBytes: Math.min(agentQuotas?.maxBytes ?? ceiling.maxBytes, ceiling.maxBytes),
    maxFileBytes: Math.min(agentQuotas?.maxFileBytes ?? ceiling.maxFileBytes, ceiling.maxFileBytes),
    maxFileCount: Math.min(agentQuotas?.maxFileCount ?? ceiling.maxFileCount, ceiling.maxFileCount),
  };
}
