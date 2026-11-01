/**
 * The four Slack Web API methods the app calls, over `fetch`.
 *
 * Four methods do not earn an SDK: the bot opens a direct message, posts into
 * it and edits a card it posted, and the app-level token opens a Socket Mode
 * connection.
 *
 * The default transport is the checked `safeFetchImpl`, as for every injected
 * transport. It validates the Slack host before it dials and refuses a redirect.
 */
import { safeFetchImpl } from '@aflow/network-safety';

const SLACK_API = 'https://slack.com/api';

/** Slack answers these when the request may succeed if sent again. */
const RETRYABLE_SLACK_ERRORS: ReadonlySet<string> = new Set([
  'ratelimited',
  'service_unavailable',
  'internal_error',
  'fatal_error',
  'request_timeout',
]);

export class SlackApiError extends Error {
  /**
   * `outcomeUnknown` is true when the request left but no readable answer came
   * back: a transport failure, the timeout, an HTTP 5xx, or a body that could
   * not be read. Slack may have acted on it, so a write method that failed this
   * way may have taken effect. A 5xx can come from a gateway in front of Slack
   * after Slack has acted, so it is not read as a refusal.
   */
  constructor(
    readonly method: string,
    readonly slackError: string,
    readonly retryable: boolean,
    readonly outcomeUnknown = false,
  ) {
    super(`Slack refused ${method}: ${slackError}`);
    this.name = 'SlackApiError';
  }
}

export interface PostedMessage {
  channel: string;
  ts: string;
}

/** Slack Block Kit blocks, passed through as Slack reads them. */
export type SlackBlock = Record<string, unknown>;

export interface PostOptions {
  blocks?: readonly SlackBlock[];
  /** Posts into the thread under this message. */
  threadTs?: string;
  /**
   * Ends the request when it aborts, as the step's own timeout and abort do.
   * An abort after the request left is an unknown outcome, as the timeout is.
   */
  signal?: AbortSignal;
}

export interface SlackClient {
  /** The direct-message channel between the bot and `userId`. */
  openDirectMessage(userId: string, signal?: AbortSignal): Promise<string>;
  postMessage(channel: string, text: string, options?: PostOptions): Promise<PostedMessage>;
  /** Replaces the text and blocks of a message the bot posted. */
  updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks: readonly SlackBlock[],
  ): Promise<void>;
  /** A fresh Socket Mode WebSocket URL, good for one connection. */
  openSocketModeUrl(): Promise<string>;
}

type Fetch = typeof fetch;

/** The longest one Slack call may take, inside whatever the caller's signal allows. */
export const SLACK_CALL_TIMEOUT_MS = 15_000;

async function call(
  fetchImpl: Fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Nothing has left yet, so a signal that has already ended posts nothing.
  if (signal?.aborted === true) {
    throw new SlackApiError(method, 'the step ended before the request left', true);
  }
  const timeout = AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
  } catch (error) {
    throw new SlackApiError(
      method,
      error instanceof Error ? error.message : 'the request did not complete',
      true,
      true,
    );
  }
  if (response.status === 429) {
    throw new SlackApiError(method, 'HTTP 429', true);
  }
  if (response.status >= 500) {
    throw new SlackApiError(method, `HTTP ${String(response.status)}`, true, true);
  }
  if (response.status >= 400) {
    throw new SlackApiError(method, `HTTP ${String(response.status)}`, false);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new SlackApiError(
      method,
      `the answer could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      true,
      true,
    );
  }
  if (payload === null || typeof payload !== 'object') {
    throw new SlackApiError(method, 'the answer was not a JSON object', true, true);
  }
  return checkPayload(method, payload as Record<string, unknown>);
}

function checkPayload(method: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (payload['ok'] !== true) {
    const slackError = typeof payload['error'] === 'string' ? payload['error'] : 'unknown_error';
    throw new SlackApiError(method, slackError, RETRYABLE_SLACK_ERRORS.has(slackError));
  }
  return payload;
}

export function createSlackClient(options: {
  botToken: string;
  appToken: string;
  fetchImpl?: Fetch;
}): SlackClient {
  const fetchImpl = options.fetchImpl ?? safeFetchImpl;
  return {
    async openDirectMessage(userId, signal) {
      const payload = await call(
        fetchImpl,
        options.botToken,
        'conversations.open',
        { users: userId },
        signal,
      );
      const channel = (payload['channel'] as { id?: unknown } | undefined)?.id;
      if (typeof channel !== 'string') {
        throw new SlackApiError('conversations.open', 'no_channel_in_response', false);
      }
      return channel;
    },
    async postMessage(channel, text, post = {}) {
      const payload = await call(
        fetchImpl,
        options.botToken,
        'chat.postMessage',
        {
          channel,
          text,
          ...(post.blocks === undefined ? {} : { blocks: post.blocks }),
          ...(post.threadTs === undefined ? {} : { thread_ts: post.threadTs }),
        },
        post.signal,
      );
      const ts = payload['ts'];
      const posted = payload['channel'];
      if (typeof ts !== 'string' || typeof posted !== 'string') {
        throw new SlackApiError('chat.postMessage', 'no_ts_in_response', false, true);
      }
      return { channel: posted, ts };
    },
    async updateMessage(channel, ts, text, blocks) {
      await call(fetchImpl, options.botToken, 'chat.update', { channel, ts, text, blocks });
    },
    async openSocketModeUrl() {
      const payload = await call(fetchImpl, options.appToken, 'apps.connections.open', {});
      const url = payload['url'];
      if (typeof url !== 'string') {
        throw new SlackApiError('apps.connections.open', 'no_url_in_response', false);
      }
      return url;
    },
  };
}
