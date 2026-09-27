/**
 * What actually answered a call, written by the executor that answered it.
 *
 * A binding's fulfillment can be re-pointed between the moment a tool step is
 * lowered and the moment it is dispatched, and the executor resolves
 * fulfillment again at call time — so anything derived from the lowered step
 * is a claim about the past. This report is the account that cannot disagree
 * with what ran, and it is the only source the simulated marker is read from.
 */
import { z } from 'zod';

export const SimulatedFulfillmentReportSchema = z.object({
  /** The binding whose simulated fulfillment answered the call. */
  bindingId: z.string().min(1).max(256),
  /** The simulation that produced the answer. */
  simulationId: z.string().min(1).max(256),
});

export type SimulatedFulfillmentReport = z.infer<typeof SimulatedFulfillmentReportSchema>;
