/**
 * OpenTelemetry Metrics Configuration
 *
 * DESIGN PRINCIPLES:
 * - Uses PeriodicExportingMetricReader (async export)
 * - Counter/Histogram updates are atomic and non-blocking
 * - All metric recording is synchronous but extremely fast
 *
 * HOT-PATH IMPACT: MINIMAL
 * - Counter increment: ~100ns
 * - Histogram record: ~200ns
 * - Export is fully async via periodic reader
 */

import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type UpDownCounter,
} from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { BackgroundTaskCycleEvent, BackgroundTaskObserver } from '@aflow/lib';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// =============================================================================
// Types
// =============================================================================

export interface MetricsConfig {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** OTLP endpoint URL */
  otlpEndpoint?: string;
  /** Export interval in ms (default: 60000) */
  exportIntervalMillis?: number;
  /** Export timeout in ms (default: 30000) */
  exportTimeoutMillis?: number;
}

export interface AflowMetricLabels {
  tenant_id?: string;
  step_type?: string;
  operation_id?: string;
  status?: string;
  error_code?: string;
  [key: string]: string | undefined;
}

// =============================================================================
// Module State
// =============================================================================

let meterProvider: MeterProvider | null = null;
let isInitialized = false;

// Pre-created meters and instruments for common Aflow metrics
let aflowMeter: Meter | null = null;

// Counters
let stepExecutionsTotal: Counter | null = null;
let stepErrorsTotal: Counter | null = null;
let runStartsTotal: Counter | null = null;
let runCompletionsTotal: Counter | null = null;
let dlqMessagesTotal: Counter | null = null;

// Histograms
let stepLatencyHistogram: Histogram | null = null;
let runLatencyHistogram: Histogram | null = null;
let queueLagHistogram: Histogram | null = null;

// Gauges (UpDownCounter used as gauge)
let inFlightSteps: UpDownCounter | null = null;
let inFlightRuns: UpDownCounter | null = null;

let shardOwnershipCount: UpDownCounter | null = null;
let projectionLagHistogram: Histogram | null = null;
let admissionRejectsTotal: Counter | null = null;

let hitlGateLatencyHistogram: Histogram | null = null;
let actionCenterResolvedTotal: Counter | null = null;
let coachRatificationApplyErrorsTotal: Counter | null = null;

// Background-work control plane (all labelled by `background_task_id`)
let backgroundTaskCyclesTotal: Counter | null = null;
let backgroundTaskCandidatesTotal: Counter | null = null;
let backgroundTaskProcessedTotal: Counter | null = null;
let backgroundTaskFailuresTotal: Counter | null = null;
let backgroundTaskCycleDurationHistogram: Histogram | null = null;
let backgroundTaskOldestDueAgeHistogram: Histogram | null = null;
let backgroundTaskBacklogGauge: UpDownCounter | null = null;
let backgroundTaskDisabledGauge: UpDownCounter | null = null;
let streamRetentionTrimmedTotal: Counter | null = null;
let streamRetentionRetainedHistogram: Histogram | null = null;
let streamRetentionOldestAgeHistogram: Histogram | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize OpenTelemetry metrics.
 * Call once at application startup.
 *
 * HOT-PATH: NO - Called once at startup
 */
export function initMetrics(config: MetricsConfig): void {
  if (isInitialized) {
    console.warn('Metrics already initialized, skipping re-initialization');
    return;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
    'deployment.environment': config.environment ?? 'development',
  });

  const otlpEndpoint = config.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  const readers: PeriodicExportingMetricReader[] = [];

  if (otlpEndpoint) {
    const exporter = new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
    });

    // PeriodicExportingMetricReader exports async at intervals
    // OFF HOT-PATH: Metrics are collected and exported in background
    readers.push(
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: config.exportIntervalMillis ?? 60000,
        exportTimeoutMillis: config.exportTimeoutMillis ?? 30000,
      }),
    );
  }

  meterProvider = new MeterProvider({
    resource,
    readers,
  });

  metrics.setGlobalMeterProvider(meterProvider);

  // Initialize Aflow-specific instruments
  aflowMeter = metrics.getMeter('aflow', '1.0.0');
  initializeAflowInstruments();

  isInitialized = true;
  console.log(`[metrics] Initialized for service: ${config.serviceName}`);
}

function initializeAflowInstruments(): void {
  if (!aflowMeter) return;

  // Counters
  stepExecutionsTotal = aflowMeter.createCounter('aflow.step_executions_total', {
    description: 'Total number of step executions',
    unit: '1',
  });

  stepErrorsTotal = aflowMeter.createCounter('aflow.step_errors_total', {
    description: 'Total number of step execution errors',
    unit: '1',
  });

  runStartsTotal = aflowMeter.createCounter('aflow.run_starts_total', {
    description: 'Total number of flow run starts',
    unit: '1',
  });

  runCompletionsTotal = aflowMeter.createCounter('aflow.run_completions_total', {
    description: 'Total number of flow run completions',
    unit: '1',
  });

  dlqMessagesTotal = aflowMeter.createCounter('aflow.dlq_messages_total', {
    description: 'Total number of messages sent to DLQ',
    unit: '1',
  });

  // Histograms
  stepLatencyHistogram = aflowMeter.createHistogram('aflow.step_latency', {
    description: 'Step execution latency in milliseconds',
    unit: 'ms',
  });

  runLatencyHistogram = aflowMeter.createHistogram('aflow.run_latency', {
    description: 'Flow run total latency in milliseconds',
    unit: 'ms',
  });

  queueLagHistogram = aflowMeter.createHistogram('aflow.queue_lag', {
    description: 'Time spent waiting in queue before processing in milliseconds',
    unit: 'ms',
  });

  // Gauges (using UpDownCounter)
  inFlightSteps = aflowMeter.createUpDownCounter('aflow.in_flight_steps', {
    description: 'Number of currently executing steps',
    unit: '1',
  });

  inFlightRuns = aflowMeter.createUpDownCounter('aflow.in_flight_runs', {
    description: 'Number of currently active flow runs',
    unit: '1',
  });

  shardOwnershipCount = aflowMeter.createUpDownCounter('aflow.shard.ownership_count', {
    description: 'Number of shards owned by this orchestrator instance',
    unit: '1',
  });

  projectionLagHistogram = aflowMeter.createHistogram('aflow.projection.lag_ms', {
    description: 'Time taken for a projection cycle in milliseconds',
    unit: 'ms',
  });

  admissionRejectsTotal = aflowMeter.createCounter('aflow.admission.rejects_total', {
    description: 'Total number of run start requests rejected due to capacity',
    unit: '1',
  });

  hitlGateLatencyHistogram = aflowMeter.createHistogram('aflow.hitl.gate_latency_ms', {
    description:
      'Time from Action Center item creation (item.requestedAt) until the matching ' +
      'resolve is dispatched. Labels: tenant_id, origin_kind (step|proposal|gate|settings), ' +
      'item_kind (human_input|human_approval|ratification|platform_issue), ' +
      'gate_reason (when origin=gate), operation_id, resolution_kind (approve|reject|submit|ratify|dismiss).',
    unit: 'ms',
  });

  actionCenterResolvedTotal = aflowMeter.createCounter('aflow.action_center.resolved_total', {
    description:
      'Action Center items resolved. rate() approximates the backlog drain rate; ' +
      'until Plan 161 wires the open-items insert hook this is the primary AC traffic gauge. ' +
      'Labels: tenant_id, space_id, origin_kind, item_kind, resolution_kind.',
    unit: '1',
  });

  coachRatificationApplyErrorsTotal = aflowMeter.createCounter(
    'aflow.coach.ratification_apply_errors_total',
    {
      description:
        "Failures applying a Coach proposal's ops (`applyRatifiedOps`). Mirrors Plan 138 §5.6 " +
        '`lastRatificationError` at the fleet level. Labels: tenant_id, space_id, error_code.',
      unit: '1',
    },
  );

  backgroundTaskCyclesTotal = aflowMeter.createCounter('aflow.background_task.cycles_total', {
    description:
      'Background-task cycles by outcome (completed|failed|skipped_lease|skipped_overlap|' +
      'budget_exceeded). Labels: background_task_id, outcome.',
    unit: '1',
  });

  backgroundTaskCandidatesTotal = aflowMeter.createCounter(
    'aflow.background_task.candidates_total',
    {
      description:
        'Due candidates observed by a background task. Compared against cycles_total, this is ' +
        'the ratio that proves idle cost is proportional to work rather than cardinality. ' +
        'Labels: background_task_id.',
      unit: '1',
    },
  );

  backgroundTaskProcessedTotal = aflowMeter.createCounter('aflow.background_task.processed_total', {
    description: 'Candidates claimed and processed. Labels: background_task_id.',
    unit: '1',
  });

  backgroundTaskFailuresTotal = aflowMeter.createCounter('aflow.background_task.failures_total', {
    description:
      'Candidate handler failures and failed cycles. Alert on a sustained non-zero rate. ' +
      'Labels: background_task_id.',
    unit: '1',
  });

  backgroundTaskCycleDurationHistogram = aflowMeter.createHistogram(
    'aflow.background_task.cycle_duration_ms',
    {
      description: 'Wall-clock duration of one background-task cycle. Labels: background_task_id.',
      unit: 'ms',
    },
  );

  backgroundTaskOldestDueAgeHistogram = aflowMeter.createHistogram(
    'aflow.background_task.oldest_due_age_ms',
    {
      description:
        'Age of the oldest due candidate at claim time — the recovery-objective signal for ' +
        'every candidate index. Labels: background_task_id.',
      unit: 'ms',
    },
  );

  backgroundTaskBacklogGauge = aflowMeter.createUpDownCounter('aflow.background_task.backlog', {
    description: 'Candidates still due after a cycle finished. Labels: background_task_id.',
    unit: '1',
  });

  streamRetentionTrimmedTotal = aflowMeter.createCounter('aflow.stream_retention.trimmed_total', {
    description:
      'Transport-stream entries reclaimed after every consumer group finished with them. Labels: stream_family.',
    unit: '1',
  });

  streamRetentionRetainedHistogram = aflowMeter.createHistogram(
    'aflow.stream_retention.retained_entries',
    {
      description:
        'Transport-stream entries still held after a trim because some consumer group has not finished with them. Labels: stream_family.',
      unit: '1',
    },
  );

  streamRetentionOldestAgeHistogram = aflowMeter.createHistogram(
    'aflow.stream_retention.oldest_retained_age_ms',
    {
      description:
        'Age of the oldest transport-stream entry no consumer group has finished with. The abandoned-group signal: seconds while a lane is being worked, unbounded once it is not. Labels: stream_family.',
      unit: 'ms',
    },
  );

  backgroundTaskDisabledGauge = aflowMeter.createUpDownCounter('aflow.background_task.disabled', {
    description:
      'Set to 1 while a registered task is disabled or refused an override. Any non-zero value ' +
      'for a correctness task is a page. Labels: background_task_id, reason.',
    unit: '1',
  });

  for (const [taskId, reason] of pendingDisabledReports) {
    recordBackgroundTaskDisabled(taskId, reason);
  }
  pendingDisabledReports.clear();
}

/**
 * Shutdown metrics gracefully.
 *
 * HOT-PATH: NO - Called once at shutdown
 */
export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
    aflowMeter = null;
    isInitialized = false;
    console.log('[metrics] Shutdown complete');
  }
}

// =============================================================================
// Metric Recording Functions
// =============================================================================

/**
 * Record a step execution.
 *
 * HOT-PATH: MINIMAL (~100ns)
 * - Atomic counter increment, no I/O
 */
export function recordStepExecution(labels: AflowMetricLabels): void {
  stepExecutionsTotal?.add(1, labels);
}

/**
 * Record a step error.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function recordStepError(labels: AflowMetricLabels): void {
  stepErrorsTotal?.add(1, labels);
}

/**
 * Record a run start.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function recordRunStart(labels: AflowMetricLabels): void {
  runStartsTotal?.add(1, labels);
}

/**
 * Record a run completion.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function recordRunCompletion(labels: AflowMetricLabels): void {
  runCompletionsTotal?.add(1, labels);
}

/**
 * Record a DLQ message.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function recordDlqMessage(labels: AflowMetricLabels): void {
  dlqMessagesTotal?.add(1, labels);
}

/**
 * Record step execution latency.
 *
 * HOT-PATH: MINIMAL (~200ns)
 */
export function recordStepLatency(latencyMs: number, labels: AflowMetricLabels): void {
  stepLatencyHistogram?.record(latencyMs, labels);
}

/**
 * Record run total latency.
 *
 * HOT-PATH: MINIMAL (~200ns)
 */
export function recordRunLatency(latencyMs: number, labels: AflowMetricLabels): void {
  runLatencyHistogram?.record(latencyMs, labels);
}

/**
 * Record queue lag.
 *
 * HOT-PATH: MINIMAL (~200ns)
 */
export function recordQueueLag(lagMs: number, labels: AflowMetricLabels): void {
  queueLagHistogram?.record(lagMs, labels);
}

/**
 * Increment in-flight steps count.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function incrementInFlightSteps(labels: AflowMetricLabels): void {
  inFlightSteps?.add(1, labels);
}

/**
 * Decrement in-flight steps count.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function decrementInFlightSteps(labels: AflowMetricLabels): void {
  inFlightSteps?.add(-1, labels);
}

/**
 * Increment in-flight runs count.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function incrementInFlightRuns(labels: AflowMetricLabels): void {
  inFlightRuns?.add(1, labels);
}

/**
 * Decrement in-flight runs count.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function decrementInFlightRuns(labels: AflowMetricLabels): void {
  inFlightRuns?.add(-1, labels);
}

/**
 * Set shard ownership count.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function setShardOwnershipCount(delta: number, labels: AflowMetricLabels): void {
  shardOwnershipCount?.add(delta, labels);
}

/**
 * Record projection cycle latency.
 *
 * HOT-PATH: MINIMAL (~200ns)
 */
export function recordProjectionLag(lagMs: number, labels: AflowMetricLabels): void {
  projectionLagHistogram?.record(lagMs, labels);
}

/**
 * Record an admission rejection.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
// =============================================================================

/**
 * Record AC item time-to-resolve — ms from `item.requestedAt` to the
 * resolve dispatch. Emitted on every successful resolve via the AC
 * aggregator. Labels: `origin_kind`, `item_kind`, `gate_reason` (when
 * origin=gate), `operation_id`, `resolution_kind`. Dashboards slice
 * by `gate_reason` to spot patterns (a binding that's always slow
 * vs an op-policy gate that's fast).
 */
export function recordHitlGateLatency(latencyMs: number, labels: AflowMetricLabels): void {
  hitlGateLatencyHistogram?.record(latencyMs, labels);
}

export function recordActionCenterResolved(labels: AflowMetricLabels): void {
  actionCenterResolvedTotal?.add(1, labels);
}

export function recordCoachRatificationApplyError(labels: AflowMetricLabels): void {
  coachRatificationApplyErrorsTotal?.add(1, labels);
}

export function recordAdmissionReject(labels: AflowMetricLabels): void {
  admissionRejectsTotal?.add(1, labels);
}

// =============================================================================
// Background-work control plane
// =============================================================================

/**
 * HOT-PATH: MINIMAL — a handful of counter adds per background cycle.
 */
export function recordBackgroundTaskCycle(event: BackgroundTaskCycleEvent): void {
  const labels: AflowMetricLabels = { background_task_id: event.taskId };
  backgroundTaskCyclesTotal?.add(1, { ...labels, outcome: event.outcome });
  backgroundTaskCycleDurationHistogram?.record(event.durationMs, labels);
  if (event.candidates > 0) backgroundTaskCandidatesTotal?.add(event.candidates, labels);
  if (event.processed > 0) backgroundTaskProcessedTotal?.add(event.processed, labels);
  const failures = event.failed + (event.outcome === 'failed' ? 1 : 0);
  if (failures > 0) backgroundTaskFailuresTotal?.add(failures, labels);
}

/** Age of the oldest due candidate a cycle observed — the recovery-objective signal. */
export function recordBackgroundTaskOldestDueAge(taskId: string, ageMs: number): void {
  backgroundTaskOldestDueAgeHistogram?.record(ageMs, { background_task_id: taskId });
}

/**
 * OpenTelemetry has no settable synchronous gauge, so absolute values are
 * converted to a delta against the last reported one. Callers pass the backlog
 * they observed; adding it directly would make a steady backlog of 40 read as
 * 4,000 after a hundred cycles and every alert threshold meaningless.
 */
const lastBacklogByTask = new Map<string, number>();

export function setBackgroundTaskBacklog(taskId: string, backlog: number): void {
  const previous = lastBacklogByTask.get(taskId) ?? 0;
  if (backlog === previous) return;
  lastBacklogByTask.set(taskId, backlog);
  backgroundTaskBacklogGauge?.add(backlog - previous, { background_task_id: taskId });
}

/**
 * Retention reports one stream at a time, but a per-key label would put 128
 * shards each of results and control into the label set, so observations are
 * recorded against the stream's family instead.
 *
 * Histograms rather than gauges: any orchestrator can claim any stream, so a
 * gauge maintained as a delta against a process-local previous value would
 * double-count once a stream moved between instances, and an observable gauge
 * would keep reporting whichever value its process last saw after another
 * instance took the stream over. Each observation here stands alone.
 *
 * The exporter is left at OTLP's default cumulative temporality, so `max` on
 * these accumulates for the life of the process and never falls — read them as
 * `rate(sum)/rate(count)` for a recent mean, or by quantile. Which is why the
 * abandoned-group signal is the *age* of the oldest retained entry rather than
 * the count: a count needs a baseline to interpret, while an age is meaningful
 * on its own and climbs without bound exactly when a group stops draining.
 * Identifying the specific stream is a log concern, not a label — the task
 * names it, so the metric does not have to carry per-shard cardinality.
 */
function streamFamily(streamKey: string): string {
  if (streamKey.startsWith('aflow:jobs:')) return streamKey.slice('aflow:'.length);
  const shardSuffix = /^aflow:shard:\d+:(.+)$/.exec(streamKey);
  if (shardSuffix?.[1] !== undefined) return `shard:${shardSuffix[1]}`;
  return 'other';
}

/**
 * A retained count that stops falling to zero is the signal that a consumer
 * group has stopped draining — the one case retention deliberately will not
 * resolve on its own, because those entries are undelivered work.
 */
export function recordStreamRetention(result: {
  streamKey: string;
  trimmed: number;
  retained: number;
  oldestRetainedAgeMs: number | null;
}): void {
  const labels: AflowMetricLabels = { stream_family: streamFamily(result.streamKey) };
  if (result.trimmed > 0) streamRetentionTrimmedTotal?.add(result.trimmed, labels);
  streamRetentionRetainedHistogram?.record(result.retained, labels);
  if (result.oldestRetainedAgeMs !== null) {
    streamRetentionOldestAgeHistogram?.record(result.oldestRetainedAgeMs, labels);
  }
}

const disabledTasks = new Set<string>();
const pendingDisabledReports = new Map<string, string>();

/**
 * Emitted at startup for any task that is disabled or whose override was
 * refused. A correctness task reporting non-zero here has lost its only owner.
 * Idempotent per task, so a second wiring site cannot inflate the count.
 */
export function recordBackgroundTaskDisabled(taskId: string, reason: string): void {
  if (disabledTasks.has(taskId)) return;
  // No gauge yet means metrics have not initialised in this process. The
  // control plane reports each condition exactly once per process, so this
  // call is the report's only chance — queued for initMetrics to flush rather
  // than dropped, because a disabled correctness task that never reaches the
  // gauge is the invisibility this signal exists to prevent.
  if (!backgroundTaskDisabledGauge) {
    pendingDisabledReports.set(taskId, reason);
    return;
  }
  disabledTasks.add(taskId);
  backgroundTaskDisabledGauge.add(1, { background_task_id: taskId, reason });
}

export function createBackgroundTaskObserver(): BackgroundTaskObserver {
  return { onCycle: recordBackgroundTaskCycle };
}

// =============================================================================
// Custom Meter Access
// =============================================================================

/**
 * Get a meter instance for custom metrics.
 *
 * HOT-PATH: MINIMAL (~1μs)
 */
export function getMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}

// =============================================================================
// Re-exports
// =============================================================================

export { type Counter, type Histogram, type Meter, type UpDownCounter } from '@opentelemetry/api';
