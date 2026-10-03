/**
 * Serving the command line's browser requests when nothing tells this executor
 * one arrived.
 *
 * The directory watch is what normally serves them. A request written before
 * the executor started was never watched for, and on a filesystem where the
 * watch cannot be set up — or after it failed — none is: the command line then
 * sees its request go unclaimed and concludes no executor runs. So pending
 * requests are served once at startup, and polled for while the watch is down.
 */
import {
  createBackgroundTaskRunner,
  type BackgroundTaskLogger,
  type BackgroundTaskRunner,
} from '@aflow/lib';
import { backgroundTaskControlPlane } from '@aflow/schemas';

import { type BrowserRequestServer, EXECUTOR_CLAIM_TIMEOUT_MS } from './windowRequests.js';

export const BROWSER_REQUESTS_TASK_ID = 'host.browser_requests';

/** Inside the command line's claim timeout, so a polled request is still claimed in time. */
export const BROWSER_REQUEST_POLL_MS = EXECUTOR_CLAIM_TIMEOUT_MS / 2;

export function followBrowserRequests(
  server: BrowserRequestServer,
  watching: () => boolean,
  logger: BackgroundTaskLogger,
): BackgroundTaskRunner {
  void server.check();
  const runtime = backgroundTaskControlPlane().resolve(BROWSER_REQUESTS_TASK_ID);
  return createBackgroundTaskRunner(
    {
      taskId: BROWSER_REQUESTS_TASK_ID,
      scope: runtime.scope,
      intervalMs: runtime.intervalMs ?? BROWSER_REQUEST_POLL_MS,
      maxBatch: runtime.maxBatch,
      maxCycleMs: runtime.maxCycleMs,
      mode: runtime.mode,
      logger,
    },
    async (ctx) => {
      if (watching()) return { candidates: 0 };
      if (ctx.mode === 'observe') return { candidates: 1 };
      await server.check();
      return { candidates: 1, processed: 1 };
    },
  );
}
