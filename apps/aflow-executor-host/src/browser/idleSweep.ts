/**
 * Closing what a run left open (D6).
 *
 * The executor is not told when a run ends, so a page nobody closed would
 * otherwise live as long as the executor, with the profile's sign-ins loaded
 * behind it. Its work is the set of profiles whose browser is running in this
 * executor: with none running a cycle does nothing at all.
 */
import {
  createBackgroundTaskRunner,
  type BackgroundTaskLogger,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane } from '@aflow/schemas';

import type { BrowserDriver } from './driver.js';

export const BROWSER_IDLE_TASK_ID = 'host.browser_idle';

export function createBrowserIdleSweep(
  driver: BrowserDriver,
  logger: BackgroundTaskLogger,
): BackgroundTaskRunner {
  const runtime = backgroundTaskControlPlane().resolve(BROWSER_IDLE_TASK_ID);
  return createBackgroundTaskRunner(
    {
      taskId: BROWSER_IDLE_TASK_ID,
      scope: runtime.scope,
      intervalMs: runtime.intervalMs ?? 60_000,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      logger,
    },
    async (ctx) => {
      const candidates = driver.runningProfileCount();
      if (candidates === 0 || ctx.mode === 'observe') return { candidates };
      const swept = await driver.sweepIdle();
      return { candidates, processed: swept.closedPages + swept.stoppedProfiles };
    },
  );
}
