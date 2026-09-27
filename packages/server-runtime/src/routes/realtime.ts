import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  ClientRealtimeMessageSchema,
  RealtimeProtocolVersion,
  ServerRealtimeMessageSchema,
  realtimeTopicKey,
  type ClientRealtimeMessage,
  type RealtimeTopicKind,
  type RealtimeTopicSubscribe,
  type ServerRealtimeMessage,
} from '@aflow/schemas';
import { consumeRealtimeToken, type StoredRealtimeToken } from './realtimeToken.js';
import {
  recordBytesSent,
  recordConnectionClosed,
  recordConnectionOpened,
  recordConnectionResult,
  recordEventEmitted,
  recordMessageReceived,
  recordReconcile,
  recordSubscribe,
  type EmittedKind,
} from './realtimeMetrics.js';

/**
 * Minimal interface for the WebSocket connection exposed by
 * @fastify/websocket. Defined locally to avoid an unresolvable `ws`
 * package type dependency.
 */
interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (rawMessage: Buffer | ArrayBuffer | Buffer[]) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: unknown) => void): this;
}

// ============================================================================

/**
 * Per-user concurrent connection cap. The reasonable case is ~1
 * connection per tab; the cap defends against runaway client bugs and
 * malicious fan-out without hurting normal multi-tab use.
 */
const MAX_CONNECTIONS_PER_USER = 16;

const MAX_SUBSCRIPTIONS_PER_CONNECTION = 32;

const connectionsByUser = new Map<string, Set<RealtimeConnection>>();

// ============================================================================
// Topic registry — extension point for Phases 4–6
// ============================================================================

export interface TopicSubscribeContext {
  /** Stored claims from the consumed token. The tenant on the wire
   *  must match `connection.tenantId` — already enforced in `accept`. */
  connection: RealtimeConnection;
  topic: RealtimeTopicSubscribe;
  subscriptionId: string;
  topicKey: string;
  /** Send a message scoped to this subscription. Validated before send. */
  emit: (message: ServerRealtimeMessage) => void;
}

export type TopicSubscribeResult =
  | {
      kind: 'accepted';
      /** Initial cursor for the topic (echoed in `subscribed` reply). */
      cursor?: string;
      start?: () => Promise<void> | void;
      cleanup: () => Promise<void> | void;
    }
  | {
      kind: 'denied';
      code: string;
      message: string;
    }
  | { kind: 'not_supported' };

export interface TopicHandler {
  kind: RealtimeTopicKind;
  subscribe(ctx: TopicSubscribeContext): Promise<TopicSubscribeResult>;
}

const topicHandlers = new Map<RealtimeTopicKind, TopicHandler>();

export function registerRealtimeTopic(handler: TopicHandler): void {
  topicHandlers.set(handler.kind, handler);
}

// ============================================================================
// Per-connection state
// ============================================================================

interface ConnectionSubscription {
  subscriptionId: string;
  topicKey: string;
  topicKind: RealtimeTopicKind;
  cleanup: () => Promise<void> | void;
}

export class RealtimeConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly token: StoredRealtimeToken;
  readonly clientId: string;
  readonly tabId: string;
  readonly subscriptions = new Map<string, ConnectionSubscription>();
  private readonly socket: WebSocketLike;
  private readonly log: FastifyRequest['log'];
  private closed = false;

  constructor(args: {
    id: string;
    socket: WebSocketLike;
    token: StoredRealtimeToken;
    clientId: string;
    tabId: string;
    log: FastifyRequest['log'];
  }) {
    this.id = args.id;
    this.socket = args.socket;
    this.token = args.token;
    this.tenantId = args.token.tenantId;
    this.userId = args.token.userId;
    this.clientId = args.clientId;
    this.tabId = args.tabId;
    this.log = args.log;
  }

  /**
   * Validate-then-send. Every server message passes through
   * `ServerRealtimeMessageSchema` so a bug in a topic handler cannot
   * leak an off-spec shape to clients.
   */
  send(message: ServerRealtimeMessage, topicKind?: RealtimeTopicKind): void {
    if (this.closed) return;
    const parsed = ServerRealtimeMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.log.error(
        { connectionId: this.id, issues: parsed.error.issues, type: message.type },
        'Realtime: refusing to send off-spec server message',
      );
      return;
    }
    const json = JSON.stringify(parsed.data);
    try {
      this.socket.send(json);
    } catch (err) {
      this.log.warn({ err, connectionId: this.id }, 'Realtime: socket send failed');
      return;
    }
    if (topicKind) {
      const kind: EmittedKind | null =
        message.type === 'event'
          ? 'event'
          : message.type === 'live_delta'
            ? 'live_delta'
            : message.type === 'snapshot'
              ? 'snapshot'
              : message.type === 'reconcile_required'
                ? 'reconcile_required'
                : null;
      if (kind) {
        recordEventEmitted(topicKind, kind);
        recordBytesSent(topicKind, json.length);
        if (kind === 'reconcile_required' && message.type === 'reconcile_required') {
          recordReconcile(topicKind, message.reason);
        }
      }
    }
  }

  /** Mark the connection as closed; subsequent sends become no-ops. */
  markClosed(): void {
    this.closed = true;
  }

  /** Whether the connection has been torn down. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Server-initiated teardown — the socket's close event runs the normal cleanup. */
  close(code?: number, reason?: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // Socket already gone — cleanup ran or will run via the close event.
    }
  }
}

/**
 * Close every realtime connection a user holds in a tenant. Called on
 * membership-revocation invalidation: subscriptions authorize only at
 * subscribe time, so revocation must tear the transport down — clients
 * reconnect and re-subscribe, and topics they lost get `subscribe_denied`
 * against freshly invalidated caches.
 */
export function closeRealtimeConnectionsForUser(tenantId: string, userId: string): number {
  const bucket = connectionsByUser.get(userId);
  if (!bucket) return 0;
  let closed = 0;
  for (const conn of [...bucket]) {
    if (conn.tenantId !== tenantId) continue;
    conn.send({
      type: 'error',
      code: 'access_revoked',
      retryable: true,
      message: 'Your access changed. Reconnect to continue.',
    });
    conn.close(4403, 'access_revoked');
    closed++;
  }
  return closed;
}

/** Test-only — register a connection in the user bucket; returns an unregister fn. */
export function __registerRealtimeConnectionForTests(conn: RealtimeConnection): () => void {
  let bucket = connectionsByUser.get(conn.userId);
  if (!bucket) {
    bucket = new Set();
    connectionsByUser.set(conn.userId, bucket);
  }
  bucket.add(conn);
  return () => {
    const b = connectionsByUser.get(conn.userId);
    b?.delete(conn);
    if (b?.size === 0) connectionsByUser.delete(conn.userId);
  };
}

// ============================================================================
// Connection accept
// ============================================================================

interface AcceptResult {
  ok: boolean;
  rejectReason?: 'origin' | 'token' | 'protocol' | 'budget';
}

/** Parse subprotocols from `Sec-WebSocket-Protocol` header value. */
function parseSubprotocols(header: string | string[] | undefined): string[] {
  if (!header) return [];
  if (Array.isArray(header)) {
    return header.flatMap((h) => h.split(',').map((s) => s.trim())).filter(Boolean);
  }
  return header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractTokenFromSubprotocols(subprotocols: string[]): string | null {
  for (const sp of subprotocols) {
    if (sp.startsWith('phoenix.token.')) return sp.slice('phoenix.token.'.length);
  }
  return null;
}

async function authenticateConnection(
  request: FastifyRequest,
): Promise<
  | { ok: true; token: StoredRealtimeToken; clientId: string }
  | { ok: false; status: number; reason: AcceptResult['rejectReason']; message: string }
> {
  const subprotocols = parseSubprotocols(request.headers['sec-websocket-protocol']);
  if (!subprotocols.includes('phoenix.v1')) {
    return {
      ok: false,
      status: 400,
      reason: 'protocol',
      message: "Missing 'phoenix.v1' subprotocol",
    };
  }
  const token = extractTokenFromSubprotocols(subprotocols);
  if (!token) {
    return {
      ok: false,
      status: 401,
      reason: 'token',
      message: 'Missing realtime token in Sec-WebSocket-Protocol',
    };
  }

  const redis = request.server.appContext.redis;
  const stored = await consumeRealtimeToken(redis, token);
  if (!stored) {
    return {
      ok: false,
      status: 401,
      reason: 'token',
      message: 'Realtime token is invalid, expired, or already consumed',
    };
  }
  if (stored.exp * 1000 < Date.now()) {
    return {
      ok: false,
      status: 401,
      reason: 'token',
      message: 'Realtime token is expired',
    };
  }

  const origin = request.headers.origin;
  if (!origin) {
    return {
      ok: false,
      status: 403,
      reason: 'origin',
      message: 'Missing Origin header',
    };
  }
  if (!stored.allowedOrigins.includes(origin)) {
    return {
      ok: false,
      status: 403,
      reason: 'origin',
      message: `Origin '${origin}' not in token's allowlist`,
    };
  }

  // Per-user connection budget.
  const existing = connectionsByUser.get(stored.userId);
  if (existing && existing.size >= MAX_CONNECTIONS_PER_USER) {
    return {
      ok: false,
      status: 429,
      reason: 'budget',
      message: `Per-user realtime connection cap of ${String(MAX_CONNECTIONS_PER_USER)} reached`,
    };
  }

  return { ok: true, token: stored, clientId: token.slice(0, 12) };
}

// ============================================================================
// Routes
// ============================================================================

export const realtimeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/',
    {
      websocket: true,
      config: {
        authzExempt: {
          reason:
            'WebSocket upgrade carries no Authorization header; authenticateConnection() validates the minted realtime token during the handshake.',
        },
      },
      schema: {
        tags: ['Realtime'],
        summary: 'Unified realtime WebSocket gateway',
        description: `
Plan 170 unified realtime transport. Browser surfaces multiplex
session events, Action Center, entity events, and best-effort
activity over one long-lived connection per tab.

**Connect flow:**

1. The browser mints a short-lived token via the BFF:
   \`POST /api/realtime/token\` → returns \`{ token, realtimeUrl }\`.
2. The browser opens
   \`new WebSocket(realtimeUrl, ['phoenix.v1', 'phoenix.token.<token>'])\`.
3. The gateway validates Origin + consumes the token + replies with
   a \`ready\` message.
4. The client sends \`hello\` then \`subscribe\` per topic.

**Wire shapes:** see \`@aflow/schemas/runtime/realtimeProtocol.ts\`
        `.trim(),
      },
    },
    async (socket: WebSocketLike, request) => {
      const MAX_EARLY_MESSAGES = 64;
      const earlyMessageBuffer: Array<Buffer | ArrayBuffer | Buffer[]> = [];
      let messageDispatcher: ((raw: Buffer | ArrayBuffer | Buffer[]) => void) | null = null;
      socket.on('message', (raw) => {
        if (messageDispatcher) {
          messageDispatcher(raw);
          return;
        }
        if (earlyMessageBuffer.length >= MAX_EARLY_MESSAGES) return;
        earlyMessageBuffer.push(raw);
      });

      const auth = await authenticateConnection(request);
      if (!auth.ok) {
        const reason = auth.reason ?? 'origin';
        recordConnectionResult(
          reason === 'origin'
            ? 'rejected_origin'
            : reason === 'token'
              ? 'rejected_token'
              : reason === 'budget'
                ? 'rejected_budget'
                : 'rejected_protocol',
        );
        // §5.1 — log without token bytes. Token was already consumed
        // (or never existed) at this point.
        request.log.warn(
          { reason, origin: request.headers.origin, status: auth.status },
          'Realtime: connection rejected',
        );
        try {
          socket.send(
            JSON.stringify({
              type: 'error',
              code: reason,
              retryable: false,
              message: auth.message,
            }),
          );
        } catch {
          /* socket may already be torn down */
        }
        socket.close(4000 + auth.status, auth.message.slice(0, 120));
        return;
      }

      const connectionId = crypto.randomUUID();
      // `clientId` / `tabId` come from the `hello` message; placeholder
      // defaults so we can record metrics before hello arrives.
      const conn = new RealtimeConnection({
        id: connectionId,
        socket,
        token: auth.token,
        clientId: auth.clientId,
        tabId: 'unknown',
        log: request.log,
      });

      let userBucket = connectionsByUser.get(auth.token.userId);
      if (!userBucket) {
        userBucket = new Set();
        connectionsByUser.set(auth.token.userId, userBucket);
      }
      userBucket.add(conn);

      recordConnectionResult('accepted', auth.token.tenantId);
      recordConnectionOpened(auth.token.tenantId, auth.token.userId);
      request.log.info(
        {
          connectionId,
          tenantId: auth.token.tenantId,
          userId: auth.token.userId,
          allowedOrigins: auth.token.allowedOrigins,
        },
        'Realtime: connection accepted',
      );

      let helloReceived = false;
      let closeError = false;

      const cleanup = async () => {
        if (conn.isClosed) return;
        conn.markClosed();
        for (const sub of conn.subscriptions.values()) {
          try {
            await sub.cleanup();
          } catch (err) {
            request.log.warn(
              { err, connectionId, subscriptionId: sub.subscriptionId },
              'Realtime: subscription cleanup failed',
            );
          }
        }
        conn.subscriptions.clear();
        userBucket.delete(conn);
        if (userBucket.size === 0) {
          connectionsByUser.delete(auth.token.userId);
        }
        recordConnectionClosed(auth.token.tenantId, auth.token.userId);
        recordConnectionResult(closeError ? 'closed_error' : 'closed_normal', auth.token.tenantId);
      };

      // Install the real dispatcher and drain any messages that arrived
      // during the `await authenticateConnection(...)` window above.
      // Order matters: install the dispatcher (so any FURTHER messages
      // are dispatched, not buffered), then drain in FIFO order — that
      // way a `hello` received during the auth window is processed
      // BEFORE the subscribes that followed it on the wire.
      messageDispatcher = (raw) => {
        // Fire-and-forget — message handlers are async but errors here
        // shouldn't propagate to the connection.
        void handleClientMessage(raw).catch((err: unknown) => {
          request.log.warn({ err, connectionId }, 'Realtime: client message handler threw');
        });
      };
      for (const raw of earlyMessageBuffer) {
        messageDispatcher(raw);
      }
      earlyMessageBuffer.length = 0;

      // Initial ready message — informs the client that the gateway
      // accepted the token and the protocol versions match. The client
      // sends `hello` in response (clientId / tabId).
      conn.send({
        type: 'ready',
        protocolVersion: RealtimeProtocolVersion,
        serverTime: new Date().toISOString(),
      });

      socket.on('close', () => {
        request.log.debug({ connectionId }, 'Realtime: socket closed');
        void cleanup();
      });

      socket.on('error', (err: unknown) => {
        closeError = true;
        request.log.warn({ err, connectionId }, 'Realtime: socket error');
        void cleanup();
      });

      // -------------------------------------------------------------
      // Message dispatch
      // -------------------------------------------------------------
      async function handleClientMessage(raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
        if (conn.isClosed) return;
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString()
          : raw instanceof Buffer
            ? raw.toString()
            : new TextDecoder().decode(raw as ArrayBuffer);

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(text) as unknown;
        } catch {
          conn.send({
            type: 'error',
            code: 'invalid_message',
            retryable: false,
            message: 'Message body is not valid JSON',
          });
          return;
        }

        const parsed = ClientRealtimeMessageSchema.safeParse(parsedJson);
        if (!parsed.success) {
          // Try to extract `requestId` from the raw shape so the client
          // can correlate the failure.
          const requestId =
            typeof parsedJson === 'object' &&
            parsedJson !== null &&
            'requestId' in parsedJson &&
            typeof (parsedJson as { requestId: unknown }).requestId === 'string'
              ? (parsedJson as { requestId: string }).requestId
              : undefined;
          conn.send({
            type: 'error',
            ...(requestId ? { requestId } : {}),
            code: 'invalid_message',
            retryable: false,
            message: `Message failed schema validation: ${parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`,
          });
          return;
        }

        const message: ClientRealtimeMessage = parsed.data;
        recordMessageReceived(message.type);
        switch (message.type) {
          case 'hello': {
            handleHello(message);
            return;
          }
          case 'subscribe':
            return handleSubscribe(message);
          case 'unsubscribe':
            return handleUnsubscribe(message);
          case 'ping': {
            handlePing(message);
            return;
          }
          case 'presence_update': {
            void handlePresenceUpdate(message);
            return;
          }
        }
      }

      /**
       * Presence is the one thing the socket cannot tell us. It knows a tab
       * is open; only the client knows whether someone is looking at this
       * room or typing in it. Unknown subscriptions are ignored rather than
       * refused — a heartbeat arriving just after an unsubscribe is normal.
       */
      async function handlePresenceUpdate(
        message: ClientRealtimeMessage & { type: 'presence_update' },
      ): Promise<void> {
        if (!conn.subscriptions.has(message.subscriptionId)) return;
        const { applyPresenceUpdate } = await import('./realtimeTopics/sessionPresence.js');
        await applyPresenceUpdate(
          fastify.appContext.redis,
          message.subscriptionId,
          message.activity,
        ).catch((err: unknown) => {
          fastify.log.warn({ err }, 'presence update failed');
        });
      }

      function handleHello(message: ClientRealtimeMessage & { type: 'hello' }): void {
        if (helloReceived) {
          conn.send({
            type: 'error',
            code: 'duplicate_hello',
            retryable: false,
            message: 'hello already received',
          });
          return;
        }
        if (message.protocolVersion !== RealtimeProtocolVersion) {
          conn.send({
            type: 'error',
            code: 'protocol_version_mismatch',
            retryable: false,
            message: `Server protocol version is ${String(RealtimeProtocolVersion)}`,
          });
          socket.close(4400, 'Protocol version mismatch');
          return;
        }
        helloReceived = true;
        // Capture clientId/tabId for downstream metrics + logging.
        (conn as unknown as { clientId: string }).clientId = message.clientId;
        (conn as unknown as { tabId: string }).tabId = message.tabId;
      }

      async function handleSubscribe(
        message: ClientRealtimeMessage & { type: 'subscribe' },
      ): Promise<void> {
        if (!helloReceived) {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'hello_required',
            retryable: false,
            message: 'send `hello` before subscribing',
          });
          return;
        }
        if (conn.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'subscription_budget_exceeded',
            retryable: false,
            message: `Per-connection subscription cap of ${String(MAX_SUBSCRIPTIONS_PER_CONNECTION)} reached`,
          });
          recordSubscribe(message.topic.kind, 'budget_exceeded', conn.tenantId);
          return;
        }

        const topic = message.topic;
        if (topic.kind === 'session.events' && topic.tenantId && topic.tenantId !== conn.tenantId) {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'subscribe_denied',
            retryable: false,
            message: 'tenantId on session.events must match connection tenant',
          });
          recordSubscribe(topic.kind, 'denied', conn.tenantId);
          return;
        }
        if (
          (topic.kind === 'space.action_center' ||
            topic.kind === 'space.entity_events' ||
            topic.kind === 'space.coach_surface') &&
          conn.token.allowedSpaceIds &&
          conn.token.allowedSpaceIds.length > 0 &&
          !conn.token.allowedSpaceIds.includes(topic.spaceId)
        ) {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'subscribe_denied',
            retryable: false,
            message: 'spaceId not in token allowlist',
          });
          recordSubscribe(topic.kind, 'denied', conn.tenantId);
          return;
        }
        if (
          topic.kind === 'session.events' &&
          conn.token.allowedSessionIds &&
          conn.token.allowedSessionIds.length > 0 &&
          !conn.token.allowedSessionIds.includes(topic.sessionId)
        ) {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'subscribe_denied',
            retryable: false,
            message: 'sessionId not in token allowlist',
          });
          recordSubscribe(topic.kind, 'denied', conn.tenantId);
          return;
        }

        const subscriptionId = crypto.randomUUID();
        const topicKey = realtimeTopicKey(topic);
        const handler = topicHandlers.get(topic.kind);
        if (!handler) {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'topic_not_supported',
            retryable: false,
            message: `Topic '${topic.kind}' is not registered on this gateway`,
          });
          recordSubscribe(topic.kind, 'not_supported', conn.tenantId);
          return;
        }

        const scopedEmit = (msg: ServerRealtimeMessage) => {
          switch (msg.type) {
            case 'event':
              conn.send(
                {
                  type: 'event',
                  subscriptionId,
                  topicKey,
                  cursor: msg.cursor,
                  event: msg.event,
                },
                topic.kind,
              );
              return;
            case 'live_delta':
              conn.send(
                {
                  type: 'live_delta',
                  subscriptionId,
                  topicKey,
                  stepExecutionId: msg.stepExecutionId,
                  channel: msg.channel,
                  offset: msg.offset,
                  delta: msg.delta,
                },
                topic.kind,
              );
              return;
            case 'snapshot':
              conn.send(
                {
                  type: 'snapshot',
                  subscriptionId,
                  topicKey,
                  cursor: msg.cursor,
                  data: msg.data,
                },
                topic.kind,
              );
              return;
            case 'reconcile_required':
              conn.send(
                {
                  type: 'reconcile_required',
                  subscriptionId,
                  topicKey,
                  reason: msg.reason,
                  ...(msg.cursor ? { cursor: msg.cursor } : {}),
                },
                topic.kind,
              );
              return;
            case 'error':
            case 'ready':
            case 'subscribed':
            case 'pong':
              // Gateway-owned — topic handlers must not synthesise these.
              return;
          }
        };

        const result = await handler.subscribe({
          connection: conn,
          topic,
          subscriptionId,
          topicKey,
          emit: scopedEmit,
        });

        // The WS may have
        // closed during the await above. Connection cleanup has
        // already run by this point, so registering this
        // subscription's cleanup in `conn.subscriptions` would leak it
        // (cleanup is iterated only at close, and that already fired).
        // Run the handler's own cleanup explicitly and bail. This is
        // the recovery hook for everything from a pool entry the
        // handler installed (e.g. spaceActionCenter's bootstrap) to a
        // tail iterator the sessionEvents handler started.
        if (conn.isClosed && result.kind === 'accepted') {
          try {
            await result.cleanup();
          } catch (err) {
            request.log.warn(
              { err, connectionId, subscriptionId },
              'Realtime: post-close subscription cleanup failed',
            );
          }
          return;
        }

        if (result.kind === 'not_supported') {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'topic_not_supported',
            retryable: false,
            message: `Topic '${topic.kind}' is not registered on this gateway`,
          });
          recordSubscribe(topic.kind, 'not_supported', conn.tenantId);
          return;
        }
        if (result.kind === 'denied') {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: result.code,
            retryable: false,
            message: result.message,
          });
          recordSubscribe(topic.kind, 'denied', conn.tenantId);
          return;
        }

        conn.subscriptions.set(subscriptionId, {
          subscriptionId,
          topicKey,
          topicKind: topic.kind,
          cleanup: result.cleanup,
        });
        conn.send({
          type: 'subscribed',
          requestId: message.requestId,
          subscriptionId,
          topicKey,
          ...(result.cursor ? { cursor: result.cursor } : {}),
        });
        recordSubscribe(topic.kind, 'accepted', conn.tenantId);

        if (result.start) {
          try {
            await result.start();
          } catch (err) {
            request.log.warn(
              { err, connectionId, subscriptionId, topicKind: topic.kind },
              'Realtime: topic handler `start` threw',
            );
          }
        }
      }

      async function handleUnsubscribe(
        message: ClientRealtimeMessage & { type: 'unsubscribe' },
      ): Promise<void> {
        const sub = conn.subscriptions.get(message.subscriptionId);
        if (!sub) {
          conn.send({
            type: 'error',
            requestId: message.requestId,
            code: 'subscription_not_found',
            retryable: false,
            message: `subscriptionId '${message.subscriptionId}' not active`,
          });
          return;
        }
        conn.subscriptions.delete(message.subscriptionId);
        try {
          await sub.cleanup();
        } catch (err) {
          request.log.warn(
            { err, connectionId, subscriptionId: sub.subscriptionId },
            'Realtime: unsubscribe cleanup threw',
          );
        }
      }

      function handlePing(message: ClientRealtimeMessage & { type: 'ping' }): void {
        conn.send({
          type: 'pong',
          requestId: message.requestId,
          serverTime: new Date().toISOString(),
        });
      }
    },
  );
};

export { broadcastActivity, sendStepActivity, sendThinkingActivity } from './realtimeActivity.js';
