/**
 * The three Slack Web API methods the app calls, over `fetch`.
 *
 * Three methods do not earn an SDK: the bot opens a direct message and posts
 * into it, and the app-level token opens a Socket Mode connection.
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

export interface SlackClient {
  /** The direct-message channel between the bot and `userId`. */
  openDirectMessage(userId: string): Promise<string>;
  postMessage(channel: string, text: string): Promise<PostedMessage>;
  /** A fresh Socket Mode WebSocket URL, good for one connection. */
  openSocketModeUrl(): Promise<string>;
}

type Fetch = typeof fetch;

async function call(
  fetchImpl: Fetch,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
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
    async openDirectMessage(userId) {
      const payload = await call(fetchImpl, options.botToken, 'conversations.open', {
        users: userId,
      });
      const channel = (payload['channel'] as { id?: unknown } | undefined)?.id;
      if (typeof channel !== 'string') {
        throw new SlackApiError('conversations.open', 'no_channel_in_response', false);
      }
      return channel;
    },
    async postMessage(channel, text) {
      const payload = await call(fetchImpl, options.botToken, 'chat.postMessage', {
        channel,
        text,
      });
      const ts = payload['ts'];
      const posted = payload['channel'];
      if (typeof ts !== 'string' || typeof posted !== 'string') {
        throw new SlackApiError('chat.postMessage', 'no_ts_in_response', false, true);
      }
      return { channel: posted, ts };
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
