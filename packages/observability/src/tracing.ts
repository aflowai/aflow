/**
 * OpenTelemetry Tracing Configuration
 *
 * DESIGN PRINCIPLES:
 * - Uses BatchSpanProcessor with async export (OFF hot-path)
 * - Trace context propagation is minimal overhead (nanoseconds)
 * - All span creation is non-blocking
 *
 * HOT-PATH IMPACT: MINIMAL
 * - Span creation: ~1-5μs
 * - Context propagation: ~100ns
 * - Export is fully async via BatchSpanProcessor
 */

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  propagation,
  type Span,
  type SpanOptions,
  type Context,
  type Tracer,
} from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { B3Propagator, B3InjectEncoding } from '@opentelemetry/propagator-b3';
import { isSentryActive } from './sentryActive.js';

// =============================================================================
// Types
// =============================================================================

export interface TracingConfig {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** OTLP endpoint URL. If not set, uses OTEL_EXPORTER_OTLP_ENDPOINT env var */
  otlpEndpoint?: string;
  /** Enable console exporter for debugging */
  enableConsoleExporter?: boolean;
  /** Batch export settings */
  batchConfig?: {
    /** Max queue size before dropping spans (default: 2048) */
    maxQueueSize?: number;
    /** Max batch size per export (default: 512) */
    maxExportBatchSize?: number;
    /** Export interval in ms (default: 5000) */
    scheduledDelayMillis?: number;
    /** Export timeout in ms (default: 30000) */
    exportTimeoutMillis?: number;
  };
}

export interface AflowSpanAttributes {
  tenantId?: string;
  runId?: string;
  stepExecutionId?: string;
  stepType?: string;
  operationId?: string;
  attempt?: number;
  flowId?: string;
  flowVersion?: string;
}

// =============================================================================
// Module State
// =============================================================================

let provider: NodeTracerProvider | null = null;
let isInitialized = false;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize OpenTelemetry tracing.
 * Call once at application startup.
 *
 * HOT-PATH: NO - Called once at startup
 */
export function initTracing(config: TracingConfig): void {
  if (isInitialized) {
    console.warn('Tracing already initialized, skipping re-initialization');
    return;
  }

  const otlpEndpoint = config.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const wantsExport = Boolean(otlpEndpoint) || config.enableConsoleExporter === true;

  // Sentry's Node SDK owns OpenTelemetry — its own global TracerProvider and
  // propagator. Registering a second global provider here would be silently
  // ignored, and our B3 propagator would clobber Sentry's trace propagation.
  // Independently, with no exporter configured a provider with no span processors
  // just creates and drops spans. In either case, don't register.
  if (isSentryActive() || !wantsExport) {
    const reason = isSentryActive() ? 'Sentry owns OpenTelemetry' : 'no exporter configured';
    console.log(`[tracing] Skipping OpenTelemetry provider for ${config.serviceName} (${reason})`);
    return;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? '0.0.0',
    'deployment.environment': config.environment ?? 'development',
  });

  provider = new NodeTracerProvider({ resource });

  // Configure propagator for distributed tracing
  propagation.setGlobalPropagator(
    new B3Propagator({ injectEncoding: B3InjectEncoding.MULTI_HEADER }),
  );

  // OTLP exporter with BatchSpanProcessor (async, non-blocking)
  if (otlpEndpoint) {
    const otlpExporter = new OTLPTraceExporter({
      url: `${otlpEndpoint}/v1/traces`,
    });

    // BatchSpanProcessor exports spans asynchronously
    // OFF HOT-PATH: Spans are queued and exported in background
    const batchProcessor = new BatchSpanProcessor(otlpExporter, {
      maxQueueSize: config.batchConfig?.maxQueueSize ?? 2048,
      maxExportBatchSize: config.batchConfig?.maxExportBatchSize ?? 512,
      scheduledDelayMillis: config.batchConfig?.scheduledDelayMillis ?? 5000,
      exportTimeoutMillis: config.batchConfig?.exportTimeoutMillis ?? 30000,
    });

    provider.addSpanProcessor(batchProcessor);
  }

  // Console exporter for local debugging
  if (config.enableConsoleExporter) {
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  provider.register();
  isInitialized = true;

  console.log(`[tracing] Initialized for service: ${config.serviceName}`);
}

/**
 * Shutdown tracing gracefully.
 * Call during application shutdown.
 *
 * HOT-PATH: NO - Called once at shutdown
 */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    isInitialized = false;
    console.log('[tracing] Shutdown complete');
  }
}

// =============================================================================
// Tracer Access
// =============================================================================

/**
 * Get a tracer instance for a specific module.
 *
 * HOT-PATH: MINIMAL (~1μs)
 */
export function getTracer(name: string, version?: string): Tracer {
  return trace.getTracer(name, version);
}

// =============================================================================
// Span Helpers
// =============================================================================

/**
 * Start a new span with Aflow-specific attributes.
 *
 * HOT-PATH: MINIMAL (~1-5μs)
 * - Span creation is synchronous but very fast
 * - No I/O occurs during span creation
 */
export function startSpan(
  tracer: Tracer,
  name: string,
  attributes: AflowSpanAttributes,
  options?: SpanOptions,
): Span {
  const span = tracer.startSpan(name, {
    kind: options?.kind ?? SpanKind.INTERNAL,
    ...options,
  });

  // Set Aflow-specific attributes
  if (attributes.tenantId) span.setAttribute('aflow.tenant_id', attributes.tenantId);
  if (attributes.runId) span.setAttribute('aflow.run_id', attributes.runId);
  if (attributes.stepExecutionId)
    span.setAttribute('aflow.step_execution_id', attributes.stepExecutionId);
  if (attributes.stepType) span.setAttribute('aflow.step_type', attributes.stepType);
  if (attributes.operationId) span.setAttribute('aflow.operation_id', attributes.operationId);
  if (attributes.attempt !== undefined) span.setAttribute('aflow.attempt', attributes.attempt);
  if (attributes.flowId) span.setAttribute('aflow.flow_id', attributes.flowId);
  if (attributes.flowVersion) span.setAttribute('aflow.flow_version', attributes.flowVersion);

  return span;
}

/**
 * Run a function within a span context.
 * Automatically ends span and records errors.
 *
 * HOT-PATH: MINIMAL (wrapper adds ~1-5μs)
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: AflowSpanAttributes,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const span = startSpan(tracer, name, attributes, options);
  const ctx = trace.setSpan(context.active(), span);

  try {
    const result = await context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Synchronous version of withSpan.
 *
 * HOT-PATH: MINIMAL (wrapper adds ~1-5μs)
 */
export function withSpanSync<T>(
  tracer: Tracer,
  name: string,
  attributes: AflowSpanAttributes,
  fn: (span: Span) => T,
  options?: SpanOptions,
): T {
  const span = startSpan(tracer, name, attributes, options);
  const ctx = trace.setSpan(context.active(), span);

  try {
    const result = context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}

// =============================================================================
// Context Propagation
// =============================================================================

/**
 * Extract trace context from carrier (e.g., HTTP headers, Redis message).
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function extractContext(carrier: Record<string, string>): Context {
  return propagation.extract(context.active(), carrier);
}

/**
 * Inject trace context into carrier for propagation.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function injectContext(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

/**
 * Run a function with extracted context as the active context.
 *
 * HOT-PATH: MINIMAL
 */
export function withExtractedContext<T>(carrier: Record<string, string>, fn: () => T): T {
  const ctx = extractContext(carrier);
  return context.with(ctx, fn);
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type Span,
  type SpanOptions,
  type Context,
  type Tracer,
} from '@opentelemetry/api';
