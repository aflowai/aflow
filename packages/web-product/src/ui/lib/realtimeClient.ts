'use client';

import type {
  ClientRealtimeMessage,
  LiveDeltaFrame,
  PresenceActivity,
  ReconcileReason,
  RealtimeTopicSubscribe,
  ServerRealtimeMessage,
} from '@aflow/schemas';

/**
 * A frame of the in-flight step's partial output, minus its subscription
 * envelope. Carries no cursor — see `ServerLiveDeltaMessageSchema`. Re-exported
 * from the schema so both apps derive the one shape.
 */
export type { LiveDeltaFrame };

// ============================================================================
// Public types
// ============================================================================

export interface TopicListener {
  onEvent?: (event: unknown, cursor: string) => void;
  /** Preview of the step in flight. Deliberately handed no cursor to advance. */
  onLiveDelta?: (frame: LiveDeltaFrame) => void;
  onSnapshot?: (data: unknown, cursor: string) => void;
  onReconcileRequired?: (reason: ReconcileReason, cursor: string | undefined) => void;
  /** Fires when the subscription is denied or cancelled by the server. */
  onError?: (code: string, message: string) => void;
}

export interface ConnectionStatus {
  /** True while the WebSocket is OPEN. */
  isConnected: boolean;
  /** Last connect-failure surfaced to the consumer. */
  lastError: Error | null;
  /** Number of consecutive failed connects since last successful open. */
  failedConnectAttempts: number;
}

export type StatusListener = (status: ConnectionStatus) => void;

export interface TopicSubscriptionHandle {
  /** Stop receiving events. The physical socket stays open if other topics still subscribe. */
  unsubscribe(): void;
  /**
   * Report what this tab is doing, for presence.
   *
   * A no-op until the server has assigned a subscription id, and after the
   * subscription ends — presence is a statement about now, so one that
   * arrives outside the subscription's life is simply not true any more.
   */
  updatePresence(activity: PresenceActivity): void;
}

// ============================================================================
// Internal types
// ============================================================================

interface PendingSubscribe {
  requestId: string;
  topic: RealtimeTopicSubscribe;
  listener: TopicListener;
  /**
   * Resolved when the server replies `subscribed`. The server-supplied
   * `cursor` (when present) is the authoritative resume point —
   * topics that drain on subscribe may emit messages *before* sending
   * `subscribed`, so the `cursor` field on `subscribed` reflects where
   * those drains stopped, not the client's initial `topic.cursor`.
   */
  resolve(subscriptionId: string, serverCursor: string | undefined): void;
  reject(err: Error): void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
  subscriptionId: string;
  topic: RealtimeTopicSubscribe;
  listener: TopicListener;
  /**
   * Last cursor we received from the server — either echoed back in
   * `subscribed` (server's resume point) or advanced by each `event`
   * / `snapshot`. Used as the resume cursor on reconnect. The
   * client never reads `topic.cursor` after subscribe lands — the
   * server's view of "where we are" is authoritative.
   */
  cursor: string | undefined;
  cancelled?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const PROTOCOL_VERSION = 1;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const HELLO_TIMEOUT_MS = 5_000;
const SUBSCRIBE_TIMEOUT_MS = 10_000;

// ============================================================================
// Client implementation
// ============================================================================

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `r-${Math.random().toString(36).slice(2, 10)}`;
}

class RealtimeClient {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = {
    isConnected: false,
    lastError: null,
    failedConnectAttempts: 0,
  };
  private readonly statusListeners = new Set<StatusListener>();

  private readonly activeSubscriptions = new Map<string, ActiveSubscription>();
  private readonly pendingSubscribes = new Map<string, PendingSubscribe>();
  /** Queued subscribes that haven't been sent yet because the socket
   *  isn't ready. Drained after the server's `ready` arrives. */
  private readonly queuedSubscribes: PendingSubscribe[] = [];

  private helloAcked = false;
  private connecting = false;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly clientId: string;
  private readonly tabId: string;

  constructor() {
    this.clientId = this.resolveStableClientId();
    this.tabId = randomId();
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------

  subscribe(topic: RealtimeTopicSubscribe, listener: TopicListener): TopicSubscriptionHandle {
    let cancelled = false;
    let active: ActiveSubscription | null = null;

    const ensureSocket = () => {
      this.shouldReconnect = true;
      if (this.socket && this.helloAcked) return;
      this.connect();
    };

    const send = () => {
      if (cancelled) return;
      ensureSocket();
      const requestId = randomId();
      const pending: PendingSubscribe = {
        requestId,
        topic,
        listener,
        resolve: (subscriptionId, serverCursor) => {
          if (cancelled) {
            // Caller already gave up — immediately unsubscribe.
            this.sendRaw({ type: 'unsubscribe', requestId: randomId(), subscriptionId });
            return;
          }
          const topicCursor =
            topic.kind === 'session.events' || topic.kind === 'space.entity_events'
              ? topic.cursor
              : undefined;
          const resumeCursor = serverCursor ?? topicCursor;
          active = {
            subscriptionId,
            topic,
            listener,
            cursor: resumeCursor,
          };
          this.activeSubscriptions.set(subscriptionId, active);
        },
        reject: (err) => {
          if (cancelled) return;
          listener.onError?.('subscribe_failed', err.message);
        },
      };
      this.pendingSubscribes.set(requestId, pending);
      // If the socket isn't ready, queue and drain on ready.
      if (!this.socket || !this.helloAcked) {
        this.queuedSubscribes.push(pending);
        return;
      }
      this.sendRaw({ type: 'subscribe', requestId, topic });
      // Subscribe timeout — fail-loud rather than hang. Store the
      // handle so `onclose` can cancel it before requeueing — see the
      // `timeoutHandle` doc on PendingSubscribe.
      pending.timeoutHandle = setTimeout(() => {
        if (this.pendingSubscribes.delete(requestId)) {
          pending.reject(new Error(`subscribe to ${topic.kind} timed out`));
        }
      }, SUBSCRIBE_TIMEOUT_MS);
    };

    send();

    return {
      updatePresence: (activity: PresenceActivity) => {
        if (cancelled || !active) return;
        this.sendRaw({
          type: 'presence_update',
          subscriptionId: active.subscriptionId,
          activity,
        });
      },
      unsubscribe: () => {
        cancelled = true;
        if (active) {
          active.cancelled = true;
          this.activeSubscriptions.delete(active.subscriptionId);
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.sendRaw({
              type: 'unsubscribe',
              requestId: randomId(),
              subscriptionId: active.subscriptionId,
            });
          }
        }
        // If no active subscriptions remain and no pending work, we
        // could close the socket eagerly. We keep it open instead —
        // tabs typically re-subscribe within seconds on navigation.
      },
    };
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    // Fire current status immediately.
    try {
      listener(this.status);
    } catch (err) {
      console.error('[realtimeClient] status listener threw:', err);
    }
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Force a fresh token mint + reconnect. Used by surfaces that just
   * recovered from an auth flow.
   */
  reconnect(): void {
    this.tearDownSocket();
    this.connect();
  }

  // ---------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------

  private connect(): void {
    if (this.connecting || this.socket) return;
    this.connecting = true;
    void this.mintTokenAndOpen().catch((err: unknown) => {
      this.connecting = false;
      this.setStatus({
        isConnected: false,
        lastError: err instanceof Error ? err : new Error(String(err)),
        failedConnectAttempts: this.status.failedConnectAttempts + 1,
      });
      this.scheduleReconnect();
    });
  }

  private async mintTokenAndOpen(): Promise<void> {
    // Mint via BFF — passes through to the API server's token route.
    // Body left empty for now; per-page pre-scoping (allowedSpaceIds /
    // allowedSessionIds) is a future optimization.
    const res = await fetch('/api/realtime/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`realtime token mint failed (HTTP ${String(res.status)})`);
    }
    const json = (await res.json()) as { token: string; realtimeUrl: string };
    if (!json.token || !json.realtimeUrl) {
      throw new Error('realtime token mint returned an unexpected shape');
    }
    this.openSocket(json.realtimeUrl, json.token);
  }

  private openSocket(realtimeUrl: string, token: string): void {
    const ws = new WebSocket(realtimeUrl, ['phoenix.v1', `phoenix.token.${token}`]);
    this.socket = ws;

    let helloAckTimer: ReturnType<typeof setTimeout> | null = null;

    ws.onopen = () => {
      this.connecting = false;
      // Send hello immediately; the server replies `ready` (already
      // sent on its side, but we await it via the message handler).
      this.sendRaw({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        clientId: this.clientId,
        tabId: this.tabId,
      });
      helloAckTimer = setTimeout(() => {
        if (!this.helloAcked) {
          this.setStatus({
            isConnected: false,
            lastError: new Error('Server did not send `ready` within timeout'),
            failedConnectAttempts: this.status.failedConnectAttempts + 1,
          });
          ws.close();
        }
      }, HELLO_TIMEOUT_MS);
    };

    ws.onmessage = (raw: MessageEvent<string>) => {
      let parsed: ServerRealtimeMessage;
      try {
        parsed = JSON.parse(raw.data) as ServerRealtimeMessage;
      } catch {
        return;
      }
      this.handleServerMessage(parsed);
    };

    ws.onerror = () => {
      // Errors are followed by `close`; let `onclose` drive the
      // reconnect logic.
    };

    ws.onclose = (event) => {
      if (helloAckTimer) clearTimeout(helloAckTimer);
      this.socket = null;
      this.connecting = false;
      this.helloAcked = false;
      this.stopPingTimer();
      this.setStatus({
        isConnected: false,
        lastError: event.reason ? new Error(event.reason) : this.status.lastError,
        failedConnectAttempts: this.status.failedConnectAttempts + 1,
      });
      // Pending subscribes are kept in `queuedSubscribes` so they
      // re-fire on reconnect. Active subscriptions remain in the map
      // and re-subscribe from `cursor` on reopen.
      this.queuedSubscribes.length = 0;
      for (const pending of this.pendingSubscribes.values()) {
        if (pending.timeoutHandle) {
          clearTimeout(pending.timeoutHandle);
          delete pending.timeoutHandle;
        }
        this.queuedSubscribes.push(pending);
      }
      this.pendingSubscribes.clear();
      // Queue every active subscription as a fresh pending subscribe
      // with its last cursor — server allocates a NEW subscriptionId
      // on reopen.
      for (const sub of this.activeSubscriptions.values()) {
        // Explicit topic-kind narrowing so removing the `cursor` field
        // from a topic schema (Phase 5b removed it from
        // `space.action_center`; `activity` never had one) is caught
        // at the type level rather than producing a runtime payload
        // that doesn't match the wire schema.
        let requeueTopic: RealtimeTopicSubscribe;
        if (
          sub.cursor !== undefined &&
          (sub.topic.kind === 'session.events' || sub.topic.kind === 'space.entity_events')
        ) {
          requeueTopic = { ...sub.topic, cursor: sub.cursor };
        } else {
          requeueTopic = sub.topic;
        }
        const requeueRequestId = randomId();
        this.queuedSubscribes.push({
          requestId: requeueRequestId,
          topic: requeueTopic,
          listener: sub.listener,
          resolve: (newId, serverCursor) => {
            if (sub.cancelled) {
              this.sendRaw({
                type: 'unsubscribe',
                requestId: randomId(),
                subscriptionId: newId,
              });
              return;
            }
            // Migrate the subscription record.
            this.activeSubscriptions.delete(sub.subscriptionId);
            sub.subscriptionId = newId;
            if (serverCursor !== undefined) sub.cursor = serverCursor;
            this.activeSubscriptions.set(newId, sub);
          },
          reject: (err) => {
            if (sub.cancelled) return;
            sub.listener.onError?.('resubscribe_failed', err.message);
          },
        });
      }
      this.activeSubscriptions.clear();

      if (this.shouldReconnect) this.scheduleReconnect();
    };
  }

  private handleServerMessage(message: ServerRealtimeMessage): void {
    switch (message.type) {
      case 'ready':
        this.helloAcked = true;
        this.setStatus({
          isConnected: true,
          lastError: null,
          failedConnectAttempts: 0,
        });
        this.startPingTimer();
        this.drainQueuedSubscribes();
        return;
      case 'subscribed': {
        const pending = this.pendingSubscribes.get(message.requestId);
        if (!pending) {
          this.sendRaw({
            type: 'unsubscribe',
            requestId: randomId(),
            subscriptionId: message.subscriptionId,
          });
          return;
        }
        if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
        this.pendingSubscribes.delete(message.requestId);
        pending.resolve(message.subscriptionId, message.cursor);
        return;
      }
      case 'event': {
        const sub = this.activeSubscriptions.get(message.subscriptionId);
        if (!sub) return;
        sub.cursor = message.cursor;
        sub.listener.onEvent?.(message.event, message.cursor);
        return;
      }
      case 'live_delta': {
        const sub = this.activeSubscriptions.get(message.subscriptionId);
        if (!sub) return;
        sub.listener.onLiveDelta?.({
          stepExecutionId: message.stepExecutionId,
          channel: message.channel,
          offset: message.offset,
          delta: message.delta,
        });
        return;
      }
      case 'snapshot': {
        const sub = this.activeSubscriptions.get(message.subscriptionId);
        if (!sub) return;
        sub.cursor = message.cursor;
        sub.listener.onSnapshot?.(message.data, message.cursor);
        return;
      }
      case 'reconcile_required': {
        const sub = this.activeSubscriptions.get(message.subscriptionId);
        if (!sub) return;
        sub.listener.onReconcileRequired?.(message.reason, message.cursor);
        return;
      }
      case 'error': {
        if (message.requestId) {
          const pending = this.pendingSubscribes.get(message.requestId);
          if (pending) {
            if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
            this.pendingSubscribes.delete(message.requestId);
            pending.reject(new Error(`${message.code}: ${message.message}`));
            return;
          }
        }
        console.warn('[realtimeClient] server error', message);
        return;
      }
      case 'pong':
        return;
    }
  }

  private drainQueuedSubscribes(): void {
    const queued = this.queuedSubscribes.splice(0, this.queuedSubscribes.length);
    for (const pending of queued) {
      this.pendingSubscribes.set(pending.requestId, pending);
      this.sendRaw({
        type: 'subscribe',
        requestId: pending.requestId,
        topic: pending.topic,
      });
      pending.timeoutHandle = setTimeout(() => {
        if (this.pendingSubscribes.delete(pending.requestId)) {
          pending.reject(new Error(`subscribe to ${pending.topic.kind} timed out`));
        }
      }, SUBSCRIBE_TIMEOUT_MS);
    }
  }

  private sendRaw(message: ClientRealtimeMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      console.warn('[realtimeClient] socket send threw', err);
    }
  }

  private startPingTimer(): void {
    this.stopPingTimer();
    this.pingTimer = setInterval(() => {
      this.sendRaw({
        type: 'ping',
        requestId: randomId(),
        sentAt: new Date().toISOString(),
      });
    }, PING_INTERVAL_MS);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (!this.shouldReconnect) return;
    const attempt = this.status.failedConnectAttempts;
    const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    const jitter = Math.random() * base * 0.25;
    const delay = base + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      this.connect();
    }, delay);
  }

  private tearDownSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingTimer();
    this.helloAcked = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* socket may already be torn down */
      }
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (
      next.isConnected === this.status.isConnected &&
      next.lastError === this.status.lastError &&
      next.failedConnectAttempts === this.status.failedConnectAttempts
    ) {
      return;
    }
    this.status = next;
    for (const listener of this.statusListeners) {
      try {
        listener(next);
      } catch (err) {
        console.error('[realtimeClient] status listener threw:', err);
      }
    }
  }

  /**
   * Resolve a stable per-browser client id from localStorage. Lets
   * connection metrics correlate reconnects across page reloads.
   * Falls back to a fresh id when storage is unavailable (SSR, private
   * browsing, etc.).
   */
  private resolveStableClientId(): string {
    try {
      if (typeof window !== 'undefined' && 'localStorage' in window) {
        const existing = window.localStorage.getItem('phoenix.realtime.clientId');
        if (existing) return existing;
        const fresh = randomId();
        window.localStorage.setItem('phoenix.realtime.clientId', fresh);
        return fresh;
      }
    } catch {
      /* storage unavailable */
    }
    return randomId();
  }
}

let singleton: RealtimeClient | null = null;

export function getRealtimeClient(): RealtimeClient {
  if (typeof window === 'undefined') {
    // SSR path — return a no-op shim so component-level code can call
    // `.subscribe()` during render without crashing. The real client
    // takes over after hydration.
    return ssrNoopClient;
  }
  if (!singleton) singleton = new RealtimeClient();
  return singleton;
}

// A deliberately partial stand-in for server rendering, where there is no socket
// to hold: `as unknown as` states that without `any`, which would also make every
// read of this value unchecked.
const ssrNoopClient = {
  subscribe: () => ({ unsubscribe: () => undefined, updatePresence: () => undefined }),
  subscribeStatus: () => () => undefined,
  getStatus: () => ({ isConnected: false, lastError: null, failedConnectAttempts: 0 }),
  reconnect: () => undefined,
} as unknown as RealtimeClient;

// Test-only reset hook.
export function __resetRealtimeClientForTests(): void {
  singleton = null;
}
