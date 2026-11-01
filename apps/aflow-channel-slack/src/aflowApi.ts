/**
 * The routes the app calls, with the instance owner's key that setup mints
 * (Plan 327 D3, D4, D5). Two are the Action Center's: the item read and the
 * resolve the web app calls. The app holds no other way into the platform's
 * items, so every decision from the phone passes the Action Center's own
 * resolve boundary, its compare-and-set on the origin and its audit.
 *
 * The rest carry a conversation (D4): the tenant and its spaces, to find the
 * home space, and the session start, resume and event routes an API client
 * uses. A start uses mode `api` and a resume names the paused step, as those
 * routes require of a key.
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
  /**
   * True when the request may have reached Aflow and been acted on: a timeout
   * or a broken connection after it left, or a 5xx. False when Aflow answered a
   * refusal, or when no connection was made.
   */
  outcomeUnknown: boolean;
  latestItem?: ActionCenterItem;
}

export interface ResolvedItem {
  ok: true;
  item?: ActionCenterItem;
}

/** The space a conversation from Slack runs in, chosen as the web app chooses its first. */
export interface HomeSpace {
  ok: true;
  spaceId: string;
}

export interface StartedConversation {
  ok: true;
  sessionId: string;
}

export interface Accepted {
  ok: true;
}

/** What the app reads of a session event: its type, its step and the agent's reply. */
export interface ConversationEvent {
  eventType: string;
  timestamp: string;
  stepExecutionId?: string;
  /** The Helmsman's reply, which rides a `SessionPaused` event's metadata. */
  agentResponse?: string;
  /** True on a pause that waits for the person's next message. */
  asksForReply: boolean;
}

export interface SessionEvents {
  ok: true;
  events: ConversationEvent[];
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
  homeSpace(): Promise<HomeSpace | RouteRefusal>;
  /** `POST /v1/sessions`: a Helmsman conversation, mode `api`, keyed on the Slack event. */
  startConversation(
    spaceId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<StartedConversation | RouteRefusal>;
  /** `POST /v1/sessions/:id/resume`, guarded by the paused step's id. */
  resumeConversation(
    spaceId: string,
    sessionId: string,
    stepExecutionId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<Accepted | RouteRefusal>;
  /** The newest page of a session's events. */
  latestEvents(spaceId: string, sessionId: string): Promise<SessionEvents | RouteRefusal>;
}

/** The Helmsman, as the web app's conversation targets it (Plan 327 D4). */
export const HELMSMAN_TARGET = {
  kind: 'platform-role',
  systemRole: 'cybernetic-helmsman',
} as const;

/**
 * The start mode. `chat` is kept for an interactive sign-in, which an API key
 * never is (`refusedStartMode`). `api` is attended, because the key is a
 * person's principal, so the conversation carries the operator's own authority
 * and nothing more.
 */
export const CONVERSATION_START_MODE = 'api';

/** Enough of the newest events to hold the last pause or end of a turn. */
const EVENT_PAGE_LIMIT = 50;

export const AFLOW_API_CALL_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

function itemPath(spaceId: string, itemId: string): string {
  return `/v1/spaces/${encodeURIComponent(spaceId)}/action-center/${encodeURIComponent(itemId)}`;
}

/** Failures in which no connection was made, so no request left. */
const CONNECT_FAILURES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * True only when the failure proves no connection was made. `fetch` wraps the
 * socket's error in `cause`, and one that tried several addresses wraps one
 * error per address. Any other failure may have come after the request left.
 */
export function neverConnected(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.code === 'string' && CONNECT_FAILURES.has(record.code)) return true;
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return record.errors.every(neverConnected);
  }
  return record.cause !== undefined && neverConnected(record.cause);
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
    // A 500 can follow a resolve that was applied, as DISPATCH_FAILED does.
    outcomeUnknown: status >= 500,
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
    idempotencyKey?: string,
  ): Promise<{ status: number; json: unknown } | RouteRefusal> {
    const timeout = AbortSignal.timeout(AFLOW_API_CALL_TIMEOUT_MS);
    try {
      const response = await options.fetchImpl(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
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
        outcomeUnknown: !neverConnected(error),
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
          outcomeUnknown: false,
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

    async homeSpace() {
      const tenant = await request('/v1/tenant', undefined, undefined);
      if ('ok' in tenant) return tenant;
      if (tenant.status !== 200) return refusalOf(tenant.status, tenant.json);
      const listed = await request('/v1/spaces', undefined, undefined);
      if ('ok' in listed) return listed;
      if (listed.status !== 200) return refusalOf(listed.status, listed.json);
      const spaceId = homeSpaceOf(tenant.json, listed.json);
      if (spaceId === undefined) {
        return {
          ok: false,
          status: 200,
          error: 'NO_SPACE',
          message: 'The account this app acts for is a member of no space.',
          retryable: false,
          outcomeUnknown: false,
        };
      }
      return { ok: true, spaceId };
    },

    async startConversation(spaceId, text, idempotencyKey) {
      const answer = await request(
        `/v1/sessions?spaceId=${encodeURIComponent(spaceId)}`,
        { target: HELMSMAN_TARGET, mode: CONVERSATION_START_MODE, input: { input: text } },
        undefined,
        idempotencyKey,
      );
      if ('ok' in answer) return answer;
      const record = (answer.json ?? {}) as Record<string, unknown>;
      // A start already made under this key answers with the session it made.
      const sessionId =
        answer.status === 201
          ? record['sessionId']
          : answer.status === 409
            ? record['existingSessionId']
            : undefined;
      if (typeof sessionId === 'string') return { ok: true, sessionId };
      return refusalOf(answer.status, answer.json);
    },

    async resumeConversation(spaceId, sessionId, stepExecutionId, text, idempotencyKey) {
      const answer = await request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/resume?spaceId=${encodeURIComponent(spaceId)}`,
        { stepExecutionId, input: { input: text } },
        undefined,
        idempotencyKey,
      );
      if ('ok' in answer) return answer;
      if (answer.status !== 200) return refusalOf(answer.status, answer.json);
      return { ok: true };
    },

    async latestEvents(spaceId, sessionId) {
      const answer = await request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=${String(EVENT_PAGE_LIMIT)}&spaceId=${encodeURIComponent(spaceId)}`,
        undefined,
        undefined,
      );
      if ('ok' in answer) return answer;
      if (answer.status !== 200) return refusalOf(answer.status, answer.json);
      const events = (answer.json as { events?: unknown } | undefined)?.events;
      return { ok: true, events: Array.isArray(events) ? events.flatMap(conversationEventOf) : [] };
    },
  };
}

/** The tenant's default space where the account reaches it, else the first space it reaches. */
export function homeSpaceOf(tenant: unknown, listed: unknown): string | undefined {
  const spaces = (listed as { spaces?: unknown } | undefined)?.spaces;
  const reachable = (Array.isArray(spaces) ? spaces : []).filter(
    (space): space is { id: string } =>
      typeof (space as { id?: unknown }).id === 'string' &&
      (space as { myRole?: unknown }).myRole != null,
  );
  const named = (tenant as { defaultSpaceId?: unknown } | undefined)?.defaultSpaceId;
  return (reachable.find((space) => space.id === named) ?? reachable[0])?.id;
}

function conversationEventOf(raw: unknown): ConversationEvent[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const record = raw as Record<string, unknown>;
  const { eventType, timestamp, stepExecutionId } = record;
  if (typeof eventType !== 'string' || typeof timestamp !== 'string') return [];
  const metadata = record['metadata'] as Record<string, unknown> | undefined;
  const reply = metadata?.['agentResponse'];
  const missing = metadata?.['missingVariables'];
  // An agent turn that waits for the person names its chat input among the missing variables.
  const asksForReply =
    Array.isArray(missing) &&
    missing.some((entry) => {
      const id = (entry as { variableId?: unknown } | null)?.variableId;
      return typeof id === 'string' && id.startsWith('ai.agent.chatInput.');
    });
  return [
    {
      eventType,
      timestamp,
      asksForReply,
      ...(typeof stepExecutionId === 'string' ? { stepExecutionId } : {}),
      ...(typeof reply === 'string' && reply.trim() !== '' ? { agentResponse: reply } : {}),
    },
  ];
}
