/**
 * The two Action Center routes the app calls, with the instance owner's key
 * that setup mints (Plan 327 D3, D5): the item read and the resolve the web app
 * calls. The app holds no other way into the platform's items, so every
 * decision from the phone passes the Action Center's own resolve boundary,
 * its compare-and-set on the origin and its audit.
 *
 * The transport is given, never defaulted. The API is the operator's own stack
 * on loopback, which the checked Slack transport refuses on purpose.
 */
import {
  ActionCenterItemSchema,
  type ActionCenterItem,
  type ActionCenterResolution,
} from '@aflow/schemas';

/** The origin exactly as the API sent it, which the resolve compares against. */
export type ObservedOrigin = Record<string, unknown>;

export interface ReadItem {
  ok: true;
  item: ActionCenterItem;
  origin: ObservedOrigin;
}

/** The route's own answer when it did not do what was asked. */
export interface RouteRefusal {
  ok: false;
  /** The HTTP status, or 0 when no answer came back. */
  status: number;
  error: string;
  message: string;
  /** True when the same request may succeed if sent again. */
  retryable: boolean;
  latestItem?: ActionCenterItem;
}

export interface ResolvedItem {
  ok: true;
  item?: ActionCenterItem;
}

export interface AflowApi {
  readItem(spaceId: string, itemId: string, signal?: AbortSignal): Promise<ReadItem | RouteRefusal>;
  resolveItem(
    spaceId: string,
    itemId: string,
    origin: ObservedOrigin,
    resolution: ActionCenterResolution,
    signal?: AbortSignal,
  ): Promise<ResolvedItem | RouteRefusal>;
}

export const AFLOW_API_CALL_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

function itemPath(spaceId: string, itemId: string): string {
  return `/v1/spaces/${encodeURIComponent(spaceId)}/action-center/${encodeURIComponent(itemId)}`;
}

function refusalOf(status: number, body: unknown): RouteRefusal {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const latest = ActionCenterItemSchema.safeParse(record['latestItem']);
  return {
    ok: false,
    status,
    error: typeof record['error'] === 'string' ? record['error'] : `HTTP_${String(status)}`,
    message:
      typeof record['message'] === 'string'
        ? record['message']
        : `Aflow answered HTTP ${String(status)}.`,
    retryable: status === 429 || status >= 500,
    ...(latest.success ? { latestItem: latest.data } : {}),
  };
}

export function createAflowApi(options: {
  apiUrl: string;
  apiKey: string;
  fetchImpl: Fetch;
}): AflowApi {
  const base = options.apiUrl.replace(/\/$/, '');

  async function request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; json: unknown } | RouteRefusal> {
    const timeout = AbortSignal.timeout(AFLOW_API_CALL_TIMEOUT_MS);
    try {
      const response = await options.fetchImpl(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
      return { status: response.status, json: await response.json().catch(() => undefined) };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: 'UNREACHABLE',
        message: `Aflow did not answer: ${error instanceof Error ? error.message : 'unknown error'}.`,
        retryable: true,
      };
    }
  }

  return {
    async readItem(spaceId, itemId, signal) {
      const answer = await request(itemPath(spaceId, itemId), undefined, signal);
      if ('ok' in answer) return answer;
      if (answer.status !== 200) return refusalOf(answer.status, answer.json);
      const item = ActionCenterItemSchema.safeParse(answer.json);
      if (!item.success) {
        return {
          ok: false,
          status: 200,
          error: 'UNREADABLE_ITEM',
          message: `Aflow sent item ${itemId} in a shape this app does not read.`,
          retryable: false,
        };
      }
      return {
        ok: true,
        item: item.data,
        origin: (answer.json as { origin: ObservedOrigin }).origin,
      };
    },

    async resolveItem(spaceId, itemId, origin, resolution, signal) {
      const answer = await request(
        `${itemPath(spaceId, itemId)}/resolve`,
        { origin, resolution },
        signal,
      );
      if ('ok' in answer) return answer;
      if (answer.status !== 200) return refusalOf(answer.status, answer.json);
      // A 200 is the decision taken, whatever shape the item comes back in.
      const item = ActionCenterItemSchema.safeParse(
        (answer.json as Record<string, unknown> | undefined)?.['item'],
      );
      return item.success ? { ok: true, item: item.data } : { ok: true };
    },
  };
}
