import type postgres from 'postgres';
import { isValidSchemaName } from './context.js';
import { cascadeDeleteSpace, previewCascadeForSpace, type CascadeCounts } from './spaceCascade.js';
import {
  deriveUserReferenceColumns,
  USER_REFERENCE_POLICY,
  type UserReferencePolicy,
} from './userReferencePolicy.js';

/**
 * Erasure of a single human account across every tenant they belong to
 * (GDPR Art. 17).
 *
 * Two policies drive the shape of this module:
 *
 *   1. A space the user is alone in is purged. A space they own that other
 *      people are members of is TRANSFERRED to a tenant successor — erasure
 *      targets the person's data, not content their collaborators depend on.
 *   2. In spaces that survive, their authorship is cleared rather than deleted,
 *      so shared history stays coherent with no identifier left.
 *
 * Which columns those policies apply to is derived from the schema at runtime;
 * see `userReferencePolicy.ts`.
 */

export type AccountCascadeCounts = CascadeCounts;

/** The tenant's fallback space. Protected from purge exactly as `purgeSpace` protects it. */
const GENERAL_SLUG = 'general';

export interface AccountSpaceDisposition {
  spaceId: string;
  name: string;
  slug: string;
  /** Members other than the departing user. 0 → the user is alone in it. */
  otherMemberCount: number;
}

export interface AccountTenantPlan {
  tenantId: string;
  schemaName: string;
  role: string;
  /** The user is the only member — purged with the shared space cascade. */
  spacesToPurge: AccountSpaceDisposition[];
  /** Shared spaces the user owns — reassigned, never destroyed. */
  spacesToTransfer: Array<AccountSpaceDisposition & { transferToUserId: string }>;
  /**
   * Inherits the departing user's shared spaces and their authorship on NOT NULL
   * provenance columns. Null when the tenant has no other admin, which is a
   * blocker only if something in this tenant actually needs a successor.
   */
  successorUserId: string | null;
  /** Blast-radius preview, aggregated across `spacesToPurge`. */
  purgeCounts: AccountCascadeCounts;
}

export interface AccountDeletionPlan {
  userId: string;
  email: string | null;
  displayName: string;
  /** IdP identities to unlink after the database work (e.g. Auth0). */
  identities: Array<{ provider: string; providerSub: string }>;
  tenants: AccountTenantPlan[];
  /**
   * GCS key prefixes owned by the purged spaces' sessions. Payload objects are
   * keyed `tenants/<tenantId>/runs/<sessionId>/…` and no database cascade can
   * reach them, so the caller deletes these after the transaction commits.
   */
  payloadPrefixes: string[];
  /** Conditions that make the plan unexecutable. */
  blockers: string[];
}

export interface PlanAccountDeletionOptions {
  /** Overrides the derived successor when a tenant has no other admin. */
  transferToUserId?: string;
}

interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  kind: string;
}

/**
 * Build the full erasure plan without writing anything. Safe against
 * production; this is what `--dry-run` prints and what the operator reads back
 * to the requester before confirming.
 */
export async function planAccountDeletion(
  sqlClient: postgres.Sql,
  userId: string,
  opts: PlanAccountDeletionOptions = {},
): Promise<AccountDeletionPlan> {
  const userRows = (await sqlClient`
    SELECT id, email, display_name, kind FROM public.users WHERE id = ${userId} LIMIT 1
  `) as unknown as UserRow[];
  const user = userRows[0];
  if (!user) throw new Error(`No user with id '${userId}'.`);

  const blockers: string[] = [];
  if (user.kind !== 'human') {
    blockers.push(
      `User '${userId}' is a ${user.kind}, not a human account. ` +
        `This tool erases people; machine identities are revoked through their own lifecycle.`,
    );
  }

  const identities = (await sqlClient`
    SELECT provider, provider_sub FROM public.user_identities WHERE user_id = ${userId}
  `) as unknown as Array<{ provider: string; provider_sub: string }>;

  const memberships = (await sqlClient`
    SELECT tm.tenant_id, tm.role, t.schema_name, t.default_space_id
      FROM public.tenant_memberships tm
      JOIN public.tenants t ON t.tenant_id = tm.tenant_id
      WHERE tm.user_id = ${userId}
  `) as unknown as Array<{
    tenant_id: string;
    role: string;
    schema_name: string;
    default_space_id: string | null;
  }>;

  const payloadPrefixes: string[] = [];
  const tenants: AccountTenantPlan[] = [];

  for (const m of memberships) {
    const schemaName = m.schema_name;
    assertSchemaName(schemaName);

    const successorUserId =
      opts.transferToUserId ?? (await findSuccessor(sqlClient, m.tenant_id, userId));

    // A space is the user's to dispose of when they own it, or when nobody owns
    // it and they are its only member — `space.manage.create` inserts no
    // owner_id, so keying on ownership alone would strand those spaces.
    const candidates = (await sqlClient`
      SELECT s.id, s.name, s.slug, s.owner_id,
             (SELECT COUNT(*)::int
                FROM public.space_memberships sm
                WHERE sm.space_id = s.id
                  AND sm.tenant_id = ${m.tenant_id}
                  AND sm.user_id <> ${userId}) AS other_member_count
        FROM ${sqlClient(schemaName)}.spaces s
        WHERE s.owner_id = ${userId}
           OR (s.owner_id IS NULL AND EXISTS (
                 SELECT 1 FROM public.space_memberships sm2
                  WHERE sm2.space_id = s.id
                    AND sm2.tenant_id = ${m.tenant_id}
                    AND sm2.user_id = ${userId}))
    `) as unknown as Array<{
      id: string;
      name: string;
      slug: string;
      owner_id: string | null;
      other_member_count: number;
    }>;

    const spacesToPurge: AccountSpaceDisposition[] = [];
    const spacesToTransfer: Array<AccountSpaceDisposition & { transferToUserId: string }> = [];

    for (const s of candidates) {
      const disposition: AccountSpaceDisposition = {
        spaceId: s.id,
        name: s.name,
        slug: s.slug,
        otherMemberCount: s.other_member_count,
      };
      const isProtected = s.slug === GENERAL_SLUG || s.id === m.default_space_id;

      if (s.other_member_count > 0 || isProtected) {
        // Protected spaces are never destroyed even when the user is alone in
        // them: other members reach General without an explicit membership row,
        // so an empty membership count does not mean an empty space.
        if (s.owner_id !== userId && !isProtected) continue;
        if (successorUserId) {
          spacesToTransfer.push({ ...disposition, transferToUserId: successorUserId });
        } else {
          blockers.push(
            `Space '${s.name}' (${s.slug}) in tenant ${m.tenant_id} must be handed over ` +
              `${isProtected ? '(it is the tenant fallback space)' : `(${String(s.other_member_count)} other member(s))`}, ` +
              `but the tenant has no other active admin. Re-run with an explicit transfer target.`,
          );
        }
      } else {
        spacesToPurge.push(disposition);
      }
    }

    const purgeCounts: AccountCascadeCounts = {};
    for (const s of spacesToPurge) {
      const counts = await previewCascadeForSpace(sqlClient, schemaName, s.spaceId);
      for (const [label, n] of Object.entries(counts)) {
        purgeCounts[label] = (purgeCounts[label] ?? 0) + n;
      }
    }
    if (spacesToPurge.length > 0) {
      const sessionRows = (await sqlClient`
        SELECT session_id FROM ${sqlClient(schemaName)}.sessions
          WHERE space_id = ANY(${spacesToPurge.map((s) => s.spaceId)}::uuid[])
      `) as unknown as Array<{ session_id: string }>;
      for (const r of sessionRows) {
        payloadPrefixes.push(`tenants/${m.tenant_id}/runs/${r.session_id}/`);
      }
    }

    // Reassignment targets NOT NULL authorship columns in surviving spaces, so
    // it is needed whenever the tenant survives the user at all.
    if (!successorUserId) {
      const others = (await sqlClient`
        SELECT COUNT(*)::int AS c FROM public.tenant_memberships
          WHERE tenant_id = ${m.tenant_id} AND user_id <> ${userId}
      `) as unknown as Array<{ c: number }>;
      if ((others[0]?.c ?? 0) > 0) {
        blockers.push(
          `Tenant ${m.tenant_id} has other members but no active admin to inherit ` +
            `authorship from the erased account. Re-run with an explicit transfer target.`,
        );
      }
    }

    tenants.push({
      tenantId: m.tenant_id,
      schemaName,
      role: m.role,
      spacesToPurge,
      spacesToTransfer,
      successorUserId,
      purgeCounts,
    });
  }

  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    identities: identities.map((i) => ({ provider: i.provider, providerSub: i.provider_sub })),
    tenants,
    payloadPrefixes,
    blockers,
  };
}

/**
 * Pick the tenant admin who inherits the departing user's shared spaces and
 * authorship. Deterministic (owner before admin, then earliest joiner) so a
 * dry-run and the execution that follows it agree.
 */
async function findSuccessor(
  sqlClient: postgres.Sql,
  tenantId: string,
  excludeUserId: string,
): Promise<string | null> {
  const rows = (await sqlClient`
    SELECT user_id
      FROM public.tenant_memberships
      WHERE tenant_id = ${tenantId}
        AND user_id <> ${excludeUserId}
        AND status = 'active'
        AND role IN ('owner', 'admin')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at NULLS LAST, user_id
      LIMIT 1
  `) as unknown as Array<{ user_id: string }>;
  return rows[0]?.user_id ?? null;
}

/**
 * Tenant schema names are interpolated as SQL identifiers, so they never come
 * from user input — but this cascade is reachable from an operator CLI, and a
 * malformed name here would be an injection point rather than an error.
 */
function assertSchemaName(schemaName: string): void {
  if (!isValidSchemaName(schemaName)) {
    throw new Error(`Refusing to operate on non-tenant schema '${schemaName}'.`);
  }
}

/** Tenant-schema sweeps, grouped by policy and derived from the schema. */
function tenantSweeps(): Array<{ table: string; column: string; policy: UserReferencePolicy }> {
  return deriveUserReferenceColumns()
    .map((c) => ({
      table: c.table,
      column: c.column,
      policy: USER_REFERENCE_POLICY[`${c.table}.${c.column}`],
    }))
    .filter(
      (s): s is { table: string; column: string; policy: UserReferencePolicy } =>
        s.policy !== undefined && s.policy.kind !== 'global' && s.policy.kind !== 'disposition',
    );
}

/**
 * Execute `plan` inside a single transaction. All-or-nothing: a failure part
 * way through leaves the account intact rather than half-erased.
 *
 * The caller is responsible for the two effects that cannot participate in a
 * database transaction — GCS payload deletion (`plan.payloadPrefixes`) and IdP
 * identity removal (`plan.identities`) — and must run them AFTER this resolves.
 */
export async function executeAccountDeletion(
  sqlClient: postgres.Sql,
  plan: AccountDeletionPlan,
): Promise<AccountCascadeCounts> {
  if (plan.blockers.length > 0) {
    throw new Error(`Refusing to execute a plan with blockers:\n - ${plan.blockers.join('\n - ')}`);
  }

  const counts: AccountCascadeCounts = {};
  const bump = (label: string, n: number): void => {
    if (n > 0) counts[label] = (counts[label] ?? 0) + n;
  };
  const run = async (label: string, q: postgres.PendingQuery<postgres.Row[]>): Promise<void> => {
    const result = await q;
    bump(label, (result as unknown as { count?: number }).count ?? result.length);
  };

  const sweeps = tenantSweeps();

  await sqlClient.begin(async (txHandle) => {
    // postgres-js types the tx handle as `TransactionSql`, whose `Omit` drops
    // the anonymous call signatures (tagged-template + identifier helper). It
    // is callable at runtime; re-type it as `Sql` for the SQL below.
    const tx = txHandle as unknown as postgres.Sql;
    const { userId } = plan;

    for (const tenant of plan.tenants) {
      const schema = tenant.schemaName;
      assertSchemaName(schema);
      const successor = tenant.successorUserId;

      // The plan was computed outside this transaction and an operator may have
      // sat on the confirmation prompt for minutes. Re-check membership before
      // destroying anything: a collaborator who joined in that window would
      // otherwise lose their work to a stale "solo space" verdict.
      for (const s of tenant.spacesToPurge) {
        const nowRows = (await tx`
          SELECT COUNT(*)::int AS c FROM public.space_memberships
            WHERE space_id = ${s.spaceId} AND tenant_id = ${tenant.tenantId}
              AND user_id <> ${userId}
        `) as unknown as Array<{ c: number }>;
        if ((nowRows[0]?.c ?? 0) > 0) {
          throw new Error(
            `Space '${s.name}' gained a member since the plan was computed — ` +
              `re-run the plan. Nothing was erased.`,
          );
        }
      }

      for (const s of tenant.spacesToTransfer) {
        await run(
          'spaces.transferred',
          tx`
            UPDATE ${tx(schema)}.spaces
              SET owner_id = ${s.transferToUserId}, updated_at = NOW()
              WHERE id = ${s.spaceId}
          `,
        );
        // The new owner must hold an admin membership row — the invariant the
        // space-ownership backfill establishes and the UI relies on.
        await run(
          'public.space_memberships.granted',
          tx`
            INSERT INTO public.space_memberships (tenant_id, space_id, user_id, role)
              VALUES (${tenant.tenantId}, ${s.spaceId}, ${s.transferToUserId}, 'admin')
              ON CONFLICT (tenant_id, space_id, user_id)
              DO UPDATE SET role = 'admin', updated_at = NOW()
          `,
        );
        await run(
          'public.space_memberships',
          tx`
            DELETE FROM public.space_memberships
              WHERE space_id = ${s.spaceId} AND user_id = ${userId}
          `,
        );
      }

      for (const s of tenant.spacesToPurge) {
        const spaceCounts = await cascadeDeleteSpace(tx, schema, s.spaceId);
        for (const [label, n] of Object.entries(spaceCounts)) bump(label, n);
      }

      for (const sweep of sweeps) {
        const { table, column, policy } = sweep;
        if (policy.kind === 'scoped') {
          const q = policy.scopeColumn
            ? tx`
                DELETE FROM ${tx(schema)}.${tx(table)}
                  WHERE ${tx(policy.scopeColumn)} = ${policy.scopeValue ?? 'user'}
                    AND ${tx(column)} = ${userId}
              `
            : tx`DELETE FROM ${tx(schema)}.${tx(table)} WHERE ${tx(column)} = ${userId}`;
          await run(`${table}.${column}`, q);
        } else if (policy.kind === 'provenance') {
          await run(
            `${table}.${column}:cleared`,
            tx`
              UPDATE ${tx(schema)}.${tx(table)}
                SET ${tx(column)} = NULL WHERE ${tx(column)} = ${userId}
            `,
          );
        } else if (policy.kind === 'reassign') {
          if (!successor) continue;
          await run(
            `${table}.${column}:reassigned`,
            tx`
              UPDATE ${tx(schema)}.${tx(table)}
                SET ${tx(column)} = ${successor} WHERE ${tx(column)} = ${userId}
            `,
          );
        } else if (policy.kind === 'jsonb-actor') {
          await run(
            `${table}.${column}`,
            tx`
              DELETE FROM ${tx(schema)}.${tx(table)}
                WHERE ${tx(column)} ->> ${policy.jsonPath} = ${userId}
            `,
          );
        }
      }
    }

    // Global rows the users delete would otherwise block: NOT NULL FKs with no
    // ON DELETE action.
    for (const spec of [
      { table: 'invites', column: 'invited_by' },
      { table: 'space_grants', column: 'granted_by' },
    ]) {
      await run(
        `public.${spec.table}`,
        tx`DELETE FROM public.${tx(spec.table)} WHERE ${tx(spec.column)} = ${userId}`,
      );
    }

    for (const spec of [
      { table: 'tenant_memberships', column: 'invited_by' },
      { table: 'tenant_capability_grants', column: 'granted_by' },
      { table: 'invites', column: 'accepted_by_user_id' },
      { table: 'space_grants', column: 'redeemed_by_user_id' },
      { table: 'invite_requests', column: 'decided_by' },
      { table: 'tenant_integration_allowlist', column: 'added_by' },
      { table: 'egress_approval_requests', column: 'reviewed_by' },
    ]) {
      await run(
        `public.${spec.table}.${spec.column}:cleared`,
        tx`
          UPDATE public.${tx(spec.table)}
            SET ${tx(spec.column)} = NULL WHERE ${tx(spec.column)} = ${userId}
        `,
      );
    }

    // The audit row survives as a record of the action, but everything in it
    // that identifies the person does not — the JSONB actor snapshot and the
    // IP/user-agent are personal data in their own right.
    await run(
      'public.platform_audit_log:cleared',
      tx`
        UPDATE public.platform_audit_log
          SET actor_id = NULL, actor_context = NULL, ip_address = NULL, user_agent = NULL
          WHERE actor_id = ${userId} OR actor_context ->> 'userId' = ${userId}
      `,
    );

    // requested_by is NOT NULL text with no FK, so it neither blocks nor nulls
    // — the row is the user's own request and goes with them.
    await run(
      'public.egress_approval_requests',
      tx`DELETE FROM public.egress_approval_requests WHERE requested_by = ${userId}`,
    );

    // Rows addressed to the erased person rather than authored by them. These
    // carry no FK to users, so nothing above reaches them; leaving them behind
    // would retain the email address the request was made with AND let a
    // still-pending invite re-admit the account on the next login.
    if (plan.email) {
      const email = plan.email.toLowerCase();
      for (const table of ['invites', 'space_grants', 'invite_requests']) {
        await run(
          `public.${table}.by_email`,
          tx`DELETE FROM public.${tx(table)} WHERE lower(email) = ${email}`,
        );
      }
    }

    // api_keys, user_identities, tenant_memberships, space_memberships and
    // tenant_capability_grants all carry ON DELETE CASCADE, so they go with it.
    await run('public.users', tx`DELETE FROM public.users WHERE id = ${userId}`);
  });

  return counts;
}
