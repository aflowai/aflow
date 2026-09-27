import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  ActorContextSchema,
  ExecutionAuthoritySnapshotSchema,
  type ActorContext,
  type AuthorityCheck,
  type AuthorityLossReason,
  type ExecutionAuthoritySnapshot,
} from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';

/**
 * Whose authority a run acts under is decided when the run is established and
 * does not move afterwards. Anyone may steer a shared run; steering carries
 * the actor's name, never their access.
 */
export function readEstablishedAuthority(
  runState: SessionHotState,
): ExecutionAuthoritySnapshot | undefined {
  if (!runState.executionAuthorityJson) return undefined;
  try {
    const parsed = ExecutionAuthoritySnapshotSchema.safeParse(
      JSON.parse(runState.executionAuthorityJson),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function buildAuthorityFromActor(
  actor: ActorContext,
  params: { spaceId: string; establishedReason: ExecutionAuthoritySnapshot['establishedReason'] },
): ExecutionAuthoritySnapshot {
  return {
    version: 1,
    principalUserId: actor.userId,
    principalKind: actor.kind,
    spaceId: params.spaceId,
    spaceRole: actor.spaceRole ?? 'viewer',
    tenantRole: actor.tenantRole,
    establishedAt: new Date().toISOString(),
    establishedReason: params.establishedReason,
    // Personal credentials are extended to a run only by their owner's
    // explicit act, which is a separate grant — never implied by starting one.
    personalCredentialsGranted: false,
  };
}

/**
 * Whether the authority a run was established under still holds.
 *
 * Long-lived work outlives the access that started it — people leave spaces
 * and roles get narrowed while a run sits paused for a week. Continuing under
 * a principal who no longer has access is the failure this prevents.
 */
export async function revalidateAuthority(
  db: PostgresJsDatabase,
  redis: Redis,
  tenantId: string,
  authority: ExecutionAuthoritySnapshot,
): Promise<AuthorityCheck> {
  return revalidatePrincipalSpaceAccess(db, redis, {
    tenantId,
    userId: authority.principalUserId,
    spaceId: authority.spaceId,
    establishedSpaceRole: authority.spaceRole,
  });
}

/**
 * The core of `revalidateAuthority`, callable from places that hold the
 * principal fields without a full authority snapshot — grant renewal reads
 * them off the expiring grant itself.
 */
export async function revalidatePrincipalSpaceAccess(
  db: PostgresJsDatabase,
  redis: Redis,
  args: { tenantId: string; userId: string; spaceId: string; establishedSpaceRole: string },
): Promise<AuthorityCheck> {
  const { resolveSpaceRole } = await import('@aflow/authz');
  const currentRole = await resolveSpaceRole(db, redis, {
    userId: args.userId,
    tenantId: args.tenantId,
    spaceId: args.spaceId,
  });

  if (!currentRole) {
    return failure(
      'principal_left_space',
      `The user this run acts for is no longer a member of the space.`,
    );
  }

  if (isNarrower(currentRole, args.establishedSpaceRole)) {
    return failure(
      'principal_role_reduced',
      `The user this run acts for now holds '${currentRole}', narrower than the '${args.establishedSpaceRole}' it was established with.`,
    );
  }

  return { ok: true };
}

function failure(reason: AuthorityLossReason, detail: string): AuthorityCheck {
  return { ok: false, reason, detail };
}

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };

function isNarrower(current: string, established: string): boolean {
  const currentRank = ROLE_RANK[current];
  const establishedRank = ROLE_RANK[established];
  if (currentRank === undefined || establishedRank === undefined) return false;
  return currentRank < establishedRank;
}

/**
 * The person the agent is talking to on this turn.
 *
 * A shared room has several participants, so the session's creator answers
 * "who opened this", not "who is speaking now". Falling back to the creator
 * keeps a solo session's context exactly as it was.
 */
export function readCurrentActorUserId(
  runState: SessionHotState | undefined | null,
): string | undefined {
  if (!runState?.actorContextJson) return undefined;
  try {
    const parsed = ActorContextSchema.safeParse(JSON.parse(runState.actorContextJson));
    return parsed.success ? parsed.data.userId : undefined;
  } catch {
    return undefined;
  }
}
