import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExecutorContext, ExecutorLogger, StepResult } from '@aflow/executor-runtime';
import { failureWithError, validationError } from '@aflow/executor-runtime';
import type { TenantId, SessionId } from '@aflow/schemas';

import type {
  ContainerRunner,
  ContainerRunRequest,
  ContainerRunResult,
} from './containerRunner.js';
import {
  WorkspaceError,
  type WorkspaceManager,
  type WorkspaceQuotas,
  type WorkspaceInstanceScope,
  type FlushResult,
} from './workspaceManager.js';

export interface EphemeralWorkspaceExecParams {
  workspaceManager: WorkspaceManager;
  runner: ContainerRunner;
  log: ExecutorLogger;
  tenantId: TenantId;
  runId: SessionId;
  spaceId: string;
  /** Per-step scope so concurrent same-run one-shots don't clobber (§4.B). */
  scope: WorkspaceInstanceScope;
  inputs: string[];
  outputs: string[];
  quotas: WorkspaceQuotas;
  manifestTtlSeconds: number;
  /** The container run request, already built without a workspace mount. */
  request: ContainerRunRequest;
}

export type EphemeralWorkspaceOutcome =
  | {
      kind: 'ok';
      result: ContainerRunResult;
      flush: FlushResult;
      hydratedPaths: string[];
      /** §4.F: declared FILE outputs (no trailing "/") the run did not produce. */
      missingOutputs: string[];
    }
  | { kind: 'workspace_error'; error: WorkspaceError }
  | { kind: 'flush_error'; error: Error };

export async function missingFileOutputs(hostDir: string, outputs: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const out of outputs) {
    if (out.endsWith('/')) continue;
    const rel = out.startsWith('/') ? out.slice(1) : out;
    if (rel.length === 0) continue;
    const full = join(hostDir, rel);
    // Defense in depth: never stat outside the workspace root (hydrate already
    // rejects escaping outputs, so this only guards against a `..` slipping in).
    if (!full.startsWith(hostDir + '/')) continue;
    try {
      const s = await stat(full);
      if (!s.isFile()) missing.push(out);
    } catch {
      missing.push(out);
    }
  }
  return missing;
}

/**
 * Run a one-shot exec with a hydrated /workspace/ bind-mount, flushing dirty
 * files back to Memory at the end. Hydrate failures (quota, invalid workingSet)
 * are returned as `workspace_error`; a thrown flush — an infrastructure failure
 * (Redis/DB/PayloadStore) that means the output is NOT durable — is returned as
 * `flush_error` so the caller can fail the step (never report a false success).
 * Per-file CAS conflicts and quota skips are NOT throws: they come back inside
 * the `ok` flush result and are policed by §4.E.
 */
export async function runEphemeralWorkspaceExec(
  params: EphemeralWorkspaceExecParams,
): Promise<EphemeralWorkspaceOutcome> {
  const { workspaceManager, runner, log, tenantId, runId, spaceId, scope } = params;

  let hostDir: string;
  let hydratedPaths: string[];
  try {
    const hydrated = await workspaceManager.hydrate({
      tenantId,
      runId,
      spaceId,
      inputs: params.inputs,
      outputs: params.outputs,
      quotas: params.quotas,
      manifestTtlSeconds: params.manifestTtlSeconds,
      scope,
    });
    hostDir = hydrated.hostDir;
    hydratedPaths = hydrated.hydratedPaths;
  } catch (err: unknown) {
    if (err instanceof WorkspaceError) {
      return { kind: 'workspace_error', error: err };
    }
    throw err;
  }

  let runResult: ContainerRunResult | undefined;
  let flush: FlushResult | undefined;
  let flushError: Error | undefined;
  let missingOutputs: string[] = [];
  try {
    runResult = await runner.run({ ...params.request, workspace: { hostDir } });
  } finally {
    // §4.F: verify declared FILE outputs were produced (on disk) before release
    // deletes the dir. Checked even on a non-zero exit so the contract holds.
    if (params.outputs.length > 0) {
      missingOutputs = await missingFileOutputs(hostDir, params.outputs);
    }
    // §4.A: flush what the run wrote even on non-zero exit, thrown error, or
    // timeout, then release. A thrown flush is captured (not swallowed) so the
    // step fails rather than reporting a false success; release still runs.
    try {
      flush = await workspaceManager.flush({
        tenantId,
        runId,
        spaceId,
        hostDir,
        reason: 'exec-end',
        quotas: params.quotas,
        scope,
      });
    } catch (flushErr: unknown) {
      flushError = flushErr instanceof Error ? flushErr : new Error(String(flushErr));
      log.error('Ephemeral workspace flush failed', {
        tenantId,
        runId,
        error: flushError.message,
      });
    }
    await workspaceManager.release(tenantId, runId, hostDir, scope).catch((releaseErr: unknown) => {
      log.warn('Ephemeral workspace release failed', {
        tenantId,
        runId,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    });
  }

  // runResult is defined here: if runner.run threw, the finally ran (flush +
  // release) and the throw already propagated past this point.
  if (flushError || !flush) {
    return { kind: 'flush_error', error: flushError ?? new Error('workspace flush did not run') };
  }
  return { kind: 'ok', result: runResult, flush, hydratedPaths, missingOutputs };
}

/** Map a FlushResult (+ hydratedPaths + missingOutputs) onto the agent-facing workspaceFlush shape (§4.E/§4.F). */
export function toWorkspaceFlushOutput(
  flush: FlushResult,
  hydratedPaths: string[],
  missingOutputs: string[],
): {
  hydratedPaths: string[];
  committed: Array<{ path: string; version: number; sizeBytes: number }>;
  conflicts: Array<{ path: string; sidecarPath?: string; currentVersion: number }>;
  skipped: Array<{ path: string; reason: string }>;
  missingOutputs: string[];
  bytesFlushed: number;
} {
  return {
    hydratedPaths,
    committed: flush.committed.map((c) => ({
      path: c.path,
      version: c.newMemoryVersion,
      sizeBytes: c.sizeBytes,
    })),
    conflicts: flush.conflicts.map((c) => ({
      path: c.path,
      ...(c.sidecarPath ? { sidecarPath: c.sidecarPath } : {}),
      currentVersion: c.currentVersion,
    })),
    skipped: flush.skipped.map((s) => ({ path: s.path, reason: s.reason })),
    missingOutputs,
    bytesFlushed: flush.bytesFlushed,
  };
}

/**
 * §4.E/§4.F policy: attach `workspaceFlush` to the op output, and fail the step
 * for a declared-contract miss — BUT only when the run exited CLEANLY.
 *
 * A non-zero exit or timeout already tells the agent the run failed, and the
 * real cause (the traceback) lives in the run's `stderr`/`exitCode`, which only
 * reach the agent on a SUCCESSFUL step (a FAILED step is compacted to a
 * bounded error with no step output — see toAgentToolError). So when the run
 * crashed we must NOT convert it into a workspace-contract failure: that would
 * suppress the exitCode/stderr and leave the agent blind to the real bug (an
 * `ImportError`, a Python exception). Instead the same facts surface in
 * `workspaceFlush` (missingOutputs / conflicts / skipped) on the successful
 * return, and the agent reads the traceback and fixes its code. The hard-fail is
 * reserved for the genuinely silent case: the run exited 0 yet did not produce a
 * declared output (or a write was conflicted/skipped). Returns a FAILED
 * StepResult when that trips, otherwise undefined.
 */
export async function applyEphemeralFlushToOutput(
  ctx: ExecutorContext,
  output: Record<string, unknown>,
  flush: FlushResult,
  hydratedPaths: string[],
  missingOutputs: string[],
  result: { exitCode: number; timedOut: boolean },
): Promise<StepResult | undefined> {
  const workspaceFlush = toWorkspaceFlushOutput(flush, hydratedPaths, missingOutputs);
  output['workspaceFlush'] = workspaceFlush;
  if (result.exitCode !== 0 || result.timedOut) return undefined;
  return buildCleanExitContractFailure(ctx, {
    missingOutputs,
    conflicts: flush.conflicts.map((c) => ({ path: c.path })),
    skipped: flush.skipped.map((s) => ({ path: s.path, reason: s.reason })),
    workspaceFlush,
  });
}

/**
 * §4.F failure for a run that exited 0 but did not satisfy its file contract.
 * The message is self-contained (a FAILED step delivers only a short message —
 * no output/details — so it must name the actual problem inline, not point at a
 * `workspaceFlush` the agent won't receive) and composed from only the clauses
 * that apply (no false "conflicted/skipped" boilerplate when those are zero).
 * Shared by the one-shot and sessioned paths. Returns undefined when nothing
 * tripped.
 */
export async function buildCleanExitContractFailure(
  ctx: ExecutorContext,
  params: {
    missingOutputs: string[];
    conflicts: Array<{ path: string }>;
    skipped: Array<{ path: string; reason: string }>;
    workspaceFlush?: unknown;
  },
): Promise<StepResult | undefined> {
  const { missingOutputs, conflicts, skipped } = params;
  if (missingOutputs.length === 0 && conflicts.length === 0 && skipped.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (missingOutputs.length > 0) {
    parts.push(`did not write declared output(s): ${missingOutputs.join(', ')}`);
  }
  if (conflicts.length > 0) {
    parts.push(
      `${String(conflicts.length)} write(s) conflicted with a newer Memory version ` +
        `(rescued to "workspace_conflict" sidecars): ${conflicts.map((c) => c.path).join(', ')}`,
    );
  }
  if (skipped.length > 0) {
    parts.push(
      `${String(skipped.length)} write(s) could not be persisted: ` +
        skipped.map((s) => `${s.path} (${s.reason})`).join(', '),
    );
  }
  const details =
    params.workspaceFlush !== undefined ? { workspaceFlush: params.workspaceFlush } : {};
  return failureWithError(
    ctx,
    validationError(
      `compute.sandbox.exec exited 0 but ${parts.join('; ')}. Write outputs under /workspace/ ` +
        `(a trailing-"/" output is a directory and need not be filled).`,
      details,
    ),
  );
}
