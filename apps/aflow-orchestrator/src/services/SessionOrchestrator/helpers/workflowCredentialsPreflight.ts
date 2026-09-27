/**
 * Workflow run pre-flight: credentials check.
 *
 * Walks a `Workflow`'s task grants, looks up each unique `(apiId, bindingId)`
 * in `api_bindings`, and verifies the binding is in a state that can
 * actually call the API at runtime — i.e. the `auth_json` is structurally
 * valid AND every required credential key has a populated row in
 * `api_credentials`.
 *
 * Why this exists
 * ---------------
 *
 * Today's loop:
 *
 *  1. `bind-capability` ratification creates the API definition AND a
 *     placeholder binding (`{ kind: 'api_key' }` — non-canonical shape).
 *  2. `prepare-design-surface` sees `bindings.length > 0` and treats the
 *     binding as `bound: true`, so compose-skill happily authors a workflow
 *     that grants endpoints from this binding.
 *  3. The user ratifies the skill.
 *  4. The user runs the skill.
 *  5. **Deep inside the workflow** the runner's `api.http.call` fails with
 *     a confusing 4xx because `auth_json` was never canonicalized OR
 *     `api_credentials` has no row for the credential key.
 *
 * The right place to catch this is at `workflow.run.start` — before any
 * task scheduling, with a single message naming all uncredentialled
 * bindings + a deep link to /integrations. The user fixes once and reruns
 * cleanly. No more "I added the cred but step 4 still failed because
 * step 1's cache" debug spirals.
 *
 * Out of scope (deliberately): MCP server bindings — the same gap exists,
 * but MCP credential storage is a different surface (mcp_server_bindings
 * + auth headers via OAuth/Bearer). Not load-bearing for the Kaggle test
 * session; will land in a follow-up.
 */
import type { CallerContext, RunAccessGrant, TenantId, Workflow } from '@aflow/schemas';
import { checkMissingCapabilities } from '@aflow/cybernetic-runtime';
import {
  AuthProfileSchema,
  getOperation,
  grantDecisionForOperation,
  type AuthProfile,
} from '@aflow/schemas';
import {
  apiBindings,
  apiCredentials,
  createTenantContext,
  withTenantSchema,
} from '@aflow/database';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';

// ============================================================================
// Public types
// ============================================================================

/**
 * One uncredentialled binding referenced by the workflow. The `reason`
 * distinguishes paths the user can take to fix it; the prompt copy at the
 * call site uses the reason to tailor the action.
 */
export interface MissingCredentialBinding {
  apiId: string;
  bindingId: string;
  reason:
    | 'binding-not-found' // bindingId in workflow does not exist in api_bindings
    | 'binding-disabled' // binding exists but enabled = 0
    | 'auth-malformed' // auth_json doesn't parse — likely the bind-capability placeholder
    | 'credentials-missing'; // auth_json is canonical, but credential keys aren't populated
  /** Populated for `'credentials-missing'`. */
  missingCredentialKeys?: string[];
  /** Tasks in the workflow that grant this binding (for surface error messages). */
  consumingTaskIds: string[];
}

export interface WorkflowCredentialsPreflightResult {
  ok: boolean;
  missingBindings: MissingCredentialBinding[];
}

export interface WorkflowCapabilityPreflightResult {
  ok: boolean;
  /** Capability identifiers (integration capabilityId values) not bound in this space. */
  missingCapabilities: string[];
}

/** Map preflight rows into `buildResumeContract` blocked-bindings shape. */
export function toBlockedBindingsForResumeContract(
  missing: MissingCredentialBinding[],
): Array<{ bindingId: string; bindingName: string; missingFields: string[] }> {
  return missing.map((m) => ({
    bindingId: m.bindingId,
    bindingName: m.apiId,
    missingFields: m.missingCredentialKeys ?? [],
  }));
}

/**
 * Collect integration `capabilityId` values declared on workflow tasks.
 * Operation grants are profile-gated at dispatch time, not here.
 */
export function collectWorkflowIntegrationCapabilityIds(workflow: Workflow): string[] {
  const ids = new Set<string>();
  for (const task of workflow.tasks) {
    const integrations = task.context?.capabilities?.integrations;
    if (!integrations) continue;
    for (const grant of integrations) {
      if (grant.capabilityId) {
        ids.add(grant.capabilityId);
      }
    }
  }
  return [...ids];
}

export interface UngrantedWorkflowOperation {
  operationId: string;
  /** `enforceGrant`'s refusal — names the withheld group and the remedy. */
  reason: string;
  consumingTaskIds: string[];
}

export interface WorkflowOperationGrantPreflightResult {
  ok: boolean;
  ungrantedOperations: UngrantedWorkflowOperation[];
}

/**
 * Plan 302: an operation the run's grant would refuse must surface here as a
 * resumable pause, not as a silently smaller Runner toolbox four runs later.
 * Asks the exact question enforcement asks at dispatch: agent-declared
 * operations are judged as agent calls (the toolbox filter), operation tasks
 * as op-task calls (`decideStepGating`'s caller inference for `_taskId` steps).
 *
 * A null grant checks nothing, which is only safe because the CALLER
 * establishes authority first (`gateWorkflowOperationGrants`). Operation tasks
 * are enqueued directly and never reach `scheduleStep`, so nothing downstream
 * recompiles a missing grant on their behalf — passing null here straight from
 * storage would leave them ungated. Agent-declared `opTaskOnly` operations are
 * skipped: that is a space-independent contract defect (Plan 190's plane), not
 * a capability gap this space can close.
 */
export function checkWorkflowOperationGrantPreflight(
  grant: RunAccessGrant | null,
  workflow: Workflow,
): WorkflowOperationGrantPreflightResult {
  if (!grant) return { ok: true, ungrantedOperations: [] };

  const demands = new Map<string, { caller: CallerContext['kind']; taskIds: Set<string> }>();
  const addDemand = (operationId: string, caller: CallerContext['kind'], taskId: string): void => {
    const key = `${operationId}\0${caller}`;
    const existing = demands.get(key);
    if (existing) {
      existing.taskIds.add(taskId);
    } else {
      demands.set(key, { caller, taskIds: new Set([taskId]) });
    }
  };

  for (const task of workflow.tasks) {
    if (task.operation) {
      addDemand(task.operation, 'op_task', task.taskId);
    }
    // Legacy `tools` merges into the same Runner toolbox as
    // `capabilities.operations` (contextAssembler), so both face the same
    // grant filter. An id the registry does not know never becomes a tool at
    // all — no grant question exists for it, and judging it here would pause
    // runs enforcement lets through.
    for (const operationId of [
      ...(task.context?.capabilities?.operations ?? []),
      ...(task.context?.tools ?? []),
    ]) {
      const op = getOperation(operationId);
      if (!op || op.opTaskOnly) continue;
      addDemand(operationId, 'agent', task.taskId);
    }
  }

  const ungranted: UngrantedWorkflowOperation[] = [];
  for (const [key, demand] of demands) {
    const operationId = key.slice(0, key.indexOf('\0'));
    const decision = grantDecisionForOperation(grant, operationId, { kind: demand.caller });
    if (!decision.allowed) {
      ungranted.push({
        operationId,
        reason: decision.reason ?? 'not covered by the run access grant',
        consumingTaskIds: [...demand.taskIds],
      });
    }
  }

  return { ok: ungranted.length === 0, ungrantedOperations: ungranted };
}

export async function checkWorkflowCapabilityPreflight(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  workflow: Workflow,
  spaceId: string,
): Promise<WorkflowCapabilityPreflightResult> {
  const required = collectWorkflowIntegrationCapabilityIds(workflow);
  if (required.length === 0) {
    return { ok: true, missingCapabilities: [] };
  }
  const missing = await checkMissingCapabilities(
    { db, tenantId: tenantId as string, spaceId },
    required,
  );
  return { ok: missing.length === 0, missingCapabilities: missing };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Required credential keys for a parsed AuthProfile. `'none'` returns an
 * empty array — no credentials needed.
 */
function collectRequiredCredentialKeys(auth: AuthProfile): string[] {
  switch (auth.type) {
    case 'none':
      return [];
    case 'api_key':
      return auth.credentialKey ? [auth.credentialKey] : [];
    case 'bearer':
      return auth.credentialKey ? [auth.credentialKey] : [];
    case 'api_key_pair': {
      const keys: string[] = [];
      if (auth.credentialKey) keys.push(auth.credentialKey);
      if (auth.secondaryCredentialKey) keys.push(auth.secondaryCredentialKey);
      return keys;
    }
    case 'basic': {
      const keys: string[] = [];
      if (auth.usernameCredentialKey) keys.push(auth.usernameCredentialKey);
      if (auth.passwordCredentialKey) keys.push(auth.passwordCredentialKey);
      return keys;
    }
    case 'oauth2_client_credentials': {
      const keys: string[] = [];
      if (auth.clientIdCredentialKey) keys.push(auth.clientIdCredentialKey);
      if (auth.clientSecretCredentialKey) keys.push(auth.clientSecretCredentialKey);
      return keys;
    }
    case 'oauth2_authorization_code':
      // 3-legged OAuth holds no api_credentials keys: per-owner tokens are
      // resolved server-side and the client secret lives in oauth_clients.
      // Readiness is consent/token presence, a separate axis from this
      // static-credential preflight.
      return [];
  }
}

/**
 * Returns true if a parsed AuthProfile has all its credential-key fields
 * declared (i.e. the binding has been operator-configured). A binding with
 * `{ type: 'api_key' }` and no `credentialKey` is structurally valid Zod-wise
 * but is the "needs configuration" state — we treat this as missing creds
 * because the runtime call will fail.
 */
function authHasDeclaredKeys(auth: AuthProfile): boolean {
  switch (auth.type) {
    case 'none':
      return true;
    case 'api_key':
    case 'bearer':
      return Boolean(auth.credentialKey);
    case 'api_key_pair':
      return Boolean(auth.credentialKey && auth.secondaryCredentialKey);
    case 'basic':
      return Boolean(auth.usernameCredentialKey && auth.passwordCredentialKey);
    case 'oauth2_client_credentials':
      return Boolean(auth.clientIdCredentialKey && auth.clientSecretCredentialKey);
    case 'oauth2_authorization_code':
      // No credential-key fields to declare; readiness is token/consent
      // presence (handled by the per-user consent path), not a missing key.
      return true;
  }
}

/**
 * Walk a workflow's task grants and build a `bindingId → { apiId, taskIds }`
 * index. `apiId` carried alongside the bindingId for surface error messages.
 *
 * A `{kind:'connection'}` grant defers to the run's pinned connection: it indexes
 * under `connectionBindingId` (the resolved connection), so that binding's
 * credential IS checked. When no connection is pinned (`connectionBindingId`
 * undefined) the connection grant contributes nothing — run-start already failed
 * if the connection was unresolvable.
 */
function indexWorkflowApiGrants(
  workflow: Workflow,
  connectionBindingId?: string,
): Map<string, { apiId: string; taskIds: Set<string> }> {
  const index = new Map<string, { apiId: string; taskIds: Set<string> }>();

  for (const task of workflow.tasks) {
    const grants = task.context?.capabilities?.integrations ?? [];
    for (const grant of grants) {
      if (grant.sourceKind !== 'api') continue;
      const bindingId =
        grant.binding.kind === 'binding' ? grant.binding.bindingId : connectionBindingId;
      if (bindingId === undefined) continue;
      const existing = index.get(bindingId);
      if (existing) {
        existing.taskIds.add(task.taskId);
      } else {
        index.set(bindingId, {
          apiId: grant.integrationId,
          taskIds: new Set([task.taskId]),
        });
      }
    }
  }

  return index;
}

/**
 * Pre-flight: are the workflow's API grants backed by usable credentials?
 *
 * Returns `{ ok: true, missingBindings: [] }` when every grant's binding
 * has populated credentials (or auth.type === 'none'). Returns
 * `{ ok: false, missingBindings }` listing each problem binding so the
 * caller can surface a single typed error to the user.
 *
 * This function makes one indexed DB roundtrip per (binding row, credential
 * row) batch. For a typical workflow (≤5 unique bindings) it is two queries.
 */
export async function checkWorkflowCredentialsPreflight(
  db: PostgresJsDatabase,
  tenantId: TenantId,
  workflow: Workflow,
  spaceId: string,
  connectionBindingId?: string,
): Promise<WorkflowCredentialsPreflightResult> {
  const grants = indexWorkflowApiGrants(workflow, connectionBindingId);
  if (grants.size === 0) {
    return { ok: true, missingBindings: [] };
  }

  const bindingIds = [...grants.keys()];
  const tenantCtx = createTenantContext(tenantId);

  const missing: MissingCredentialBinding[] = [];

  await withTenantSchema(db, tenantCtx, async (tx) => {
    // 1. Load every referenced binding in one query.
    //
    const bindingRows = await tx
      .select({
        bindingId: apiBindings.bindingId,
        apiId: apiBindings.apiId,
        authJson: apiBindings.authJson,
        enabled: apiBindings.enabled,
        fulfillmentMode: apiBindings.fulfillmentMode,
      })
      .from(apiBindings)
      .where(and(inArray(apiBindings.bindingId, bindingIds), eq(apiBindings.spaceId, spaceId)));

    const rowsByBindingId = new Map(bindingRows.map((r) => [r.bindingId, r]));

    // 2. Per-binding validation. Collect credential keys to look up.
    const allCredentialKeys = new Set<string>();
    const perBindingRequired = new Map<string, string[]>();

    for (const [bindingId, info] of grants) {
      const row = rowsByBindingId.get(bindingId);
      const taskIds = [...info.taskIds];

      if (!row) {
        missing.push({
          apiId: info.apiId,
          bindingId,
          reason: 'binding-not-found',
          consumingTaskIds: taskIds,
        });
        continue;
      }
      if (row.enabled !== 1) {
        missing.push({
          apiId: row.apiId,
          bindingId,
          reason: 'binding-disabled',
          consumingTaskIds: taskIds,
        });
        continue;
      }

      // A simulated binding reaches no host, so it needs no credential and its
      // auth profile may still be an unconfigured placeholder — kept populated
      // so promoting to live is one field rather than a re-entry of secrets.
      // Without this the workflow never starts and the feature is inert for
      // exactly the case it exists for.
      if (row.fulfillmentMode === 'simulated') {
        continue;
      }

      // Auth structural check. The bind-capability placeholder
      // (`{ kind: ... }`) doesn't parse — that's the diagnostic.
      const authParse = AuthProfileSchema.safeParse(row.authJson);
      if (!authParse.success) {
        missing.push({
          apiId: row.apiId,
          bindingId,
          reason: 'auth-malformed',
          consumingTaskIds: taskIds,
        });
        continue;
      }

      const auth = authParse.data;
      if (auth.type === 'none') {
        // No credentials needed.
        continue;
      }

      if (!authHasDeclaredKeys(auth)) {
        // Structurally valid auth, but no credential-key fields set —
        // operator hasn't configured the binding at /integrations yet.
        missing.push({
          apiId: row.apiId,
          bindingId,
          reason: 'credentials-missing',
          missingCredentialKeys: [],
          consumingTaskIds: taskIds,
        });
        continue;
      }

      const keys = collectRequiredCredentialKeys(auth);
      perBindingRequired.set(bindingId, keys);
      for (const key of keys) allCredentialKeys.add(key);
    }

    // 3. Batch-load credential rows for any keys we need to verify.
    if (allCredentialKeys.size > 0) {
      const credRows = await tx
        .select({
          credentialKey: apiCredentials.credentialKey,
          encryptedValue: apiCredentials.encryptedValue,
        })
        .from(apiCredentials)
        .where(
          and(
            inArray(apiCredentials.credentialKey, [...allCredentialKeys]),
            eq(apiCredentials.spaceId, spaceId),
          ),
        );

      const populatedKeys = new Set<string>();
      for (const row of credRows) {
        // A key with an empty `encryptedValue` is treated as missing — same
        // as no row at all. The /integrations UI shouldn't write empty rows
        // but we're conservative.
        if (row.encryptedValue && row.encryptedValue.length > 0) {
          populatedKeys.add(row.credentialKey);
        }
      }

      for (const [bindingId, requiredKeys] of perBindingRequired) {
        const missingKeys = requiredKeys.filter((k) => !populatedKeys.has(k));
        if (missingKeys.length > 0) {
          const info = grants.get(bindingId)!;
          const apiId = rowsByBindingId.get(bindingId)?.apiId ?? info.apiId;
          missing.push({
            apiId,
            bindingId,
            reason: 'credentials-missing',
            missingCredentialKeys: missingKeys,
            consumingTaskIds: [...info.taskIds],
          });
        }
      }
    }
  });

  return { ok: missing.length === 0, missingBindings: missing };
}

// ============================================================================
// User-facing message rendering
// ============================================================================

const INTEGRATIONS_URL_HINT = '/integrations';

export function renderPreflightFailureMessage(
  workflowSlug: string,
  result: WorkflowCredentialsPreflightResult,
): string {
  if (result.ok) return '';

  const lines: string[] = [`Cannot run "${workflowSlug}" — credentials are missing or unusable:`];

  const bindingNotFound = result.missingBindings.filter((m) => m.reason === 'binding-not-found');
  const bindingDisabled = result.missingBindings.filter((m) => m.reason === 'binding-disabled');
  const authMalformed = result.missingBindings.filter((m) => m.reason === 'auth-malformed');
  const credsMissing = result.missingBindings.filter((m) => m.reason === 'credentials-missing');

  if (authMalformed.length > 0) {
    lines.push(
      `- Placeholder bindings (re-run bind-capability to finalize): ${authMalformed
        .map((m) => `${m.apiId} (binding=${m.bindingId})`)
        .join(', ')}`,
    );
  }
  if (credsMissing.length > 0) {
    const detail = credsMissing
      .map((m) => {
        const keyHint =
          m.missingCredentialKeys && m.missingCredentialKeys.length > 0
            ? ` — credential key(s): ${m.missingCredentialKeys.join(', ')}`
            : '';
        return `${m.apiId} (binding=${m.bindingId})${keyHint}`;
      })
      .join('; ');
    lines.push(`- Needs credentials at ${INTEGRATIONS_URL_HINT}: ${detail}`);
  }
  if (bindingNotFound.length > 0) {
    lines.push(
      `- Binding does not exist (workflow references a stale or deleted binding): ${bindingNotFound
        .map((m) => `${m.apiId} (binding=${m.bindingId})`)
        .join(', ')}`,
    );
  }
  if (bindingDisabled.length > 0) {
    lines.push(
      `- Binding is disabled (re-enable in Settings → Integrations): ${bindingDisabled
        .map((m) => `${m.apiId} (binding=${m.bindingId})`)
        .join(', ')}`,
    );
  }

  // Cross-reference which task(s) granted each missing binding so the user
  // can decide whether to fix the credentials or revise the workflow.
  const taskRefs = result.missingBindings
    .filter((m) => m.consumingTaskIds.length > 0)
    .map((m) => `${m.apiId} ← task(s) ${m.consumingTaskIds.join(', ')}`)
    .join('; ');
  if (taskRefs) {
    lines.push(`Granted by: ${taskRefs}`);
  }

  return lines.join('\n');
}

/**
 * Capability preflight failure copy for start/resume acknowledge gates.
 */
export function renderCapabilityPreflightFailureMessage(
  workflowSlug: string,
  result: WorkflowCapabilityPreflightResult,
): string {
  if (result.ok) return '';
  return (
    `Cannot run "${workflowSlug}" — integration capabilities are not bound in this space: ` +
    `${result.missingCapabilities.join(', ')}. ` +
    'Bind the capability (bind-capability / integrations) and acknowledge again.'
  );
}
