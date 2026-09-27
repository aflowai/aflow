import { metrics } from '@opentelemetry/api';
import type { Counter, UpDownCounter, Meter } from '@opentelemetry/api';

let meter: Meter | null = null;

let connectionsTotal: Counter | null = null;
let connectionsInFlight: UpDownCounter | null = null;
let subscriptionsTotal: Counter | null = null;
let eventsEmittedTotal: Counter | null = null;
let bytesSentTotal: Counter | null = null;
let messagesReceivedTotal: Counter | null = null;
let reconcileTotal: Counter | null = null;

function ensureMeter(): void {
  if (meter) return;
  meter = metrics.getMeter('aflow.realtime', '1.0.0');
  connectionsTotal = meter.createCounter('aflow.realtime.connections_total', {
    description: 'Realtime WebSocket connection lifecycle counts',
    unit: '1',
  });
  connectionsInFlight = meter.createUpDownCounter('aflow.realtime.connections_in_flight', {
    description: 'Currently-open realtime connections',
    unit: '1',
  });
  subscriptionsTotal = meter.createCounter('aflow.realtime.subscriptions_total', {
    description: 'Realtime subscribe outcomes by topic',
    unit: '1',
  });
  eventsEmittedTotal = meter.createCounter('aflow.realtime.events_emitted_total', {
    description: 'Server→client realtime messages by topic + kind',
    unit: '1',
  });
  bytesSentTotal = meter.createCounter('aflow.realtime.bytes_sent_total', {
    description: 'Bytes sent on realtime connections by topic',
    unit: 'By',
  });
  messagesReceivedTotal = meter.createCounter('aflow.realtime.messages_received_total', {
    description: 'Client→server realtime messages by type',
    unit: '1',
  });
  reconcileTotal = meter.createCounter('aflow.realtime.reconcile_total', {
    description: 'reconcile_required emissions by topic + reason',
    unit: '1',
  });
}

// ============================================================================
// Public API
// ============================================================================

export type ConnectionResult =
  | 'accepted'
  | 'rejected_origin'
  | 'rejected_token'
  | 'rejected_protocol'
  | 'rejected_budget'
  | 'closed_normal'
  | 'closed_error';

export function recordConnectionResult(result: ConnectionResult, tenantId?: string): void {
  ensureMeter();
  connectionsTotal?.add(1, {
    result,
    ...(tenantId ? { tenant_id: tenantId } : {}),
  });
}

export function recordConnectionOpened(tenantId: string, userId: string): void {
  ensureMeter();
  connectionsInFlight?.add(1, { tenant_id: tenantId, user_id: userId });
}

export function recordConnectionClosed(tenantId: string, userId: string): void {
  ensureMeter();
  connectionsInFlight?.add(-1, { tenant_id: tenantId, user_id: userId });
}

export type SubscribeResult = 'accepted' | 'denied' | 'not_supported' | 'budget_exceeded';

export function recordSubscribe(
  topicKind: string,
  result: SubscribeResult,
  tenantId?: string,
): void {
  ensureMeter();
  subscriptionsTotal?.add(1, {
    topic_kind: topicKind,
    result,
    ...(tenantId ? { tenant_id: tenantId } : {}),
  });
}

export type EmittedKind = 'event' | 'live_delta' | 'snapshot' | 'reconcile_required';

export function recordEventEmitted(topicKind: string, eventKind: EmittedKind): void {
  ensureMeter();
  eventsEmittedTotal?.add(1, { topic_kind: topicKind, event_kind: eventKind });
}

export function recordBytesSent(topicKind: string, bytes: number): void {
  ensureMeter();
  bytesSentTotal?.add(bytes, { topic_kind: topicKind });
}

export function recordMessageReceived(type: string): void {
  ensureMeter();
  messagesReceivedTotal?.add(1, { type });
}

export function recordReconcile(topicKind: string, reason: string): void {
  ensureMeter();
  reconcileTotal?.add(1, { topic_kind: topicKind, reason });
}
