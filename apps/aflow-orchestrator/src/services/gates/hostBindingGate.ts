/**
 * The appliance's half of a host binding, checked where it can still refuse.
 *
 * The two halves are meant to intersect: a folder is reachable only where the
 * machine offers it AND the workspace has connected it. The machine's half is
 * checked by the executor on every operation. The appliance's half was checked
 * once, at connect time, and never again — so deleting the row revoked nothing,
 * and the space gate asked only whether the space had *some* binding, which let
 * a run name any id its machine happened to carry.
 *
 * This is the missing half. It runs where the step's input has been resolved
 * and before anything is enqueued: the last point at which a refusal costs
 * nothing, and the first at which the binding id is known.
 */
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Operations whose input names a binding this gate must confirm.
 *
 * Listed rather than derived from a prefix, so adding a host operation is a
 * decision about whether it carries a binding rather than something that
 * happens silently. A guard test keeps this level with the registry.
 */
const BINDING_INPUT_OPERATIONS = new Set([
  'host.file.list',
  'host.file.get',
  'host.file.put',
  'host.file.patch',
  'host.process.exec',
  'host.process.inspect',
  'host.process.stop',
  'host.process.input',
  'host.harness.run',
  'host.mcp.list_tools',
  'host.mcp.call',
  'host.binding.inspect',
  'host.commit.scan',
  'host.commit.check',
]);

export interface HostBindingGateResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

const ALLOWED: HostBindingGateResult = { allowed: true };

/** Pull the binding id out of a resolved input without trusting its shape. */
function bindingIdOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)['bindingId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Confirm the workspace still has this binding. Anything that is not a host
 * operation naming one passes through untouched — this gate answers a single
 * question and must not grow into a second capability system.
 */
export async function checkHostBinding(params: {
  operationId: string;
  spaceId: string | undefined;
  resolvedInput: unknown;
  tx: PostgresJsDatabase;
}): Promise<HostBindingGateResult> {
  if (!BINDING_INPUT_OPERATIONS.has(params.operationId)) return ALLOWED;

  const bindingId = bindingIdOf(params.resolvedInput);
  if (bindingId === undefined) {
    // The executor's schema validation reports a missing binding far better
    // than this can, and refusing here would turn a validation error into a
    // permission one.
    return ALLOWED;
  }
  if (params.spaceId === undefined) {
    return {
      allowed: false,
      reason:
        `This run names no workspace, so \`${bindingId}\` cannot be confirmed as one of its ` +
        'connected folders.',
    };
  }

  const rows = await params.tx.execute(sql`
    SELECT 1 FROM host_bindings
    WHERE space_id = ${params.spaceId}::uuid AND host_binding_id = ${bindingId}
    LIMIT 1
  `);
  if (rows.length > 0) return ALLOWED;

  return {
    allowed: false,
    // Deliberately silent about whether the id exists elsewhere: saying so
    // would make this a way to enumerate another workspace's folders.
    reason: `\`${bindingId}\` is not a folder this workspace has connected.`,
  };
}

/** Exported so a guard test can keep this list level with the operation registry. */
export const HOST_BINDING_GATED_OPERATIONS: ReadonlySet<string> = BINDING_INPUT_OPERATIONS;
