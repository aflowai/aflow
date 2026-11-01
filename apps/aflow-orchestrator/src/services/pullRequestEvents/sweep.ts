/**
 * The due check ahead of a shepherd sweep (Plan 339 D4, D5).
 *
 * The shepherd's schedule is a fallback sweep for the pull requests no
 * conversation holds. A firing reads the space's open loop pull requests and
 * starts the shepherd only where one of them is unattended. A pull request is
 * attended where its owner holds the wait the platform keeps for it, or where
 * any waiter's window closes before the next sweep: that waiter is woken
 * first, and reads the pull request itself.
 *
 * Its cost grows with the space's open loop pull requests: one range read,
 * then two key reads for each. With none open it reads one empty range.
 */
import type { Redis } from 'ioredis';
import type postgres from 'postgres';
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

/** Why a pull request does or does not need the sweep. */
export function sweepAttention(
  waits: readonly WaitRegistration[],
  nowMs: number,
  intervalMs: number = SHEPHERD_SWEEP_INTERVAL_MS,
): SweepAttention {
  if (waits.some((wait) => wait.owner !== undefined)) return 'owner';
  if (waits.some((wait) => wait.closesAt <= nowMs + intervalMs)) return 'short_window';
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
    if (sweepAttention(waits, nowMs, intervalMs) === 'unattended') unattended++;
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

/**
 * Whether a firing of this schedule should start its run. Only a firing that
 * starts the Local PR Shepherd agent is checked, and it starts nothing where
 * no open loop pull request is unattended. Disabled, the check lets every
 * firing start, as firings did before it.
 */
export async function shepherdSweepWanted(
  sql: Pick<postgres.Sql, 'unsafe'>,
  redis: Redis,
  schedule: SweepSchedule,
  nowMs: number = Date.now(),
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
