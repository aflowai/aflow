import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  StreamKeys,
  DisclosedCallerBindingSchema,
  SimulationRunContextSchema,
  SimulationRunInputSchema,
  type DisclosedCallerBinding,
  type SimulationRunContext,
  type SimulationRunInput,
} from '@aflow/schemas';

/**
 * What a run's simulated world is pinned to, written at its first simulated
 * call and immutable afterwards.
 *
 * Pinning is what makes the world stand still: editing a rule, promoting a
 * baseline or bumping the API definition mid-run resolves against these values
 * rather than the current rows, so the agent's world cannot move under it.
 *
 * One hash field PER SIMULATION rather than one keyed map in a single field.
 * The pin-once guarantee is `HSETNX`, which is atomic on a field and has no
 * equivalent inside a value: adding a second simulation's entry to a map means
 * read-modify-write, and two simulations first called in one agent turn would
 * race, with the loser's pin silently dropped.
 */
export function simulationRunContextField(simulationId: string): string {
  return `simulationRunContextJson:${simulationId}`;
}

export function serializeSimulationRunContext(context: SimulationRunContext): string {
  return JSON.stringify(context);
}

export function parseSimulationRunContext(raw: string): SimulationRunContext | null {
  try {
    return SimulationRunContextSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function getSimulationRunContext(
  redis: Redis,
  tenantId: string,
  runId: string,
  simulationId: string,
): Promise<SimulationRunContext | null> {
  const raw = await redis.hget(
    StreamKeys.sessionStateKey(tenantId, runId),
    simulationRunContextField(simulationId),
  );
  if (!raw) return null;
  return parseSimulationRunContext(raw);
}

/**
 * Pin the context, returning whatever this run is pinned to for this
 * simulation.
 *
 * HSETNX rather than HSET: one agent turn can dispatch several simulated calls
 * at once, and a blind write would let the last of them re-seed the world the
 * first already answered from.
 */
export async function pinSimulationRunContext(
  redis: Redis,
  tenantId: string,
  runId: string,
  context: SimulationRunContext,
): Promise<SimulationRunContext> {
  const key = StreamKeys.sessionStateKey(tenantId, runId);
  const field = simulationRunContextField(context.simulationId);
  const created = await redis.hsetnx(key, field, serializeSimulationRunContext(context));
  if (created === 1) return context;

  const existingRaw = await redis.hget(key, field);
  const existing = existingRaw ? parseSimulationRunContext(existingRaw) : null;
  if (existing) return existing;

  await redis.hset(key, field, serializeSimulationRunContext(context));
  return context;
}

/**
 * What the run was STARTED with, as distinct from what it is pinned to.
 *
 * Written once, in the session-create literal, from the start-run command.
 * Read only when a simulation has no pin yet, so a run that already pinned its
 * world pays nothing for this. The agent has no route to it by construction —
 * a subject that could set its own seed would be choosing the environment it
 * is measured in.
 */
export const SIMULATION_RUN_INPUT_FIELD = 'simulationRunInputJson';

export async function getSimulationRunInput(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<SimulationRunInput | null> {
  const raw = await redis.hget(
    StreamKeys.sessionStateKey(tenantId, runId),
    SIMULATION_RUN_INPUT_FIELD,
  );
  if (!raw) return null;
  try {
    return SimulationRunInputSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Who the agent was told it is acting for, resolved once at run start.
 *
 * Written in the session-create literal for the reason the run input is: that
 * write DELs the hash, so anything stored ahead of it is discarded. Held here
 * rather than recomputed per turn because an operator editing a simulation
 * mid-run must not change who the agent has spent the conversation being.
 */
export const DISCLOSED_CALLERS_FIELD = 'simulationDisclosedCallersJson';

export function serializeDisclosedCallers(callers: readonly DisclosedCallerBinding[]): string {
  return JSON.stringify(callers);
}

export async function getDisclosedCallers(
  redis: Redis,
  tenantId: string,
  runId: string,
): Promise<DisclosedCallerBinding[]> {
  const raw = await redis.hget(
    StreamKeys.sessionStateKey(tenantId, runId),
    DISCLOSED_CALLERS_FIELD,
  );
  if (!raw) return [];
  try {
    return z.array(DisclosedCallerBindingSchema).parse(JSON.parse(raw));
  } catch {
    // A malformed disclosure is a colder start, not a wrong one: the agent asks
    // who it is speaking to. Failing the turn would be worse.
    return [];
  }
}
