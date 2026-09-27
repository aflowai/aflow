import type { ApiBinding, ApiDefinition } from '../models/apiDefinition.js';
import type { Simulation } from './simulation.js';

/**
 * Cross-object invariants that keep the fulfillment model from admitting
 * states with no behaviour. They span binding, definition and simulation, so
 * no single schema's `superRefine` can carry them — this is the one authority,
 * called at write time and again at resolve.
 */
export interface FulfillmentViolation {
  code:
    | 'simulation_missing'
    | 'simulation_target_mismatch'
    | 'call_mode_not_endpoint'
    | 'definition_has_no_endpoints';
  message: string;
}

export function validateSimulatedBinding(params: {
  binding: Pick<ApiBinding, 'bindingId' | 'apiId' | 'fulfillment'>;
  definition: Pick<ApiDefinition, 'apiId' | 'callMode' | 'endpoints'> | undefined;
  simulation: Pick<Simulation, 'simulationId' | 'targets'> | undefined;
}): FulfillmentViolation[] {
  const { binding, definition, simulation } = params;
  if (binding.fulfillment.mode !== 'simulated') return [];

  const violations: FulfillmentViolation[] = [];

  if (!simulation) {
    violations.push({
      code: 'simulation_missing',
      message: `Binding "${binding.bindingId}" declares simulated fulfillment but simulation "${binding.fulfillment.simulationId}" does not exist in this space.`,
    });
  } else if (simulation.targets.integrationId !== binding.apiId) {
    // A binding pointing at a simulation for a different API has no defined
    // meaning: its endpoints, response schemas and world effects describe
    // another contract entirely.
    violations.push({
      code: 'simulation_target_mismatch',
      message: `Simulation "${simulation.simulationId}" targets API "${simulation.targets.integrationId}", but binding "${binding.bindingId}" is bound to "${binding.apiId}". A simulation may only fulfill its own definition.`,
    });
  }

  if (definition) {
    // A direct_url definition declares no endpoints by construction, so it
    // carries no input contract, no response schema and no risk tier — there
    // is nothing for the ladder to answer with.
    if (definition.callMode === 'direct_url') {
      violations.push({
        code: 'call_mode_not_endpoint',
        message: `API "${definition.apiId}" is a direct_url definition, which declares no endpoints and therefore no contract to simulate. Only an endpoint-mode definition can be simulated.`,
      });
    } else if (definition.endpoints.length === 0) {
      violations.push({
        code: 'definition_has_no_endpoints',
        message: `API "${definition.apiId}" declares no endpoints, so a simulation has nothing to fulfill.`,
      });
    }
  }

  return violations;
}
