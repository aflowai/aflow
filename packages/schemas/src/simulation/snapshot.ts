import { z } from 'zod';
import { ApiEndpointSchema } from '../models/apiDefinition.js';
import { SimulationSchema } from './simulation.js';

/**
 * The immutable artifact a run's simulated calls are answered from.
 *
 * The run context records which revision and which endpoint set answered a
 * call; this is the revision and the endpoint set themselves. Recording a
 * revision number while executing whatever the rows hold now is a pin in name
 * only — an edit mid-run would move the world the pin exists to hold still.
 *
 * Both halves are frozen together because both decide the answer: the
 * simulation supplies the rules, effects and collections, and the endpoint
 * supplies the response schema every simulated body is validated against.
 */
export const SimulationSnapshotSchema = z.object({
  simulation: SimulationSchema,
  /** Sorted by `endpointId`, so the set hashes to one value per content. */
  endpoints: z.array(ApiEndpointSchema),
});
export type SimulationSnapshot = z.infer<typeof SimulationSnapshotSchema>;
