/**
 * The process half of the host lane.
 *
 * Every command runs inside the sandbox policy compiled from its binding, and a
 * host where the adapter cannot enforce refuses the operation rather than
 * running it openly — a boundary that degrades silently is the failure this lane
 * exists to avoid.
 *
 * A push is the exception, and it is not a degradation. The sandbox contains a
 * command nobody has read; a push has been read argument by argument by
 * `requirePushAllowed` before it is spawned, and its whole purpose is to move a
 * branch on a remote the boundary cannot reach — so it runs as the operator's
 * own git, in their environment, and everything else stays confined.
 *
 * Processes are spawned into their own group so a stop reaches descendants. A
 * command that backgrounds a child cannot outlive the step that started it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  permissionError,
  validationError,
  notFoundError,
  internalError,
} from '@aflow/executor-runtime';
import {
  HostProcessExecInputSchema,
  HostProcessInputInputSchema,
  HostProcessInspectInputSchema,
  HostProcessStopInputSchema,
} from '@aflow/schemas';

import { createChatterStripper } from '../egressRefusals.js';
import { EnvPolicyError } from '../envPolicy.js';
import { explainFailedStart } from '../executableHint.js';
import {
  type HostBinding,
  HostBindingError,
  executionPermitted,
  isGitPush,
  loadHostPolicy,
  requireBinding,
  requireExecution,
  requirePushAllowed,
  requireSpace,
  resolveWithin,
} from '../bindings.js';
import {
  noSandboxMessage,
  lookupProcess,
  processesForBinding,
  killProcessesForBinding,
  reapWithdrawn,
  runSandboxed,
  runUnconfined,
  type SandboxedRunResult,
  sandboxReadiness,
  signalGroup,
  writeToProcess,
} from '../sandboxedRun.js';

/**
 * Every operation in this file needs the execution grant, including `inspect`
 * and `stop`. A binding that cannot run anything has nothing to inspect, and
 * answering the question anyway would leak which process ids exist.
 */
async function bindingFor(
  policyPath: string,
  bindingId: string,
  spaceId: string | undefined,
): Promise<{ binding: HostBinding; toolPaths: readonly string[] }> {
  const policy = await loadHostPolicy(policyPath);

  // Every operation reconciles what is running against the whole current
  // policy, not only the binding it names. Scoping this to the named binding
  // meant withdrawal reached a process only if someone happened to name it
  // again — and detaching exists so the step can end, so ordinarily nobody
  // does. The policy is already in hand; this costs a set membership per
  // process.
  reapWithdrawn(executionPermitted(policy.bindings));

  let binding: HostBinding;
  try {
    binding = requireBinding(policy.bindings, bindingId);
    requireSpace(binding, spaceId);
    requireExecution(binding);
  } catch (error) {
    if (error instanceof HostBindingError) killProcessesForBinding(bindingId);
    throw error;
  }
  return { binding, toolPaths: policy.toolPaths };
}

async function failure(ctx: ExecutorContext, error: unknown): Promise<StepResult> {
  if (error instanceof EnvPolicyError) {
    return await failureWithError(ctx, validationError(error.message));
  }
  if (error instanceof HostBindingError) {
    return await failureWithError(
      ctx,
      error.kind === 'unknown_binding'
        ? notFoundError(error.message)
        : permissionError(error.message),
    );
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'unknown';
  ctx.log.error('host process operation failed', { code, error });
  return await failureWithError(ctx, internalError(`The host could not run this (${code}).`));
}

async function execProcess(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  const raw = await ctx.readPayload(ctx.job.inputRef);
  const parsed = HostProcessExecInputSchema.safeParse(raw);
  if (!parsed.success) {
    return await failureWithError(ctx, validationError(parsed.error.message));
  }
  const input = parsed.data;

  let scratch: string | undefined;
  let detached: boolean | undefined;
  try {
    const { binding, toolPaths } = await bindingFor(policyPath, input.bindingId, ctx.spaceId);
    // Before the sandbox is compiled and before anything is spawned: a push is
    // the one command whose effect lands outside the boundary the sandbox can
    // enforce, and the one that then runs outside it, so what it would move is
    // read while it is still an argv.
    requirePushAllowed(binding, input.command, { env: input.env, detach: input.detach });

    // Live standard error carries the adapter's own narration alongside the
    // command's, and a viewer reading the sandbox describe its sockets cannot
    // tell a working command from a stuck one. Held per line, because a read
    // boundary falls wherever the pipe flushes.
    const visible = createChatterStripper();
    const stream = (text: string): void => {
      if (text !== '') void ctx.emitLiveDelta('text', text);
    };
    const supervision = {
      // The one job-supplied path in this lane that used to skip the check
      // every other one makes: `../..` put the process outside the root.
      cwd: await resolveWithin(binding, input.cwd, true),
      timeoutMs: input.timeoutMs,
      idPrefix: 'hp',
      ownerRunId: ctx.runId,
      signal: ctx.signal,
      onDelta: (text: string) => {
        stream(visible.push(text));
      },
      // A command's progress usually speaks on standard error — compilers,
      // installers, anything with a counter — and a step watching only standard
      // output sees a silent build as a dead one.
      liveStderr: true,
      onOutput: () => ctx.reportProgress?.(),
    };

    const confined = !isGitPush(input.command);
    let result: SandboxedRunResult;
    if (confined) {
      const readiness = sandboxReadiness();
      if (!readiness.ready) {
        return await failureWithError(ctx, permissionError(noSandboxMessage(readiness.missing)));
      }
      scratch = await mkdtemp(join(tmpdir(), 'aflow-host-'));
      result = await runSandboxed({
        ...supervision,
        binding,
        argv: input.command,
        env: input.env,
        scratchDir: scratch,
        toolPaths,
        detach: input.detach,
      });
    } else {
      result = await runUnconfined({ ...supervision, binding, argv: input.command });
    }
    // Whatever the last chunk left unterminated.
    stream(visible.flush());

    detached = result.detached;
    // A refusal nobody can attribute is a refusal nobody can act on. Only a
    // confined command has a boundary that could be the reason it never started.
    const note = confined
      ? explainFailedStart(
          input.command,
          result.exitCode,
          `${result.stdout}\n${result.stderr}`,
          homedir(),
          toolPaths,
        )
      : undefined;
    return await successWithData(ctx, {
      processId: result.processId,
      bindingId: binding.id,
      command: input.command.join(' '),
      ...(result.detached === true ? { detached: true } : {}),
      confined,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      ...(note !== undefined ? { boundaryNote: note } : {}),
    });
  } catch (error) {
    return await failure(ctx, error);
  } finally {
    // A detached process is still using this — its policy file lives there, and
    // it is that process's TMPDIR. The spawn path removes it when it ends.
    if (scratch !== undefined && detached !== true) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

async function inspectProcess(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parsed = HostProcessInspectInputSchema.safeParse(raw);
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    await bindingFor(policyPath, parsed.data.bindingId, ctx.spaceId);

    const entry = lookupProcess(parsed.data.processId, ctx.runId, parsed.data.bindingId);
    if (entry === undefined) {
      // Not running is not the same as never existed, and this executor cannot
      // tell them apart after a restart. Say so rather than guess.
      return await successWithData(ctx, { processId: parsed.data.processId, state: 'unknown' });
    }
    return await successWithData(ctx, {
      processId: parsed.data.processId,
      state: entry.state,
      startedAt: entry.startedAt.toISOString(),
      exitCode: entry.exitCode,
      ...(entry.output !== '' ? { output: entry.output } : {}),
      ...(entry.truncated ? { truncated: true } : {}),
    });
  } catch (error) {
    return await failure(ctx, error);
  }
}

async function stopProcess(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parsed = HostProcessStopInputSchema.safeParse(raw);
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    const input = parsed.data;
    const { binding } = await bindingFor(policyPath, input.bindingId, ctx.spaceId);

    // Ids never cross bindings: stopping is scoped to what this binding started.
    const targets = processesForBinding(binding.id, ctx.runId, input.processId);

    const stopped: string[] = [];
    const alreadyExited: string[] = [];
    for (const [id, entry] of targets) {
      if (entry.exited) {
        alreadyExited.push(id);
        continue;
      }
      signalGroup(entry.child, 'SIGTERM');
      stopped.push(id);
    }
    if (stopped.length > 0 && input.graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, input.graceMs));
      for (const [id, entry] of targets) {
        if (!entry.exited && stopped.includes(id)) signalGroup(entry.child, 'SIGKILL');
      }
    }

    return await successWithData(ctx, { stopped, alreadyExited });
  } catch (error) {
    return await failure(ctx, error);
  }
}

async function sendInput(ctx: ExecutorContext, policyPath: string): Promise<StepResult> {
  try {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parsed = HostProcessInputInputSchema.safeParse(raw);
    if (!parsed.success) {
      return await failureWithError(ctx, validationError(parsed.error.message));
    }
    await bindingFor(policyPath, parsed.data.bindingId, ctx.spaceId);

    const state = writeToProcess(
      parsed.data.processId,
      ctx.runId,
      parsed.data.bindingId,
      parsed.data.input,
    );
    if (state === 'not_found') {
      // Deliberately the same answer as a process that never existed: telling a
      // caller that a handle belongs to someone else confirms the handle.
      return await failureWithError(
        ctx,
        notFoundError(`No process \`${parsed.data.processId}\` is running for this run.`),
      );
    }
    return await successWithData(ctx, { state });
  } catch (error) {
    return await failure(ctx, error);
  }
}

export function createHostProcessHandler(policyPath: string): {
  handles: ReadonlySet<string>;
  execute: (ctx: ExecutorContext) => Promise<StepResult>;
} {
  return {
    handles: new Set([
      'host.process.exec',
      'host.process.inspect',
      'host.process.stop',
      'host.process.input',
    ]),
    execute: async (ctx: ExecutorContext): Promise<StepResult> => {
      switch (ctx.operationId) {
        case 'host.process.exec':
          return await execProcess(ctx, policyPath);
        case 'host.process.inspect':
          return await inspectProcess(ctx, policyPath);
        case 'host.process.input':
          return await sendInput(ctx, policyPath);
        default:
          return await stopProcess(ctx, policyPath);
      }
    },
  };
}
