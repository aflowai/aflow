/**
 * Who the agent is told it is talking to.
 *
 * A real assistant embedded in an authenticated product receives its caller
 * from the session — it does not open by asking for a customer id. Withholding
 * that from a simulated run does not make the test stricter, it rehearses a
 * conversation the deployment never has. So a simulation may disclose its
 * caller, and a run may override the answer either way, because "verify who you
 * are talking to" is itself a scenario worth being able to test.
 *
 * Two things this deliberately never says. It never discloses that the binding
 * is SIMULATED — that would change the behaviour being measured, which is the
 * one leak Plan 293 §5.11 forbids. And it never carries the persona's `brief`:
 * a brief states account facts, and an agent handed those can answer from them
 * without calling anything, passing a scenario it never exercised. `discloseCaller`
 * is the only writer of the disclosed shape, so withholding is the default for
 * any field added to a persona later.
 *
 * Resolved ONCE at run start rather than per turn, for the reason the world's
 * revision and baseline are pinned: an operator editing a simulation mid-run
 * must not change who the agent has spent the conversation being.
 */
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { apiBindings, simulations, withTenantSchema } from '@aflow/database';
import type { TenantContext } from '@aflow/database';
import {
  DisclosedCallerSchema,
  SimulationSchema,
  actingPersonaId,
  discloseCaller,
  type DisclosedCaller,
  type DisclosedCallerBinding,
  type Simulation,
  type SimulationRunInput,
} from '@aflow/schemas';

/**
 * Whether this run discloses, and if so, who.
 *
 * `null` means the agent is told nothing and has to establish identity the way
 * a phone desk does — a scenario, not a gap.
 */
export function resolveCallerForSimulation(
  simulation: Simulation,
  runInput?: SimulationRunInput,
): DisclosedCaller | null {
  const discloses =
    runInput?.disclosePersonas?.[simulation.simulationId] ?? simulation.disclosePersona;
  if (!discloses) return null;

  const personaId = actingPersonaId(simulation, runInput);
  // Nobody has no identity to disclose. Disclosing the default here would tell
  // the agent it is someone whose rows it cannot read.
  if (personaId === null) return null;

  const persona = simulation.personas.find((candidate) => candidate.personaId === personaId);
  if (!persona) return null;

  return discloseCaller(persona);
}

/**
 * Resolve every caller this run should be told about.
 *
 * One query, and it returns nothing for the overwhelming majority of spaces —
 * a space with no simulated binding does no further work.
 *
 * Returns the space's enabled simulated bindings, which is the widest set this
 * run could reach. It is deliberately not the final one: the connection
 * allowlist that decides what a given turn can call is resolved per turn, so
 * the render site narrows this to the reachable integrations. Resolving happens
 * here anyway because the answer must not move mid-run, and narrowing a fixed
 * set is safe in a way re-resolving it would not be.
 */
export async function resolveDisclosedCallers(params: {
  db: PostgresJsDatabase;
  tenantCtx: TenantContext;
  spaceId: string;
  runInput?: SimulationRunInput | undefined;
}): Promise<DisclosedCallerBinding[]> {
  const { db, tenantCtx, spaceId, runInput } = params;

  const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
    tx
      .select({
        apiId: apiBindings.apiId,
        simulationId: simulations.simulationId,
        definitionJson: simulations.definitionJson,
      })
      .from(apiBindings)
      .innerJoin(
        simulations,
        and(
          eq(simulations.simulationId, apiBindings.simulationId),
          eq(simulations.spaceId, apiBindings.spaceId),
        ),
      )
      .where(
        and(
          eq(apiBindings.spaceId, spaceId),
          eq(apiBindings.fulfillmentMode, 'simulated'),
          eq(apiBindings.enabled, 1),
          eq(simulations.enabled, 1),
        ),
      ),
  );

  const seen = new Set<string>();
  const disclosed: DisclosedCallerBinding[] = [];
  for (const row of rows) {
    // One simulation can back several bindings; the caller is a property of the
    // simulation, so the second binding would disclose the same identity twice.
    if (seen.has(row.simulationId)) continue;
    seen.add(row.simulationId);

    const parsed = SimulationSchema.safeParse(row.definitionJson);
    if (!parsed.success) continue;
    const simulation = parsed.data;

    const caller = resolveCallerForSimulation(simulation, runInput);
    if (caller === null) continue;

    disclosed.push({ integrationId: row.apiId, caller });
  }

  return disclosed;
}

/**
 * The context block the agent reads.
 *
 * Rendered as the product's own session would state it — a caller, not a note
 * about a test. Nothing here distinguishes a simulated binding from a live one,
 * which is the point: an agent that behaves differently because it knows it is
 * being simulated has not been measured.
 */
export function renderDisclosedCallers(callers: readonly DisclosedCallerBinding[]): string {
  if (callers.length === 0) return '';
  const lines = callers.map((entry) => {
    const { personaId, label } = entry.caller;
    const who = label !== undefined ? `${label} (${personaId})` : personaId;
    return `- ${entry.integrationId}: ${who}`;
  });
  return [
    'The signed-in caller this session is acting for. Their identity is already',
    'established — do not ask them to identify themselves, and do not pass it as a',
    'parameter, because each service takes it from the session.',
    '',
    ...lines,
  ].join('\n');
}

/** Everything the disclosed shape may carry, so a leak has to be declared. */
export function disclosedCallerFields(): string[] {
  return Object.keys(DisclosedCallerSchema.shape).sort();
}

export type { DisclosedCaller, DisclosedCallerBinding };
