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
import { hostname } from 'node:os';

import type { Redis } from 'ioredis';
import {
  browserHandoffKey,
  clearMachineBrowserHandoffs,
  joinBrowserHandoff,
  leaveBrowserHandoff,
  publishActionCenterWake,
} from '@aflow/redis';
import { type BrowserHandoffReason, BrowserHandoffSiteSchema, StreamKeys } from '@aflow/schemas';
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
 * stands as its host. A `blob:` page is on the site that made it.
 *
 * Undefined for a page that is not on a site — `about:`, `data:`, `file:`,
 * `javascript:` — and for a host no DNS name could be: there is nothing there
 * for the operator to sign in to.
 */
export function registrableSite(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
    if (url.protocol === 'blob:') url = new URL(url.pathname);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname;
  if (host === '') return undefined;
  const site = getDomain(host) ?? host;
  return BrowserHandoffSiteSchema.safeParse(site).success ? site : undefined;
}

interface BoardLog {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RedisHandoffBoardDeps {
  readonly redis: Redis;
  /** A connection in subscriber mode; the board subscribes per waiting step. */
  readonly subscriber: Redis;
  /** Whose records these are; `startHandoffBoard` says why it is the OS's name for the machine. */
  readonly machine: string;
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
      const key = browserHandoffKey(deps.machine, entry.profileId, entry.site);
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
          hostname: deps.machine,
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
            hostname: deps.machine,
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

type StartLog = BoardLog & { info(message: string, meta?: Record<string, unknown>): void };

export interface HandoffsLeftBehindDeps {
  readonly redis: Redis;
  readonly machine: string;
  readonly log: StartLog;
}

/**
 * Takes down the hand-offs a previous run of this executor left in the Action
 * Center. Every wait they stood for died with it, and a later run joining one
 * would otherwise inherit its reason, its start and its dead waiters. Never
 * throws: a record it misses still expires.
 */
export async function clearHandoffsLeftBehind(deps: HandoffsLeftBehindDeps): Promise<void> {
  let spaces: Awaited<ReturnType<typeof clearMachineBrowserHandoffs>>;
  try {
    spaces = await clearMachineBrowserHandoffs(deps.redis, deps.machine);
  } catch (error) {
    deps.log.warn(
      'The hand-offs a previous run of this executor left could not be taken out of the Action ' +
        'Center; they go when they expire',
      { error: errorText(error) },
    );
    return;
  }
  if (spaces.length === 0) return;
  for (const space of spaces) {
    publishActionCenterWake(deps.redis, { source: 'browser_handoff', ...space });
  }
  deps.log.info(
    'Took down the hand-offs a previous run of this executor left in the Action Center',
    {
      spaces: spaces.length,
    },
  );
}

export interface HandoffBoardStartDeps {
  readonly redis: Redis;
  /** A connection in subscriber mode; the board subscribes per waiting step. */
  readonly subscriber: Redis;
  readonly log: StartLog;
}

/**
 * The board this run of the executor posts to, once what a previous run left on
 * it is taken down.
 *
 * Keyed by the OS's name for this machine, which a restart keeps. The
 * executor's own name falls back to one carrying its pid, so a restarted
 * executor looked for its records under a name nothing had written. Pairing
 * gives a machine no name of its own: `host.env` holds only the Redis
 * credential, under a username every paired machine shares.
 */
export async function startHandoffBoard(deps: HandoffBoardStartDeps): Promise<HandoffBoard> {
  const machine = hostname();
  await clearHandoffsLeftBehind({ redis: deps.redis, machine, log: deps.log });
  return createRedisHandoffBoard({ ...deps, machine });
}
