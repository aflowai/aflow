/**
 * The coding agent a space prefers, carried to the machine that runs it
 * (Plan 325 D12).
 *
 * Read from the space's directives when a harness run is dispatched and
 * stamped on the job, never written into the step's input: there a harness is
 * one the caller requires, which the machine refuses rather than swaps, while
 * the space's choice is a preference the machine falls back from when it does
 * not have it installed.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { loadSpaceDirectives } from '@aflow/cybernetic-runtime';
import { buildOperationId } from '@aflow/schemas';

const HARNESS_RUN_OPERATION = buildOperationId('host', 'harness', 'run');

export async function preferredHarnessFor(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string | undefined,
  operationId: string,
): Promise<string | undefined> {
  if (operationId !== HARNESS_RUN_OPERATION || spaceId === undefined) return undefined;
  const directives = await loadSpaceDirectives(db, tenantId, spaceId);
  return directives?.codingHarness;
}
