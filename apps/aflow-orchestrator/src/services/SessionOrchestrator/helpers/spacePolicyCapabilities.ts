import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { spaces } from '@aflow/database';

/**
 * What a space says about a policy-gated step type.
 *
 * Three states, not two, because the readers disagree about the third and are
 * entitled to. A space carrying no policy at all is not the same as one whose
 * operator switched it off: the compute executor runs an absent policy and
 * refuses only an explicit `enabled: false`, while the design surface treats
 * anything short of an explicit yes as no. Collapsing `unset` into either
 * reading silently moves one of them.
 *
 * `spaces` rows created through the agent-facing `space.manage.create` carry no
 * compute policy, so `unset` is reachable and not a migration artefact.
 */
export type SpacePolicyState = 'enabled' | 'disabled' | 'unset';

function stateOf(policy: unknown): SpacePolicyState {
  const enabled = (policy as { enabled?: boolean } | null | undefined)?.enabled;
  if (enabled === true) return 'enabled';
  if (enabled === false) return 'disabled';
  return 'unset';
}

/** Policy state per step type, for the step types a space policy can gate. */
export async function resolveSpacePolicyStates(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<Map<string, SpacePolicyState>> {
  const states = new Map<string, SpacePolicyState>();

  const [computeRow] = await tx
    .select({ computePolicy: spaces.computePolicy })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId)));
  states.set('compute', stateOf(computeRow?.computePolicy));

  // An image can deploy ahead of the tenant migration that adds this column, and
  // a policy this space cannot read is not a policy of no — it is one nobody has
  // expressed, which is what `unset` says.
  //
  // Asked of the catalogue rather than attempted and caught: every caller runs
  // inside `withTenantSchema`, which is a transaction, and a statement naming a
  // column that does not exist aborts it. Catching the error rescues nothing —
  // the transaction is already poisoned and fails at commit, taking the caller's
  // own work with it.
  const columnPresent = await tx.execute(sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'spaces'
      AND column_name = 'code_policy'
    LIMIT 1
  `);

  if (columnPresent.length > 0) {
    const [codeRow] = await tx
      .select({ codePolicy: spaces.codePolicy })
      .from(spaces)
      .where(eq(spaces.id, spaceId));
    states.set('code', stateOf(codeRow?.codePolicy));
  } else {
    states.set('code', 'unset');
  }

  // The host lane needs no switch of its own, because it already has one that
  // says more. Compute and the coding lane are on or off for a whole space —
  // nothing narrower exists to express — so they need a flag. A host binding is
  // already the operator naming one folder, on this instance and on the machine,
  // and a space with none reaches nothing whatever a flag said. So the bindings
  // are the policy: some means enabled, none means nobody has expressed
  // anything, which is what `unset` is for.
  const tablePresent = await tx.execute(sql`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'host_bindings'
    LIMIT 1
  `);
  if (tablePresent.length > 0) {
    const connected = await tx.execute(sql`
      SELECT 1 FROM host_bindings WHERE space_id = ${spaceId}::uuid LIMIT 1
    `);
    states.set('host', connected.length > 0 ? 'enabled' : 'unset');
  } else {
    states.set('host', 'unset');
  }

  return states;
}

/**
 * The step types explicitly switched on — the design surface's reading, where
 * anything short of a yes is a no.
 */
export async function resolveEnabledSpacePolicies(
  tx: PostgresJsDatabase,
  spaceId: string,
): Promise<Set<string>> {
  const states = await resolveSpacePolicyStates(tx, spaceId);
  return new Set([...states].filter(([, state]) => state === 'enabled').map(([type]) => type));
}
