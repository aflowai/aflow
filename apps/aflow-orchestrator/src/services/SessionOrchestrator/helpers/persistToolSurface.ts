import type { Redis } from 'ioredis';
import { getSessionState, updateSessionState, type SessionHotState } from '@aflow/redis';
import { APPLET_TOOL_SPECS_VAR } from './appletToolMapper.js';
import { TOOL_SURFACE_VAR } from './agentTurn.js';

/**
 * Persist the per-turn tool surface that `buildAgentTurnInput` computed into
 * `runtimeState`. The virtual-tool lowering gate (`handleRunStepInline`) reads
 * this exact surface, and it must be durable BEFORE this turn's tool calls are
 * lowered — otherwise a tool the agent promoted on the prior turn (now admitted
 * to this turn's surface) is rejected with `TOOL_NOT_ON_SURFACE` because the
 * gate still sees the previous turn's surface.
 *
 * `buildAgentTurnInput` mutates `runtimeState` in place but the scheduler never
 * committed that mutation to Redis — this closes that gap. It field-merges ONLY
 * the surface var onto the authoritative latest state (re-read here); the turn's
 * other in-place mutations are carried by the turn-result patch, not persisted
 * here. Single-writer-per-run makes the read-merge-write race-free.
 */
export async function persistAgentTurnToolSurface(
  redis: Redis,
  tenantId: string,
  runId: string,
  stepId: string,
  runtimeState: SessionHotState['runtimeState'],
): Promise<void> {
  const surfaceKey = `${TOOL_SURFACE_VAR}.${stepId}`;
  const surfaceVar = runtimeState?.variables[surfaceKey];
  // The applet spec cache rides the same write: dispatch admits an applet
  // lowering only for a spec persisted THIS turn, and assembly's mutation of
  // the local runtimeState object never reaches Redis by itself — without
  // this, chess.move falls through to the generic run_step path and fails
  // as an unknown operation.
  const appletSpecsVar = runtimeState?.variables[APPLET_TOOL_SPECS_VAR];
  if (!surfaceVar && !appletSpecsVar) return;

  const latest = await getSessionState(redis, tenantId, runId);
  const latestRt = latest?.runtimeState;
  if (!latestRt) return;

  await updateSessionState(redis, tenantId, runId, {
    runtimeState: {
      ...latestRt,
      variables: {
        ...latestRt.variables,
        ...(surfaceVar ? { [surfaceKey]: surfaceVar } : {}),
        ...(appletSpecsVar ? { [APPLET_TOOL_SPECS_VAR]: appletSpecsVar } : {}),
      },
      version: latestRt.version + 1,
      updatedAtMs: Date.now(),
    },
  });
}
