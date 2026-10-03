/**
 * The machine's command line asking the running executor to show a profile's
 * window, or to say which profiles it is running.
 *
 * Chrome allows one process per profile directory and the executor owns it,
 * so the command line cannot start that profile's Chrome while an executor
 * runs. It asks through files beside the policy, which the executor's watch on
 * that directory already sees: a request file written whole, claimed by the
 * executor renaming it, answered by a result file. Whoever removes the request
 * file first owns it — the executor by claiming it, the command line by
 * withdrawing it — so a request is never both served and abandoned. One nobody
 * claims within a few seconds means no executor is listening, and the command
 * line acts alone.
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserProfileIdSchema } from '@aflow/schemas';
import { z } from 'zod';

import { writeFileAtomically } from '../policyFile.js';
import { errorText } from './errors.js';

const REQUEST_PREFIX = 'browser-request-';
const RESULT_PREFIX = 'browser-result-';
const REQUEST_FILE = /^browser-request-([A-Za-z0-9_-]{1,64})\.json$/;

/** How long a request waits to be claimed before the command line takes it back. */
export const EXECUTOR_CLAIM_TIMEOUT_MS = 3_000;
/** How often the command line looks for the claim and the result. */
export const REQUEST_POLL_MS = 200;
/**
 * A request older than this was most likely left by a command line that is
 * gone, and a window shown for it would surprise the operator, so it is refused
 * — answered, in case the command line is still waiting after all.
 */
export const REQUEST_STALE_MS = 2 * EXECUTOR_CLAIM_TIMEOUT_MS;

const requestShape = { id: z.string(), requestedAt: z.number() };

export const BrowserWindowRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...requestShape, kind: z.literal('sign_in'), profileId: BrowserProfileIdSchema }),
  z.object({ ...requestShape, kind: z.literal('list') }),
]);
export type BrowserWindowRequest = z.infer<typeof BrowserWindowRequestSchema>;

/** What the command line asks, before the exchange gives it an id and a time. */
export type BrowserWindowQuestion =
  { readonly kind: 'sign_in'; readonly profileId: string } | { readonly kind: 'list' };

export const BrowserWindowResultSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('sign_in'),
    outcome: z.enum(['window_closed', 'timed_out']),
    restarted: z.boolean(),
    sites: z.array(z.string()),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('list'),
    profiles: z.array(
      z.object({ id: z.string(), running: z.boolean(), sites: z.array(z.string()).optional() }),
    ),
  }),
  z.object({ id: z.string(), kind: z.literal('refused'), message: z.string() }),
]);
export type BrowserWindowResult = z.infer<typeof BrowserWindowResultSchema>;

/** What a result carries before the exchange stamps it with the request's id. */
export type BrowserWindowAnswer = BrowserWindowResult extends infer R
  ? R extends unknown
    ? Omit<R, 'id'>
    : never
  : never;

function requestPath(hostDir: string, id: string): string {
  return join(hostDir, `${REQUEST_PREFIX}${id}.json`);
}

function claimedPath(hostDir: string, id: string): string {
  return join(hostDir, `${REQUEST_PREFIX}${id}.claimed`);
}

function resultPath(hostDir: string, id: string): string {
  return join(hostDir, `${RESULT_PREFIX}${id}.json`);
}

export function isBrowserRequestFile(filename: string): boolean {
  return REQUEST_FILE.test(filename);
}

// ---------------------------------------------------------------------------
// The executor's side
// ---------------------------------------------------------------------------

export interface BrowserRequestServer {
  /** Claims and serves every request waiting in the directory. Safe to call at any time. */
  check(): Promise<void>;
}

export function serveBrowserRequests(
  hostDir: string,
  answer: (request: BrowserWindowRequest) => Promise<BrowserWindowAnswer>,
  warn: (message: string, meta: Record<string, unknown>) => void,
  now: () => number = Date.now,
): BrowserRequestServer {
  const serve = async (id: string): Promise<void> => {
    const claimed = claimedPath(hostDir, id);
    try {
      await rename(requestPath(hostDir, id), claimed);
    } catch {
      // Claimed by an earlier check, or withdrawn by the command line: not ours.
      return;
    }
    let result: BrowserWindowResult;
    try {
      const request = BrowserWindowRequestSchema.parse(JSON.parse(await readFile(claimed, 'utf8')));
      const ageMs = now() - request.requestedAt;
      if (ageMs > REQUEST_STALE_MS) {
        warn('Refused a browser request from the command line that was too old to act on', {
          id,
          kind: request.kind,
          ageMs,
        });
        result = {
          id,
          kind: 'refused',
          message:
            `The browser executor found this request ${String(Math.round(ageMs / 1000))} ` +
            'seconds after it was made, too old to act on, and did nothing. Run the command again.',
        };
      } else {
        result = { ...(await answer({ ...request, id })), id } as BrowserWindowResult;
      }
    } catch (error) {
      result = { id, kind: 'refused', message: errorText(error) };
    }
    // Cleared before the answer exists, so an answered request leaves nothing behind.
    await unlink(claimed).catch(() => undefined);
    try {
      await writeFileAtomically(resultPath(hostDir, id), JSON.stringify(result));
    } catch (error) {
      warn('Could not answer a browser request from the command line', {
        id,
        error: errorText(error),
      });
    }
  };
  return {
    check: async () => {
      const names = await readdir(hostDir).catch(() => [] as string[]);
      // Each served on its own: a sign-in sitting lasts as long as the operator
      // takes, and a list asked meanwhile is not held behind it.
      for (const name of names) {
        const id = REQUEST_FILE.exec(name)?.[1];
        if (id !== undefined) void serve(id);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The command line's side
// ---------------------------------------------------------------------------

export interface RequestClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export type Asked =
  | { readonly answeredBy: 'executor'; readonly result: BrowserWindowResult }
  | { readonly answeredBy: 'nobody' };

async function exists(path: string): Promise<boolean> {
  return await readFile(path)
    .then(() => true)
    .catch(() => false);
}

/**
 * Asks the running executor. `nobody` when no executor claimed the request in
 * time — it was withdrawn, and the caller may act alone. Once claimed, waits
 * for the result for as long as `resultTimeoutMs`; `onClaimed` is told when the
 * executor took it.
 */
export async function askExecutor(
  hostDir: string,
  request: BrowserWindowQuestion,
  options: {
    readonly clock: RequestClock;
    readonly resultTimeoutMs: number;
    readonly onClaimed?: () => void;
  },
): Promise<Asked> {
  const { clock } = options;
  const id = randomBytes(9).toString('base64url');
  const path = requestPath(hostDir, id);
  await writeFileAtomically(path, JSON.stringify({ ...request, id, requestedAt: clock.now() }));

  const claimBy = clock.now() + EXECUTOR_CLAIM_TIMEOUT_MS;
  while ((await exists(path)) && clock.now() < claimBy) await clock.sleep(REQUEST_POLL_MS);
  try {
    await unlink(path);
    return { answeredBy: 'nobody' };
  } catch {
    // Gone already: the executor renamed it, so the request is its to answer.
  }
  options.onClaimed?.();

  const result = resultPath(hostDir, id);
  const answerBy = clock.now() + options.resultTimeoutMs;
  for (;;) {
    const raw = await readFile(result, 'utf8').catch(() => undefined);
    if (raw !== undefined) {
      await unlink(result).catch(() => undefined);
      return { answeredBy: 'executor', result: BrowserWindowResultSchema.parse(JSON.parse(raw)) };
    }
    if (clock.now() >= answerBy) {
      throw new Error(
        'The browser executor took the request but has not answered after ' +
          `${String(Math.round(options.resultTimeoutMs / 1000))} seconds. Its log says why.`,
      );
    }
    await clock.sleep(REQUEST_POLL_MS);
  }
}
