import type { McpElicitationEntry, SessionEvent } from '../../types.js';

/** Slice of run-view state touched by MCP elicitation events. */
export interface McpElicitationStateSlice {
  mcpElicitations: Record<string, McpElicitationEntry>;
}

export function applyMcpElicitationEvent<T extends McpElicitationStateSlice>(
  state: T,
  event: SessionEvent,
): T {
  let next = state;

  if (event.eventType === 'McpElicitationRequested' && event.metadata) {
    const meta = event.metadata as {
      elicitationId?: unknown;
      bindingId?: unknown;
      serverId?: unknown;
      request?: unknown;
      leaseExpiresAt?: unknown;
    };
    const elicitationId = typeof meta.elicitationId === 'string' ? meta.elicitationId : null;
    const request =
      meta.request && typeof meta.request === 'object'
        ? (meta.request as {
            mode?: unknown;
            message?: unknown;
            requestedSchema?: unknown;
            url?: unknown;
          })
        : null;
    const mode = request?.mode;
    const stepExecutionId = event.stepExecutionId;
    if (
      elicitationId &&
      stepExecutionId &&
      typeof meta.bindingId === 'string' &&
      typeof meta.serverId === 'string' &&
      typeof meta.leaseExpiresAt === 'string' &&
      request &&
      (mode === 'form' || mode === 'url') &&
      typeof request.message === 'string'
    ) {
      const entry: McpElicitationEntry = {
        elicitationId,
        stepExecutionId,
        bindingId: meta.bindingId,
        serverId: meta.serverId,
        mode,
        message: request.message,
        leaseExpiresAt: meta.leaseExpiresAt,
        ...(mode === 'form' && request.requestedSchema
          ? { requestedSchema: request.requestedSchema as Record<string, unknown> }
          : {}),
        ...(mode === 'url' && typeof request.url === 'string' ? { url: request.url } : {}),
      };
      next = {
        ...next,
        mcpElicitations: { ...next.mcpElicitations, [elicitationId]: entry },
      };
    }
  }

  if (
    (event.eventType === 'McpElicitationResolved' ||
      event.eventType === 'McpElicitationTimedOut' ||
      event.eventType === 'McpElicitationExecutorLost') &&
    event.metadata
  ) {
    const elicitationId = (event.metadata as { elicitationId?: unknown }).elicitationId;
    if (typeof elicitationId === 'string' && Object.hasOwn(next.mcpElicitations, elicitationId)) {
      const rest = { ...next.mcpElicitations };
      delete rest[elicitationId];
      next = { ...next, mcpElicitations: rest };
    }
  }

  if (
    (event.eventType === 'StepSucceeded' ||
      event.eventType === 'StepFailed' ||
      event.eventType === 'StepCompleted') &&
    event.stepExecutionId &&
    Object.keys(next.mcpElicitations).length > 0
  ) {
    const owningStep = event.stepExecutionId;
    const remaining: Record<string, McpElicitationEntry> = {};
    let changed = false;
    for (const [id, entry] of Object.entries(next.mcpElicitations)) {
      if (entry.stepExecutionId === owningStep) {
        changed = true;
        continue;
      }
      remaining[id] = entry;
    }
    if (changed) next = { ...next, mcpElicitations: remaining };
  }

  return next;
}
