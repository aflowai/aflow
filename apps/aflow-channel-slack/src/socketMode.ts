/**
 * Slack Socket Mode, as far as P0 needs it: direct messages to the bot, for
 * linking.
 *
 * Socket Mode needs no public URL, which is why an app on the operator's own
 * machine can receive anything at all. Every envelope is acknowledged at once,
 * so Slack does not redeliver it. A `disconnect` or a dropped socket opens a
 * fresh URL and connects again.
 */
import type { SlackClient } from './slack.js';

export interface DirectMessage {
  slackUserId: string;
  slackTeamId?: string;
  channel: string;
  text: string;
}

export interface SocketModeLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/** Only an ordinary direct message from a person reaches the app. */
export function directMessageOf(envelope: unknown): DirectMessage | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const record = envelope as Record<string, unknown>;
  if (record['type'] !== 'events_api') return undefined;
  const payload = record['payload'] as Record<string, unknown> | undefined;
  const event = payload?.['event'] as Record<string, unknown> | undefined;
  if (event?.['type'] !== 'message' || event['channel_type'] !== 'im') return undefined;
  // Edits, joins and the bot's own replies are subtyped or carry a bot id.
  if (event['subtype'] !== undefined || event['bot_id'] !== undefined) return undefined;
  const user = event['user'];
  const channel = event['channel'];
  const text = event['text'];
  if (typeof user !== 'string' || typeof channel !== 'string' || typeof text !== 'string') {
    return undefined;
  }
  const team = payload?.['team_id'];
  return {
    slackUserId: user,
    channel,
    text,
    ...(typeof team === 'string' ? { slackTeamId: team } : {}),
  };
}

const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_LONGEST_MS = 30_000;

export interface SocketModeConnection {
  stop(): void;
}

export function startSocketMode(options: {
  slack: SlackClient;
  onDirectMessage: (message: DirectMessage) => Promise<void>;
  log: SocketModeLog;
  WebSocketImpl?: typeof WebSocket;
}): SocketModeConnection {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = RECONNECT_FIRST_MS;

  const reconnect = (): void => {
    if (stopped || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_LONGEST_MS);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    let url: string;
    try {
      url = await options.slack.openSocketModeUrl();
    } catch (error) {
      options.log.warn('Slack would not open a Socket Mode connection; trying again', {
        error: error instanceof Error ? error.message : String(error),
      });
      reconnect();
      return;
    }
    const ws = new WebSocketImpl(url);
    socket = ws;
    ws.addEventListener('message', (event: MessageEvent) => {
      let envelope: unknown;
      try {
        envelope = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const record = envelope as Record<string, unknown>;
      if (record['type'] === 'hello') {
        backoffMs = RECONNECT_FIRST_MS;
        options.log.info('Connected to Slack');
        return;
      }
      if (record['type'] === 'disconnect') {
        ws.close();
        return;
      }
      const envelopeId = record['envelope_id'];
      if (typeof envelopeId === 'string') ws.send(JSON.stringify({ envelope_id: envelopeId }));
      const message = directMessageOf(envelope);
      if (message === undefined) return;
      options.onDirectMessage(message).catch((error: unknown) => {
        // The text is never logged: a stranger's message is not stored anywhere.
        options.log.warn('A direct message could not be answered', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    ws.addEventListener('close', () => {
      if (socket === ws) socket = undefined;
      reconnect();
    });
    ws.addEventListener('error', () => {
      ws.close();
    });
  };

  void connect();
  return {
    stop() {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    },
  };
}
