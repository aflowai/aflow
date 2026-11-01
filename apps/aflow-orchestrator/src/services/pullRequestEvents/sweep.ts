/**
 * The due check ahead of a shepherd sweep (Plan 339 D4, D5).
 *
 * The shepherd's schedule is a fallback sweep for the pull requests no
 * conversation holds. A firing reads the space's open loop pull requests and
 * starts the shepherd only where one of them is unattended. A pull request is
 * attended where an owner that can act holds the wait the platform keeps for
 * it, or where another waiter's window closes before the next sweep: that
 * waiter is woken first, and reads the pull request itself. An owner that has
 * ended or failed attends nothing, whatever wait it still holds.
 *
 * Its cost grows with the space's open loop pull requests: one range read,
 * then two key reads for each, and one session read for each owner wait. With
 * none open it reads one empty range.
 */
import type { Redis } from 'ioredis';
import type postgres from 'postgres';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { isActingConversation } from '@aflow/cybernetic-runtime';
import { listSpacePullRequestSubjects, readPullRequestWatch, readSubjectWaits } from '@aflow/redis';
import {
  backgroundTaskControlPlane,
  SHEPHERD_SLUG,
  SHEPHERD_SWEEP_INTERVAL_MS,
  type WaitRegistration,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../lib/orchestratorLogger.js';
import { PULL_REQUEST_CHANGED } from './owner.js';

export const SHEPHERD_SWEEP_DUE_CHECK_TASK_ID = 'orchestrator.shepherd_sweep_due_check';

/** How many of a space's open loop pull requests one due check reads. */
export const SHEPHERD_SWEEP_DUE_READ_LIMIT = 100;

export type SweepAttention = 'owner' | 'short_window' | 'unattended';

/** Whether the conversation an owner wait names can act on its pull request now. */
export type OwnerActs = (sessionId: string) => Promise<boolean>;

/**
 * Why a pull request does or does not need the sweep. An owner wait counts
 * only where its owner can act: the platform renews it on every window close,
 * so a failed or ended owner would otherwise hold its pull request for good.
 */
export async function sweepAttention(
  waits: readonly WaitRegistration[],
  ownerActs: OwnerActs,
  nowMs: number,
  intervalMs: number = SHEPHERD_SWEEP_INTERVAL_MS,
): Promise<SweepAttention> {
  const owners = waits.filter((wait) => wait.owner !== undefined);
  for (const wait of owners) {
    if (await ownerActs(wait.sessionId)) return 'owner';
  }
  const others = waits.filter((wait) => wait.owner === undefined);
  if (others.some((wait) => wait.closesAt <= nowMs + intervalMs)) return 'short_window';
  return 'unattended';
}

export interface SweepDue {
  due: boolean;
  /** The space's open loop pull requests read. */
  open: number;
  /** Those no owner and no short window holds. */
  unattended: number;
}

/** Whether a shepherd sweep in this space has a pull request to tend. */
export async function shepherdSweepDue(
  redis: Redis,
  ownerActs: OwnerActs,
  space: { tenantId: string; spaceId: string },
  nowMs: number = Date.now(),
  intervalMs: number = SHEPHERD_SWEEP_INTERVAL_MS,
): Promise<SweepDue> {
  const subjects = await listSpacePullRequestSubjects(redis, space, SHEPHERD_SWEEP_DUE_READ_LIMIT);
  let open = 0;
  let unattended = 0;
  for (const subject of subjects) {
    const watch = await readPullRequestWatch(redis, { ...space, subject });
    if (watch === null) continue;
    open++;
    const waits = await readSubjectWaits(redis, { ...space, kind: PULL_REQUEST_CHANGED, subject });
    if ((await sweepAttention(waits, ownerActs, nowMs, intervalMs)) === 'unattended') {
      unattended++;
    }
  }
  return { due: unattended > 0, open, unattended };
}

/** The columns of a due schedule the sweep's gate reads. */
export interface SweepSchedule {
  id: string;
  tenant_schema: string;
  tenant_id: string;
  space_id: string;
  action: string;
  target_kind: string | null;
  target_agent_id: string | null;
}

export interface SweepDeps {
  sql: Pick<postgres.Sql, 'unsafe'>;
  db: PostgresJsDatabase;
  redis: Redis;
}

/**
 * Whether a firing of this schedule should start its run. Only a firing that
 * starts the Local PR Shepherd agent is checked, and it starts nothing where
 * no open loop pull request is unattended. Disabled or failing, the check
 * lets every firing start, as firings did before it: a check that threw would
 * otherwise leave the schedule due and in error, firing never.
 */
export async function shepherdSweepWanted(
  deps: SweepDeps,
  schedule: SweepSchedule,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    return await sweepWanted(deps, schedule, nowMs);
  } catch (err) {
    getOrchestratorLogger().warn(
      `[shepherd-sweep] due check of ${schedule.id} failed; the firing starts: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

async function sweepWanted(
  { sql, db, redis }: SweepDeps,
  schedule: SweepSchedule,
  nowMs: number,
): Promise<boolean> {
  if (
    schedule.action !== 'start_run' ||
    schedule.target_kind !== 'custom-agent' ||
    schedule.target_agent_id === null
  ) {
    return true;
  }
  const runtime = backgroundTaskControlPlane().resolve(SHEPHERD_SWEEP_DUE_CHECK_TASK_ID);
  if (runtime.mode !== 'enabled') return true;
  const [agent] = await sql.unsafe<Array<{ slug: string }>>(
    `SELECT slug FROM "${schedule.tenant_schema}".agents WHERE id = $1::uuid LIMIT 1`,
    [schedule.target_agent_id],
  );
  if (agent?.slug !== SHEPHERD_SLUG) return true;
  const sweep = await shepherdSweepDue(
    redis,
    (sessionId) => isActingConversation(db, schedule.tenant_id, sessionId),
    { tenantId: schedule.tenant_id, spaceId: schedule.space_id },
    nowMs,
  );
  if (!sweep.due) {
    getOrchestratorLogger().debug(
      `[shepherd-sweep] firing of ${schedule.id} skipped: ${String(sweep.open)} loop pull request(s) open, none unattended`,
    );
  }
  return sweep.due;
}
