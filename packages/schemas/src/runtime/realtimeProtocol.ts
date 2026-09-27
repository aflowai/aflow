import { z } from 'zod';
import { PresenceActivitySchema } from './presence.js';
import { SpaceCoachSurfaceTopicSchema } from './coachSurfaceTopic.js';
import { LiveDeltaChannelSchema } from './streamMessages.js';

// ============================================================================
// Protocol version
// ============================================================================

/**
 * Wire-level protocol version. Bumped only for **incompatible** changes:
 * additive `topic.kind` variants, optional fields, and additional server
 * message kinds use the same version.
 */
export const RealtimeProtocolVersion = 1 as const;
export const RealtimeProtocolVersionSchema = z.literal(RealtimeProtocolVersion);

// ============================================================================
// Topic subscription union (client → server)
// ============================================================================

export const SessionEventsTopicSchema = z.object({
  kind: z.literal('session.events'),
  /**
   * Hint, not authority. The gateway compares this to the connection
   * token's `tenantId` and rejects mismatches. Kept explicit so the
   * client never accidentally subscribes to a session it doesn't own.
   */
  tenantId: z.string(),
  sessionId: z.string(),
  /**
   * Opaque cursor returned by a previous `event` or `snapshot` message.
   * When present, the gateway resumes from the cursor (Redis-then-Postgres
   * per §6.2). When absent, the gateway either snapshots first or starts
   * at the live tail, depending on `skipCatchup`.
   */
  cursor: z.string().optional(),
  skipCatchup: z.boolean().optional(),
});
export type SessionEventsTopic = z.infer<typeof SessionEventsTopicSchema>;

export const SpaceActionCenterTopicSchema = z.object({
  kind: z.literal('space.action_center'),
  spaceId: z.string().uuid(),
});
export type SpaceActionCenterTopic = z.infer<typeof SpaceActionCenterTopicSchema>;

/**
 * Entity event filters — opaque to the gateway transport layer but
 * load-bearing for the cybernetic source. Carried verbatim on the
 * subscribe message; the source decides which entity classes match.
 */
export const EntityEventFiltersSchema = z
  .object({
    /** Subscribe only to these `entityKind` values (e.g. `proposal`, `agent`). */
    kinds: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();
export type EntityEventFilters = z.infer<typeof EntityEventFiltersSchema>;

export const SpaceEntityEventsTopicSchema = z.object({
  kind: z.literal('space.entity_events'),
  spaceId: z.string().uuid(),
  cursor: z.string().optional(),
  filters: EntityEventFiltersSchema.optional(),
});
export type SpaceEntityEventsTopic = z.infer<typeof SpaceEntityEventsTopicSchema>;

export const ActivityTopicSchema = z.object({
  kind: z.literal('activity'),
  /** Best-effort presence signals — bounded to keep the per-conn watch
   *  set manageable. 64 is plenty for a chat tab; budget enforced. */
  sessionIds: z.array(z.string()).max(64).optional(),
  runIds: z.array(z.string()).max(64).optional(),
});
export type ActivityTopic = z.infer<typeof ActivityTopicSchema>;

export const SessionPresenceTopicSchema = z.object({
  kind: z.literal('session.presence'),
  sessionId: z.string().uuid(),
});
export type SessionPresenceTopic = z.infer<typeof SessionPresenceTopicSchema>;

/**
 * Live deltas for one applet instance. Deliberately not the session event
 * stream — an instance may have no session at all. A version gap on the
 * client triggers a refetch; the gateway never replays.
 */
export const AppletInstanceTopicSchema = z.object({
  kind: z.literal('applet.instance'),
  instanceId: z.string().uuid(),
});
export type AppletInstanceTopic = z.infer<typeof AppletInstanceTopicSchema>;

export const RealtimeTopicSubscribeSchema = z.discriminatedUnion('kind', [
  SessionEventsTopicSchema,
  SessionPresenceTopicSchema,
  SpaceActionCenterTopicSchema,
  SpaceEntityEventsTopicSchema,
  SpaceCoachSurfaceTopicSchema,
  ActivityTopicSchema,
  AppletInstanceTopicSchema,
]);
export type RealtimeTopicSubscribe = z.infer<typeof RealtimeTopicSubscribeSchema>;

/**
 * Topic kind discriminator — string union extracted from the topic
 * schema. Used for per-topic metrics buckets, log fields, and the
 * topic-not-supported error path.
 */
export const RealtimeTopicKindSchema = z.enum([
  'session.events',
  'session.presence',
  'space.action_center',
  'space.entity_events',
  'space.coach_surface',
  'activity',
  'applet.instance',
]);
export type RealtimeTopicKind = z.infer<typeof RealtimeTopicKindSchema>;

// ============================================================================
// Client → Server messages
// ============================================================================

/**
 * First message after the WS upgrade. Carries the client-allocated
 * identifiers used for connection-level metrics (`clientId`) and
 * cross-tab leadership (`tabId`). The server replies with `ready`.
 */
export const ClientHelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: RealtimeProtocolVersionSchema,
  /**
   * Stable per-browser identifier. The web app generates this once and
   * persists it (e.g. localStorage) so connection metrics can correlate
   * reconnects across page reloads.
   */
  clientId: z.string().min(1).max(128),
  /** Per-tab identifier — distinct from `clientId` so the server can see
   *  fan-out across tabs of the same browser. */
  tabId: z.string().min(1).max(128),
});
export type ClientHelloMessage = z.infer<typeof ClientHelloMessageSchema>;

/**
 * Subscribe to a topic. `requestId` echoes back on the `subscribed`
 * reply (or the `error` reply on failure) so the client can correlate
 * with its in-flight subscribe.
 */
export const ClientSubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  requestId: z.string().min(1).max(64),
  topic: RealtimeTopicSubscribeSchema,
});
export type ClientSubscribeMessage = z.infer<typeof ClientSubscribeMessageSchema>;

export const ClientUnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  requestId: z.string().min(1).max(64),
  subscriptionId: z.string().min(1).max(64),
});
export type ClientUnsubscribeMessage = z.infer<typeof ClientUnsubscribeMessageSchema>;

export const ClientPingMessageSchema = z.object({
  type: z.literal('ping'),
  requestId: z.string().min(1).max(64),
  sentAt: z.string().datetime(),
});
export type ClientPingMessage = z.infer<typeof ClientPingMessageSchema>;

/**
 * "I am here, and this is what I am doing."
 *
 * The only client-to-server message that is not connection control. Presence
 * is the one thing the server cannot infer: a socket says a tab is open, not
 * that a person is looking at this room or typing in it.
 */
export const ClientPresenceUpdateMessageSchema = z.object({
  type: z.literal('presence_update'),
  subscriptionId: z.string().min(1).max(64),
  activity: PresenceActivitySchema,
});
export type ClientPresenceUpdateMessage = z.infer<typeof ClientPresenceUpdateMessageSchema>;

export const ClientRealtimeMessageSchema = z.discriminatedUnion('type', [
  ClientHelloMessageSchema,
  ClientPresenceUpdateMessageSchema,
  ClientSubscribeMessageSchema,
  ClientUnsubscribeMessageSchema,
  ClientPingMessageSchema,
]);
export type ClientRealtimeMessage = z.infer<typeof ClientRealtimeMessageSchema>;

// ============================================================================
// Reconcile reasons (server → client)
// ============================================================================

export const ReconcileReasonSchema = z.enum([
  /** Cursor wasn't found anywhere — neither hot Redis nor durable Postgres. */
  'cursor_not_found',
  /** Cursor existed once but was evicted past `MAXLEN` and durable backstop
   *  is unavailable (e.g. event_log row not yet flushed). */
  'cursor_evicted',
  /** Upstream source was compacted; replay would skip events. */
  'source_compacted',
  /** Cursor could not be decoded — malformed, over-long, or from a cursor
   *  format this server no longer speaks. The client re-snapshots once. */
  'cursor_malformed',
  /** Per-subscription authorization changed mid-stream — drop the
   *  subscription rather than risk leaking past-permission data. */
  'authorization_changed',
  /** Server restarted; in-memory delivery position lost. Clients
   *  re-snapshot from the REST surface. */
  'server_restart',
  'snapshot_failed',
]);
export type ReconcileReason = z.infer<typeof ReconcileReasonSchema>;

// ============================================================================
// Server → Client messages
// ============================================================================

/**
 * First message after `hello`. Confirms protocol negotiation. The server
 * sends this exactly once per connection lifetime.
 */
export const ServerReadyMessageSchema = z.object({
  type: z.literal('ready'),
  protocolVersion: RealtimeProtocolVersionSchema,
  serverTime: z.string().datetime(),
});
export type ServerReadyMessage = z.infer<typeof ServerReadyMessageSchema>;

export const ServerSubscribedMessageSchema = z.object({
  type: z.literal('subscribed'),
  requestId: z.string(),
  subscriptionId: z.string(),
  /** Deterministic key like `session.events:<sessionId>`. Useful in logs
   *  + lets the client de-duplicate subscriptions per logical topic. */
  topicKey: z.string(),
  /** Resume cursor the gateway will tail from. Absent for topics that
   *  don't carry cursors (e.g. `activity`). */
  cursor: z.string().optional(),
});
export type ServerSubscribedMessage = z.infer<typeof ServerSubscribedMessageSchema>;

/**
 * Authoritative event with cursor. The cursor is the position **after**
 * applying this event (§6.1 rule 2). Clients store it and resubscribe
 * from it on reconnect.
 *
 * `event` carries an opaque shape — the topic decides what's inside it.
 * The gateway validates the outer envelope only; the inner shape is
 * validated by the per-topic source.
 */
export const ServerEventMessageSchema = z.object({
  type: z.literal('event'),
  subscriptionId: z.string(),
  topicKey: z.string(),
  cursor: z.string(),
  event: z.unknown(),
});
export type ServerEventMessage = z.infer<typeof ServerEventMessageSchema>;

/**
 * Initial state for topics that send one (Action Center, entity events).
 * `cursor` is the position to resume tail delivery from once the client
 * has applied the snapshot.
 */
export const ServerSnapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  subscriptionId: z.string(),
  topicKey: z.string(),
  cursor: z.string(),
  data: z.unknown(),
});
export type ServerSnapshotMessage = z.infer<typeof ServerSnapshotMessageSchema>;

/**
 * A frame of the in-flight step's partial output — what is on screen right
 * now, not a record of what happened.
 *
 * It carries **no `cursor`**, and that omission is the contract: the client's
 * resume position must always name an event that exists durably, and a live
 * frame names nothing that outlives its step. Leaving the field off makes
 * advancing the resume position with one structurally impossible instead of a
 * rule every call site has to remember.
 *
 * `delta` is the bytes appended since the server last sent this subscription a
 * frame for the same `(stepExecutionId, channel)` — an increment to append,
 * not the whole value. A subscription's first frame for a step starts at the
 * beginning of the buffer, so a late joiner receives the accumulated partial.
 *
 * `offset` says where those bytes begin in the step's output, which is what
 * makes the frame self-describing rather than order-dependent: a reconnect
 * mid-step is a fresh subscription reading from 0 again, and a reader that
 * blindly appended would show the partial twice. `offset === 0` means "this is
 * the whole value so far"; anything else is an increment. It is a position
 * inside one step's buffer and means nothing once that step ends.
 */
export const ServerLiveDeltaMessageSchema = z.object({
  type: z.literal('live_delta'),
  subscriptionId: z.string(),
  topicKey: z.string(),
  stepExecutionId: z.string(),
  channel: LiveDeltaChannelSchema,
  offset: z.number().int().nonnegative(),
  delta: z.string(),
});
export type ServerLiveDeltaMessage = z.infer<typeof ServerLiveDeltaMessageSchema>;

/**
 * A live frame minus its subscription envelope — the unit the server's tail
 * produces and the client's broker fans out. Derived from the wire message so
 * the two can never drift: widen the wire shape and both ends widen with it.
 * Carries no cursor, by the same contract as `ServerLiveDeltaMessageSchema`.
 */
export const LiveDeltaFrameSchema = ServerLiveDeltaMessageSchema.pick({
  stepExecutionId: true,
  channel: true,
  offset: true,
  delta: true,
});
export type LiveDeltaFrame = z.infer<typeof LiveDeltaFrameSchema>;

export const ServerReconcileRequiredMessageSchema = z.object({
  type: z.literal('reconcile_required'),
  subscriptionId: z.string(),
  topicKey: z.string(),
  reason: ReconcileReasonSchema,
  /** Last known good cursor before the gap, when the server knows one. */
  cursor: z.string().optional(),
});
export type ServerReconcileRequiredMessage = z.infer<typeof ServerReconcileRequiredMessageSchema>;

export const ServerErrorMessageSchema = z.object({
  type: z.literal('error'),
  /** Echoes the failed request id when the error is in response to a
   *  client message (subscribe/unsubscribe). Absent for connection-level
   *  errors. */
  requestId: z.string().optional(),
  /**
   * Stable error code clients can branch on. Examples:
   * `protocol_version_mismatch`, `subscribe_denied`,
   * `subscription_not_found`, `topic_not_supported`,
   * `connection_budget_exceeded`, `subscription_budget_exceeded`,
   * `invalid_message`.
   */
  code: z.string().min(1).max(64),
  retryable: z.boolean(),
  message: z.string().max(500),
});
export type ServerErrorMessage = z.infer<typeof ServerErrorMessageSchema>;

export const ServerPongMessageSchema = z.object({
  type: z.literal('pong'),
  requestId: z.string(),
  serverTime: z.string().datetime(),
});
export type ServerPongMessage = z.infer<typeof ServerPongMessageSchema>;

export const ServerRealtimeMessageSchema = z.discriminatedUnion('type', [
  ServerReadyMessageSchema,
  ServerSubscribedMessageSchema,
  ServerEventMessageSchema,
  ServerLiveDeltaMessageSchema,
  ServerSnapshotMessageSchema,
  ServerReconcileRequiredMessageSchema,
  ServerErrorMessageSchema,
  ServerPongMessageSchema,
]);
export type ServerRealtimeMessage = z.infer<typeof ServerRealtimeMessageSchema>;

// ============================================================================
// Token mint request / response (REST, not WS)
// ============================================================================

export const RealtimeTokenResponseSchema = z.object({
  /** Short-lived JWT — used in `Sec-WebSocket-Protocol` as `phoenix.token.<jwt>`. */
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  /**
   * Absolute WebSocket URL the browser should connect to. Returned by
   * the server rather than hard-coded on the client so the gateway can
   * route to `realtime.aflow.ai` if Cloudflare's WAF needs sidestepping
   * (§5.1 fallback).
   */
  realtimeUrl: z.string().url(),
});
export type RealtimeTokenResponse = z.infer<typeof RealtimeTokenResponseSchema>;

export const RealtimeTokenClaimsSchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  /** Web origin allowlist — the gateway double-checks the upgrade's `Origin`. */
  allowedOrigins: z.array(z.string().min(1)).min(1),
  allowedSpaceIds: z.array(z.string().uuid()).optional(),
  allowedSessionIds: z.array(z.string()).optional(),
  /** Standard JWT expiry — seconds since epoch. */
  exp: z.number().int().positive(),
  /** One-shot use marker — consumed on connect, replay rejected. */
  jti: z.string().min(1),
  authMethod: z.string().min(1).max(64).optional(),
});
export type RealtimeTokenClaims = z.infer<typeof RealtimeTokenClaimsSchema>;

// ============================================================================
// Topic key helpers
// ============================================================================

/**
 * Deterministic key for a topic subscription. Used for log lines, the
 * client-side dedupe of duplicate subscribes, and the metric labels.
 * Stable across reconnects: the same logical subscription gets the same
 * key.
 */
export function realtimeTopicKey(topic: RealtimeTopicSubscribe): string {
  switch (topic.kind) {
    case 'session.events':
      return `session.events:${topic.sessionId}`;
    case 'session.presence':
      return `session.presence:${topic.sessionId}`;
    case 'space.action_center':
      return `space.action_center:${topic.spaceId}`;
    case 'space.coach_surface':
      return `space.coach_surface:${topic.spaceId}`;
    case 'space.entity_events': {
      const filterKey = topic.filters?.kinds?.length
        ? `:${[...topic.filters.kinds].sort().join(',')}`
        : '';
      return `space.entity_events:${topic.spaceId}${filterKey}`;
    }
    case 'activity':
      return 'activity';
    case 'applet.instance':
      return `applet.instance:${topic.instanceId}`;
  }
}
