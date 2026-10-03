/**
 * Where a hand-off is put so the operator can find it: the Action Center, by
 * way of the record this executor keeps in Redis while a run waits.
 *
 * The record is written when the wait begins and removed when it ends,
 * whatever ended it; a second run waiting on the same profile and site joins
 * the record already there, so the operator sees one item. The item's **Done**
 * reaches the waiting step on its own channel, which this executor listens on
 * from before the record exists, so no Done can arrive unheard.
 */
import type { Redis } from 'ioredis';
import {
  browserHandoffKey,
  joinBrowserHandoff,
  leaveBrowserHandoff,
  publishActionCenterWake,
} from '@aflow/redis';
import { type BrowserHandoffReason, StreamKeys } from '@aflow/schemas';
import { getDomain } from 'tldts';

export interface HandoffEntry {
  readonly tenantId: string;
  readonly spaceId?: string;
  readonly runId: string;
  readonly stepExecutionId: string;
  readonly sessionId?: string;
  readonly profileId: string;
  /** The registrable host of the page handed over (`registrableSite`). */
  readonly site: string;
  readonly reason: BrowserHandoffReason;
  readonly message: string;
  /**
   * How long the run may wait. A length, not an instant: the driver keeps its
   * own clock, and the record's expiry is Redis's wall clock.
   */
  readonly waitMs: number;
}

export interface HandoffPosting {
  /** Settles when the operator presses Done on the item. */
  readonly done: Promise<void>;
  /** Takes this run off the item, and the item down when it was the last. */
  close(): Promise<void>;
}

export interface HandoffBoard {
  /** Never throws: a hand-off that cannot be posted still waits on the machine. */
  post(entry: HandoffEntry): Promise<HandoffPosting>;
}

const NEVER: Promise<void> = new Promise<void>(() => undefined);

/** A posting nobody can see: the wait ends on the machine alone. */
export const UNPOSTED: HandoffPosting = { done: NEVER, close: () => Promise.resolve() };

/** For a driver with no Action Center to post to — the command line, tests. */
export const NO_BOARD: HandoffBoard = { post: () => Promise.resolve(UNPOSTED) };

/**
 * The site a page is on, as the hand-off is shared by: its registrable host,
 * so a sign-in at `accounts.example.com` and a run waiting at `mail.example.com`
 * are one item. An address with no registrable host — an IP, `localhost` —
 * stands as its host.
 */
export function registrableSite(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return address;
  }
  const host = url.hostname.toLowerCase();
  if (host === '') return url.origin !== 'null' ? url.origin : address;
  return getDomain(host) ?? host;
}

interface BoardLog {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RedisHandoffBoardDeps {
  readonly redis: Redis;
  /** A connection in subscriber mode; the board subscribes per waiting step. */
  readonly subscriber: Redis;
  /** The name this machine publishes its inventory under. */
  readonly hostname: string;
  readonly log: BoardLog;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRedisHandoffBoard(deps: RedisHandoffBoardDeps): HandoffBoard {
  const waiting = new Map<string, () => void>();
  deps.subscriber.on('message', (channel: string) => {
    waiting.get(channel)?.();
  });

  return {
    async post(entry) {
      const { spaceId } = entry;
      // An item belongs to a space's Action Center; a run with no space has
      // none to show it in, and waits on the machine.
      if (spaceId === undefined) return UNPOSTED;

      const channel = StreamKeys.browserHandoffDoneChannel(entry.stepExecutionId);
      let markDone: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      waiting.set(channel, markDone);
      const key = browserHandoffKey(deps.hostname, entry.profileId, entry.site);
      const where = {
        profileId: entry.profileId,
        site: entry.site,
        stepExecutionId: entry.stepExecutionId,
      };
      const wake = (): void => {
        publishActionCenterWake(deps.redis, {
          source: 'browser_handoff',
          tenantId: entry.tenantId,
          spaceId,
        });
      };

      try {
        await deps.subscriber.subscribe(channel);
        const startedAt = Date.now();
        await joinBrowserHandoff(deps.redis, {
          hostname: deps.hostname,
          profileId: entry.profileId,
          site: entry.site,
          reason: entry.reason,
          message: entry.message,
          startedAt,
          waiter: {
            tenantId: entry.tenantId,
            spaceId,
            runId: entry.runId,
            stepExecutionId: entry.stepExecutionId,
            ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
            deadlineAt: startedAt + entry.waitMs,
          },
        });
        wake();
      } catch (error) {
        deps.log.warn(
          'The hand-off could not be put in the Action Center; it waits on the machine only',
          { ...where, error: errorText(error) },
        );
      }

      let closed = false;
      return {
        done,
        close: async () => {
          if (closed) return;
          closed = true;
          waiting.delete(channel);
          await leaveBrowserHandoff(deps.redis, {
            key,
            tenantId: entry.tenantId,
            spaceId,
            stepExecutionId: entry.stepExecutionId,
          }).catch((error: unknown) => {
            deps.log.warn('The hand-off could not be taken out of the Action Center', {
              ...where,
              error: errorText(error),
            });
          });
          await deps.subscriber.unsubscribe(channel).catch(() => undefined);
          wake();
        },
      };
    },
  };
}
