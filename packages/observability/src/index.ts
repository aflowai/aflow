/**
 * @aflow/observability
 *
 * OpenTelemetry-based observability for the Aflow platform.
 *
 * ## Hot-Path Considerations
 *
 * This package is designed to minimize impact on the execution hot-path:
 *
 * | Operation                  | Overhead    | Notes                          |
 * |----------------------------|-------------|--------------------------------|
 * | Span creation              | ~1-5μs      | Synchronous, no I/O            |
 * | Context propagation        | ~100ns      | Header manipulation only       |
 * | Counter increment          | ~100ns      | Atomic, no I/O                 |
 * | Histogram record           | ~200ns      | Atomic, no I/O                 |
 * | Log write                  | ~1-5μs      | Async console output           |
 * | Span export                | 0 (async)   | Background batch export        |
 * | Metric export              | 0 (async)   | Periodic background export     |
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   initTracing,
 *   initMetrics,
 *   configureLogging,
 *   getTracer,
 *   withSpan,
 *   recordStepExecution,
 *   createLogger,
 * } from "@aflow/observability";
 *
 * // At startup
 * initTracing({ serviceName: "aflow-orchestrator" });
 * initMetrics({ serviceName: "aflow-orchestrator" });
 * configureLogging({ service: "aflow-orchestrator" });
 *
 * // During execution
 * const tracer = getTracer("orchestrator");
 * const logger = createLogger({ runId: "..." });
 *
 * await withSpan(tracer, "process-step", { runId, stepType }, async (span) => {
 *   recordStepExecution({ step_type: stepType });
 *   logger.info("Processing step", { stepId });
 *   // ... do work
 * });
 * ```
 */

// Tracing
export {
  initTracing,
  shutdownTracing,
  getTracer,
  startSpan,
  withSpan,
  withSpanSync,
  extractContext,
  injectContext,
  withExtractedContext,
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type TracingConfig,
  type AflowSpanAttributes,
  type Span,
  type SpanOptions,
  type Context,
  type Tracer,
} from './tracing.js';

// Metrics
export {
  initMetrics,
  shutdownMetrics,
  getMeter,
  recordStepExecution,
  recordStepError,
  recordRunStart,
  recordRunCompletion,
  recordDlqMessage,
  recordStepLatency,
  recordRunLatency,
  recordQueueLag,
  incrementInFlightSteps,
  decrementInFlightSteps,
  incrementInFlightRuns,
  decrementInFlightRuns,
  setShardOwnershipCount,
  recordProjectionLag,
  recordAdmissionReject,
  recordHitlGateLatency,
  recordActionCenterResolved,
  recordCoachRatificationApplyError,
  recordBackgroundTaskCycle,
  recordBackgroundTaskOldestDueAge,
  recordStreamRetention,
  setBackgroundTaskBacklog,
  recordBackgroundTaskDisabled,
  createBackgroundTaskObserver,
  type MetricsConfig,
  type AflowMetricLabels,
  type Counter,
  type Histogram,
  type Meter,
  type UpDownCounter,
} from './metrics.js';

// Logging
export {
  Logger,
  configureLogging,
  createLogger,
  createLoggerWithConfig,
  buildAflowContext,
  type LogLevel,
  type LogContext,
  type LogEntry,
  type LoggerConfig,
} from './logging.js';

// =============================================================================
// Unified Initialization
// =============================================================================

export interface ObservabilityConfig {
  serviceName: string;
  serviceVersion?: string | undefined;
  environment?: string | undefined;
  otlpEndpoint?: string | undefined;
  enableConsoleTracing?: boolean | undefined;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | undefined;
  prettyLogs?: boolean | undefined;
}

/**
 * Initialize all observability components at once.
 * Call once at application startup.
 *
 * HOT-PATH: NO - Called once at startup
 */
export async function initObservability(config: ObservabilityConfig): Promise<void> {
  const { initTracing: initT } = await import('./tracing.js');
  const { initMetrics: initM } = await import('./metrics.js');
  const { configureLogging: configL } = await import('./logging.js');

  initT({
    serviceName: config.serviceName,
    ...(config.serviceVersion != null && { serviceVersion: config.serviceVersion }),
    ...(config.environment != null && { environment: config.environment }),
    ...(config.otlpEndpoint != null && { otlpEndpoint: config.otlpEndpoint }),
    ...(config.enableConsoleTracing != null && {
      enableConsoleExporter: config.enableConsoleTracing,
    }),
  });

  initM({
    serviceName: config.serviceName,
    ...(config.serviceVersion != null && { serviceVersion: config.serviceVersion }),
    ...(config.environment != null && { environment: config.environment }),
    ...(config.otlpEndpoint != null && { otlpEndpoint: config.otlpEndpoint }),
  });

  configL({
    service: config.serviceName,
    ...(config.logLevel != null && { level: config.logLevel }),
    ...(config.prettyLogs != null && { prettyPrint: config.prettyLogs }),
  });

  console.log(`[observability] Initialized for service: ${config.serviceName}`);
}

/**
 * Shutdown all observability components gracefully.
 * Call during application shutdown.
 *
 * HOT-PATH: NO - Called once at shutdown
 */
export async function shutdownObservability(): Promise<void> {
  const { shutdownTracing: shutT } = await import('./tracing.js');
  const { shutdownMetrics: shutM } = await import('./metrics.js');

  await Promise.all([shutT(), shutM()]);
  console.log('[observability] Shutdown complete');
}
