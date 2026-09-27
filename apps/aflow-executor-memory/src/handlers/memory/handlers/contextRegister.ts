/**
 * memory.context.remember / memory.context.forget — active-memory register.
 *
 * Every agent write is admitted as a `candidate`; promotion to `active` is a
 * user action on the REST surface, never an op. The register is a column on the
 * space row, so these handlers are its only op-side mutation path.
 */
import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError, validationError } from '@aflow/executor-runtime';
import type { TenantContext } from '@aflow/database';
import {
  loadActiveMemorySpaceState,
  mutateActiveMemoryRegister,
  type ActiveMemoryMutateOutcome,
} from '@aflow/database';
import type {
  ActiveMemoryRegister,
  MemoryContextForgetInput,
  MemoryContextRememberInput,
} from '@aflow/schemas';
import { admitForget, admitRemember } from '@aflow/schemas';

function counts(register: ActiveMemoryRegister): { activeCount: number; candidateCount: number } {
  let activeCount = 0;
  let candidateCount = 0;
  for (const e of register.entries) {
    if (e.status === 'active') activeCount++;
    else if (e.status === 'candidate') candidateCount++;
  }
  return { activeCount, candidateCount };
}

async function terminalFailure(
  ctx: ExecutorContext,
  outcome: ActiveMemoryMutateOutcome,
  spaceId: string,
): Promise<StepResult> {
  switch (outcome.outcome) {
    case 'not_found':
      return await failureWithError(ctx, validationError(`Space ${spaceId} not found`));
    case 'register_invalid':
      return await failureWithError(
        ctx,
        validationError(
          'ACTIVE_MEMORY_REGISTER_INVALID: the stored register is unreadable — an operator must repair or clear it.',
        ),
      );
    case 'rejected':
      return await failureWithError(ctx, validationError(outcome.error));
    case 'conflict':
    case 'noop':
    case 'saved':
      return await failureWithError(
        ctx,
        validationError(
          'ACTIVE_MEMORY_CONFLICT: the register changed concurrently — retry the call.',
        ),
      );
  }
}

export async function handleContextRemember(
  ctx: ExecutorContext,
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  input: MemoryContextRememberInput,
  spaceId: string,
): Promise<StepResult> {
  const outcome = await mutateActiveMemoryRegister(db, tenantCtx, spaceId, (state) => {
    if (!state.singleOwner) {
      return {
        ok: false,
        error:
          'ACTIVE_MEMORY_PERSONAL_ONLY: the active-memory register is available only in a personal space with no other members. ' +
          'In shared or multi-member spaces, record durable knowledge as memory docs instead (memory.store.put).',
      };
    }
    return admitRemember(
      state.register,
      {
        kind: input.kind,
        statement: input.statement,
        ...(input.detailPath !== undefined ? { detailPath: input.detailPath } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      },
      {
        newId: randomUUID(),
        nowIso: new Date().toISOString(),
        ...(ctx.job.sessionId !== undefined ? { sourceSessionId: ctx.job.sessionId } : {}),
      },
    );
  });

  if (outcome.outcome === 'noop' && outcome.entry) {
    const { activeCount, candidateCount } = counts(outcome.state.register);
    return await successWithData(ctx, {
      entryId: outcome.entry.id,
      status: outcome.entry.status,
      noop: true,
      activeCount,
      candidateCount,
      note: `An identical ${outcome.entry.kind} entry already exists (status: ${outcome.entry.status}).`,
    });
  }
  if (outcome.outcome === 'saved' && outcome.entry) {
    const { activeCount, candidateCount } = counts(outcome.register);
    return await successWithData(ctx, {
      entryId: outcome.entry.id,
      status: outcome.entry.status,
      noop: false,
      activeCount,
      candidateCount,
      note:
        'Recorded as a candidate. It is NOT yet part of your standing context — ' +
        'the user must promote it from the space settings before it appears.',
    });
  }
  return await terminalFailure(ctx, outcome, spaceId);
}

export async function handleContextList(
  ctx: ExecutorContext,
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  spaceId: string,
): Promise<StepResult> {
  const state = await loadActiveMemorySpaceState(db, tenantCtx, spaceId);
  if (!state) {
    return await failureWithError(ctx, validationError(`Space ${spaceId} not found`));
  }
  const nowMs = Date.now();
  const entries = state.register.entries.map((e) => ({
    entryId: e.id,
    kind: e.kind,
    statement: e.statement,
    status: e.status,
    expired: e.expiresAt !== undefined && Date.parse(e.expiresAt) <= nowMs,
  }));
  return await successWithData(ctx, { entries });
}

export async function handleContextForget(
  ctx: ExecutorContext,
  db: PostgresJsDatabase,
  tenantCtx: TenantContext,
  input: MemoryContextForgetInput,
  spaceId: string,
): Promise<StepResult> {
  // Active memory is the agent's own working memory: it may forget any entry it
  // holds (candidate or promoted) — a stale or wrong note should be removable.
  // Deletion is not a trust boundary; injection is (promotion, user-only). Hard,
  // permanent rules the agent cannot remove live in directives/guardrails.
  const outcome = await mutateActiveMemoryRegister(db, tenantCtx, spaceId, (state) => {
    const mutation = admitForget(state.register, input.entryId);
    if (!mutation.ok) return mutation;
    return mutation.removed
      ? { ok: true, register: mutation.register, noop: false }
      : { ok: true, register: state.register, noop: true };
  });

  if (outcome.outcome === 'noop') {
    const { activeCount, candidateCount } = counts(outcome.state.register);
    return await successWithData(ctx, { removed: false, activeCount, candidateCount });
  }
  if (outcome.outcome === 'saved') {
    const { activeCount, candidateCount } = counts(outcome.register);
    return await successWithData(ctx, { removed: true, activeCount, candidateCount });
  }
  return await terminalFailure(ctx, outcome, spaceId);
}
