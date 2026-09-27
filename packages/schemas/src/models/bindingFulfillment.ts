import { z } from 'zod';

/**
 * How a binding's calls are fulfilled.
 *
 * `live` reaches the real host. `simulated` answers from a Simulation without
 * touching the network — the same definition, the same endpoints, the same
 * tool ids, the same risk tiers, so promoting to the real service is a field
 * on a row rather than a migration.
 *
 * Fulfillment is a DECLARATION, never a fallback: a live binding must not
 * degrade to simulated when the host is unreachable. An agent quietly
 * inventing balances during an outage is worse than one that fails, because
 * the failure is visible and the invention is not.
 *
 * Leaf module (zod only): imported by both `apiDefinition.ts` and the
 * `operations/platform.ts` upsert op without creating an import cycle through
 * `operations/api.ts` → `operations/platform.ts`.
 */
export const BindingFulfillmentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('live') }),
  z.object({
    mode: z.literal('simulated'),
    simulationId: z.string().min(1).max(128),
  }),
]);
export type BindingFulfillment = z.infer<typeof BindingFulfillmentSchema>;

export function isSimulatedFulfillment(
  fulfillment: BindingFulfillment | undefined,
): fulfillment is { mode: 'simulated'; simulationId: string } {
  return fulfillment?.mode === 'simulated';
}
