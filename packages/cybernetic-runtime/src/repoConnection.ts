import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createTenantContext, withTenantSchema, repoBindings, apiBindings } from '@aflow/database';
import {
  formatRepoCoordinate,
  parseRepoCoordinate,
  type TenantId,
  type WorkflowTask,
  type IntegrationCapabilityGrant,
} from '@aflow/schemas';

export type RepoConnectionResolveCode = 'CONNECTION_MISSING' | 'CONNECTION_INVALID';

/**
 * A coding campaign's repo coordinate could not be resolved to a usable GitHub
 * connection. Distinct codes so the failure is legible at the surface that raised
 * it: CONNECTION_MISSING — the repo designation, or the connection it references,
 * is absent (the operator never linked one); CONNECTION_INVALID — a connection
 * exists but is unusable (non-github apiId, or disabled).
 */
export class RepoConnectionResolveError extends Error {
  readonly code: RepoConnectionResolveCode;
  constructor(code: RepoConnectionResolveCode, message: string) {
    super(message);
    this.name = 'RepoConnectionResolveError';
    this.code = code;
  }
}

/**
 * Resolve the GitHub connection (`api_bindings` row) a coding campaign's repo
 * coordinate resolves through (Plan 222 P3c): coordinate → repo designation (by
 * canonical coordinate, same space) → `connection_binding_id` → `api_bindings`
 * (same space) → assert `apiId==='github'` AND `enabled===1`. Returns the
 * connection's `bindingId`.
 *
 * Resolving ONCE at run-start lets a missing / bad connection surface as a clean,
 * fail-fast run-start failure (`RepoConnectionResolveError`) instead of failing
 * deep at `code.agent.run`. Shared so run-start and any future caller agree on the
 * coordinate → connection mapping and its error taxonomy.
 */
export async function resolveConnectionForRepoCoordinate(
  db: PostgresJsDatabase,
  tenantId: string,
  spaceId: string,
  coordinate: string,
): Promise<string> {
  const parsed = parseRepoCoordinate(coordinate);
  if (!parsed) {
    throw new RepoConnectionResolveError(
      'CONNECTION_MISSING',
      `"${coordinate}" is not a repo coordinate (owner/repo, host/owner/repo, or an https remote URL), so no GitHub connection could be resolved for it.`,
    );
  }
  const canonical = formatRepoCoordinate(parsed);
  const tenantCtx = createTenantContext(tenantId as TenantId);

  return withTenantSchema(db, tenantCtx, async (tx) => {
    const designationRows = await tx
      .select({
        connectionBindingId: repoBindings.connectionBindingId,
        status: repoBindings.status,
      })
      .from(repoBindings)
      .where(and(eq(repoBindings.coordinate, canonical), eq(repoBindings.spaceId, spaceId)));
    const designation = designationRows[0];
    if (!designation) {
      throw new RepoConnectionResolveError(
        'CONNECTION_MISSING',
        `No repo designation for "${canonical}" in space ${spaceId}. Designate the repo under a GitHub connection before starting a coding run.`,
      );
    }
    // Match the executor's git resolver (resolveRepoBinding): only a 'ready'
    // designation may drive a run. Without this the run-start fail-fast is
    // incomplete — a non-ready designation would pin a connection and then fail
    // DEEP at code.agent.run, the very deferred failure pinning-at-start prevents.
    if (designation.status !== 'ready') {
      throw new RepoConnectionResolveError(
        'CONNECTION_INVALID',
        `Repo "${canonical}" is not ready (status "${designation.status}") and cannot start a coding run.`,
      );
    }

    const connectionBindingId = designation.connectionBindingId;
    const connectionRows = await tx
      .select({ apiId: apiBindings.apiId, enabled: apiBindings.enabled })
      .from(apiBindings)
      .where(and(eq(apiBindings.bindingId, connectionBindingId), eq(apiBindings.spaceId, spaceId)));
    const connection = connectionRows[0];
    if (!connection) {
      throw new RepoConnectionResolveError(
        'CONNECTION_MISSING',
        `Repo "${canonical}" references GitHub connection "${connectionBindingId}", which was not found in space ${spaceId}. Re-link the repo to an existing GitHub connection.`,
      );
    }
    // Check order mirrors the executor's git resolver (enabled before apiId) so
    // both agree on the error a doubly-bad (disabled, non-github) connection raises.
    if (connection.enabled !== 1) {
      throw new RepoConnectionResolveError(
        'CONNECTION_INVALID',
        `The GitHub connection "${connectionBindingId}" for repo "${canonical}" is disabled. Re-enable it (or link the repo to an enabled GitHub connection) before starting a coding run.`,
      );
    }
    if (connection.apiId !== 'github') {
      throw new RepoConnectionResolveError(
        'CONNECTION_INVALID',
        `The connection "${connectionBindingId}" for repo "${canonical}" is not a GitHub connection (apiId="${connection.apiId}"). A coding repo must resolve through a github connection.`,
      );
    }
    return connectionBindingId;
  });
}

/**
 * Operation `api.http.call` tasks targeting GitHub that do NOT pin their binding
 * to the run's connection (Plan 222 P3d). A converted task's
 * `inputTemplate.bindingId: { $bind: <name> }` must resolve to a `connection_binding`
 * inputBinding of that exact `<name>`; a missing $bind, or a $bind to anything but a
 * connection_binding input, means the api executor would scope-resolve an arbitrary
 * GitHub account at dispatch (fail OPEN). Returns the offending `taskId`s — empty
 * means every github task is pinned.
 *
 * Used three ways: the exhaustive-conversion guard test asserts EMPTY for the
 * shipped coding skills; run-start fails a coding run closed when a FROZEN
 * installed skill (predating the connection model) yields offenders; and the
 * drift-guard test exercises both directions. Agent tasks that reach GitHub via
 * granted virtual tools are NOT operation tasks and are out of scope here — their
 * grant binding is resolved to the connection separately
 * (`resolveConnectionGrantsToBinding`).
 */
export function findUnpinnedGithubApiTasks(tasks: readonly WorkflowTask[]): string[] {
  const offenders: string[] = [];
  for (const task of tasks) {
    if (task.operation !== 'api.http.call') continue;
    const template = task.inputTemplate;
    if (template === undefined) continue;
    if (template['apiId'] !== 'github') continue;
    const bindingNode = template['bindingId'];
    const boundName =
      typeof bindingNode === 'object' &&
      bindingNode !== null &&
      typeof (bindingNode as Record<string, unknown>)['$bind'] === 'string'
        ? ((bindingNode as Record<string, unknown>)['$bind'] as string)
        : undefined;
    // The exact input that `bindingId` $binds must itself be a `connection_binding`
    // — not merely SOME connection_binding input on the task. A task whose bindingId
    // $binds an unrelated name (e.g. a task_output) while carrying a stray
    // connection_binding input elsewhere would otherwise pass yet scope-resolve the
    // bindingId at dispatch (fail OPEN).
    const pinnedToConnection =
      boundName !== undefined && task.inputBindings?.[boundName]?.kind === 'connection_binding';
    if (!pinnedToConnection) offenders.push(task.taskId);
  }
  return offenders;
}

/**
 * Resolve every `api` grant deferred to the run's connection (`binding.kind ===
 * 'connection'`) to the concrete pinned connection binding. Agent tasks (e.g.
 * pr-shepherd `rehydrate`) reach GitHub via granted virtual tools whose binding is
 * the grant's `binding` ref — so, unlike the operation tasks (pinned via a
 * `connection_binding` inputTemplate), a connection-deferred grant must be repointed
 * at the connection the campaign's repo resolves through, never a fixed account.
 * apiId-agnostic: any `{kind:'connection'}` api grant resolves to the run's single
 * pinned connection; `{kind:'binding'}` grants are returned untouched. Returns a NEW
 * array (the grant objects are shared registry/snapshot state — never mutate).
 */
export function resolveConnectionGrantsToBinding(
  integrations: readonly IntegrationCapabilityGrant[],
  connectionBindingId: string,
): IntegrationCapabilityGrant[] {
  return integrations.map((grant) =>
    grant.sourceKind === 'api' && grant.binding.kind === 'connection'
      ? { ...grant, binding: { kind: 'binding' as const, bindingId: connectionBindingId } }
      : grant,
  );
}
