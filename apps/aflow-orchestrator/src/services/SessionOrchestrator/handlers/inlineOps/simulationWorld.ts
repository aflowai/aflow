/**
 * The world half of the simulation control plane: loading a seed world,
 * reconstructing the world a run saw, and promoting a warm world into a
 * baseline.
 *
 * All three fold the same journal through the same function. The journal is the
 * source of truth, so an inspector that folded differently from the executor
 * would describe a world the agent never saw, and a freeze that folded
 * differently would promote one that never existed.
 */
import {
  SimulationFreezeInputSchema,
  SimulationInspectInputSchema,
  SimulationSeedInputSchema,
  type OperationId,
  type SimulationFreezeOutput,
  type SimulationInspectOutput,
  type SimulationSeedOutput,
} from '@aflow/schemas';
import {
  foldRunWorld,
  freezeSimulationBaseline,
  seedSimulationBaseline,
  SimulationBaselineRejected,
  SimulationWorldReadError,
  type SimulationWorldScope,
} from '@aflow/cybernetic-runtime';
import type { InlineHandlerArgs } from './types.js';
import { SimulationOpError, readSimulationRow, type SimulationScope } from './simulationStore.js';

/** The shared world-read scope, assembled from what an inline op is handed. */
function worldScope(args: InlineHandlerArgs, scope: SimulationScope): SimulationWorldScope {
  return {
    db: scope.db,
    redis: args.redis,
    payloadStore: args.payloadStore,
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
  };
}

/**
 * The shared writer's refusal, restated as this plane's error.
 *
 * Only the wrapper is here. The rules it enforces — mint, never rewrite; carry
 * forward through the process; hold the whole post-copy world to the current
 * declarations — live in `@aflow/cybernetic-runtime` so the operator's screen
 * enforces the same ones.
 */
function asOpError(error: unknown): unknown {
  return error instanceof SimulationBaselineRejected
    ? new SimulationOpError(error.code, error.message, error.kind, error.details)
    : error;
}

async function seedBaseline(scope: SimulationScope, input: unknown): Promise<SimulationSeedOutput> {
  const parsed = SimulationSeedInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw SimulationOpError.invalidInput(parsed.error);
  const { simulation } = await readSimulationRow(scope, parsed.data.simulationId);
  try {
    return await seedSimulationBaseline(scope, simulation, parsed.data);
  } catch (error) {
    throw asOpError(error);
  }
}

async function freezeBaseline(
  args: InlineHandlerArgs,
  scope: SimulationScope,
  input: unknown,
): Promise<SimulationFreezeOutput> {
  const parsed = SimulationFreezeInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw SimulationOpError.invalidInput(parsed.error);
  const { simulation } = await readSimulationRow(scope, parsed.data.simulationId);
  try {
    return await freezeSimulationBaseline(scope, worldScope(args, scope), simulation, parsed.data);
  } catch (error) {
    throw asOpError(error);
  }
}

async function inspectWorld(
  args: InlineHandlerArgs,
  scope: SimulationScope,
  input: unknown,
): Promise<SimulationInspectOutput> {
  const parsed = SimulationInspectInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw SimulationOpError.invalidInput(parsed.error);

  try {
    return await foldRunWorld(worldScope(args, scope), parsed.data);
  } catch (error) {
    if (error instanceof SimulationWorldReadError) {
      throw new SimulationOpError(error.code, error.message, error.kind);
    }
    throw error;
  }
}

export async function handleSimulationWorldOp(
  args: InlineHandlerArgs,
  scope: SimulationScope,
  operationId: OperationId,
  input: unknown,
): Promise<{ output: Record<string, unknown>; mutated: boolean }> {
  switch (operationId) {
    case 'integration.simulation.seed':
      return { output: await seedBaseline(scope, input), mutated: true };
    case 'integration.simulation.freeze':
      return { output: await freezeBaseline(args, scope, input), mutated: true };
    case 'integration.simulation.inspect':
      return { output: await inspectWorld(args, scope, input), mutated: false };
    default:
      throw new SimulationOpError(
        'SIMULATION_OP_UNKNOWN',
        `Unknown simulation operation: ${operationId}`,
        'validation',
      );
  }
}
