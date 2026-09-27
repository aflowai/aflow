/**
 * How a step fulfilled by a simulation says so.
 *
 * Marking is honest reporting, not containment — and it is only honest if it
 * describes what ran. A binding can be re-fulfilled between the moment a tool
 * step is lowered and the moment it is dispatched, so the executor's own
 * account of the fulfillment it resolved is the single source: reading the
 * step's dispatch metadata instead badges a live call as a rehearsal whenever
 * the promotion goes one way, and lets a rehearsal pass as measured fact
 * whenever it goes the other.
 */
import type { SimulatedFulfillmentReport } from '@aflow/schemas';

/** What a step's events carry about its fulfillment, for the timeline badge and the run banner. */
export function simulatedFulfillmentEventMeta(
  report: SimulatedFulfillmentReport | null | undefined,
): { simulated: true; simulatedBindingId: string } | undefined {
  if (!report) return undefined;
  return { simulated: true, simulatedBindingId: report.bindingId };
}
