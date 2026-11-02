/**
 * The pull request event source (Plan 339 D2): polls only the pull requests
 * the loop has open, and emits `pull_request.changed` when one's checks go
 * green or a check run fails, it merges, it conflicts, a review asks for
 * changes, or it closes.
 *
 * Candidate-driven under Plan 180. The publication that opens a pull request
 * arms it (`arm.ts`); its merge or its close clears it here. A cycle with no
 * loop pull request open reads one empty range and makes no forge request.
 * Every read is conditional on the ETag of the answer before it.
 *
 * The source speaks the forge vocabulary (Plan 340 D3): the provider named
 * from a pull request's host polls it and parses what its forge answers.
 */
import type { Redis } from 'ioredis';
import {
  claimDuePullRequestWatches,
  clearPullRequestWatch,
  reschedulePullRequestWatch,
  savePullRequestWatch,
  type PullRequestWatch,
} from '@aflow/redis';
import { emitPullRequestChanged } from '@aflow/cybernetic-runtime';
import {
  backgroundWorkVerboseLogsEnabled,
  createBackgroundTaskRunner,
  type BackgroundTaskCycleResult,
  type BackgroundTaskLogger,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane, type PullRequestChange } from '@aflow/schemas';
import {
  forgeEventProviderFor,
  forgeEventReaderFor,
  type ForgeConditionalGets,
} from '../forge/index.js';
import type { ForgeEventReader, PullRequestSnapshot } from '../forge/vocabulary.js';

export const PULL_REQUEST_EVENTS_TASK_ID = 'orchestrator.pull_request_events';

/** The proposed cadence; Plan 339 P2 measures it before it is settled. */
export const PULL_REQUEST_POLL_CADENCE_MS = 60_000;

/**
 * What changed between two polls, by the four changes of D1, a failed head and
 * a close. The first poll compares with nothing, so what already holds is
 * reported once. Green and failed are each reported once per head: a head read
 * the same on the poll before reports nothing new. A re-run that leaves the
 * head pending and then fails again reports it once more, because a failure
 * no one hears leaves the owner's wait quiet and the sweep counts it attended.
 * So does a failure after a stopped run: the pass waited on the stop. Whether
 * a head conflicts with its base is the forge's word, read by its provider.
 */
export function pullRequestChanges(
  before: PullRequestSnapshot | undefined,
  after: PullRequestSnapshot,
  forge: ForgeEventReader = forgeEventReaderFor(),
): PullRequestChange[] {
  if (after.pull.merged) return before?.pull.merged === true ? [] : ['merged'];
  if (after.pull.state === 'closed') return before?.pull.state === 'closed' ? [] : ['closed'];
  const changes: PullRequestChange[] = [];
  const sameHead = before?.pull.headSha === after.pull.headSha;
  if (after.checks === 'green' && !(sameHead && before.checks === 'green')) {
    changes.push('checks_green');
  }
  if (after.checks === 'red' && !(sameHead && before.checks === 'red')) {
    changes.push('checks_failed');
  }
  if (forge.conflicting(after.pull) && !(before !== undefined && forge.conflicting(before.pull))) {
    changes.push('conflicting');
  }
  if (after.changesRequested === true && before?.changesRequested !== true) {
    changes.push('changes_requested');
  }
  return changes;
}

// ============================================================================
// The cycle
// ============================================================================

export interface PullRequestEventsDeps {
  redis: Redis;
  /** Each provider's conditional GET: a change request is read through its own provider's. */
  gets: ForgeConditionalGets;
  logger: BackgroundTaskLogger;
  now?: () => number;
  cadenceMs?: number;
  emit?: typeof emitPullRequestChanged;
}

export async function runPullRequestEventsCycle(
  deps: PullRequestEventsDeps,
  ctx: {
    maxBatch: number;
    budgetExhausted(): boolean;
    mode: 'enabled' | 'observe';
    signal?: AbortSignal;
  },
): Promise<BackgroundTaskCycleResult> {
  const now = deps.now ?? Date.now;
  const cadenceMs = deps.cadenceMs ?? PULL_REQUEST_POLL_CADENCE_MS;
  const emit = deps.emit ?? emitPullRequestChanged;
  // A claim lasts one cadence at most: every outcome of a poll gives it up and
  // sets the next poll one cadence on.
  const watches = await claimDuePullRequestWatches(deps.redis, now(), ctx.maxBatch, cadenceMs);
  if (watches.length === 0) return { candidates: 0 };
  if (ctx.mode === 'observe') return { candidates: watches.length };

  let processed = 0;
  let failed = 0;
  for (const watch of watches) {
    if (ctx.budgetExhausted()) break;
    try {
      const { reader: forge, get } = forgeEventProviderFor(deps.gets, watch.url);
      const polled = await forge.poll(get, watch, ctx.signal);
      const found = pullRequestChanges(forge.snapshotOf(watch), polled.snapshot, forge);
      const changes = [...new Set([...(watch.unsent ?? []), ...found])];
      const unsent: PullRequestChange[] = [];
      for (const change of changes) {
        const ok = await emit(deps.redis, {
          tenantId: watch.tenantId,
          spaceId: watch.spaceId,
          subject: watch.subject,
          change,
          url: watch.url,
          headSha: polled.snapshot.pull.headSha,
        });
        if (!ok) unsent.push(change);
      }
      const read: PullRequestWatch = { ...polled.watch };
      delete read.unsent;
      // A merge or a close that landed ends the watch even where an older
      // change did not land: nothing changes on the pull request after it, so
      // a watch kept for the older change would be polled for as long as
      // the forge answers. The older change is not sent again.
      const terminalLanded = (['merged', 'closed'] as const).some(
        (change) => changes.includes(change) && !unsent.includes(change),
      );
      if (terminalLanded) {
        await clearPullRequestWatch(deps.redis, watch);
        if (unsent.length > 0) {
          failed++;
          deps.logger.warn('[pull-request-events] cleared with changes that did not land', {
            subject: watch.subject,
            unsent,
          });
          continue;
        }
      } else if (unsent.length > 0) {
        // The poll's reads are saved with the changes that did not land, so the
        // next poll sends those again and not the ones that landed. The forge
        // answered, so this poll did not fail, and the save renews the watch.
        failed++;
        await savePullRequestWatch(deps.redis, { ...read, unsent }, now() + cadenceMs);
        continue;
      } else {
        await savePullRequestWatch(deps.redis, read, now() + cadenceMs);
      }
      processed++;
      if (changes.length > 0 || backgroundWorkVerboseLogsEnabled()) {
        deps.logger.info('[pull-request-events] polled', {
          subject: watch.subject,
          changes,
        });
      }
    } catch (err) {
      failed++;
      deps.logger.warn('[pull-request-events] poll failed; due again next cadence', {
        subject: watch.subject,
        error: err instanceof Error ? err.message : String(err),
      });
      // Not saved: a save would renew the watch's lifetime, and one whose polls
      // keep failing must lapse. Where this write fails too, the claim lapses
      // after one cadence and the pull request, still due, is polled then.
      await reschedulePullRequestWatch(deps.redis, watch, now() + cadenceMs).catch(() => undefined);
    }
  }
  return { candidates: watches.length, processed, failed };
}

export function createPullRequestEventsTask(deps: PullRequestEventsDeps): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(PULL_REQUEST_EVENTS_TASK_ID);
  const cadenceMs = runtime.intervalMs ?? PULL_REQUEST_POLL_CADENCE_MS;
  return createBackgroundTaskRunner(
    {
      taskId: PULL_REQUEST_EVENTS_TASK_ID,
      scope: runtime.scope,
      intervalMs: cadenceMs,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      logger: deps.logger,
    },
    (ctx) => runPullRequestEventsCycle({ ...deps, cadenceMs }, ctx),
  );
}
