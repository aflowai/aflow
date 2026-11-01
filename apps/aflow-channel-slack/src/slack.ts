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
  constructor(
    readonly method: string,
    readonly slackError: string,
    readonly retryable: boolean,
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
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new SlackApiError(method, `HTTP ${String(response.status)}`, true);
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
        throw new SlackApiError('chat.postMessage', 'no_ts_in_response', false);
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
