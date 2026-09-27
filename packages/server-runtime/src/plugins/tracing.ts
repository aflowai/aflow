/**
 * Fastify Tracing Plugin
 *
 * Integrates OpenTelemetry tracing with Fastify.
 *
 * HOT-PATH IMPACT: MINIMAL
 * - Span creation per request: ~5μs
 * - Header propagation: ~100ns
 * - All export is async via BatchSpanProcessor
 */

import { type FastifyPluginAsync, type FastifyRequest, type FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import {
  initTracing,
  getTracer,
  extractContext,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
} from '@aflow/observability';

// =============================================================================
// Types
// =============================================================================

declare module 'fastify' {
  interface FastifyRequest {
    span?: Span;
  }
}

interface TracingPluginOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  otlpEndpoint?: string;
  enableConsoleExporter?: boolean;
  /** Paths to skip tracing (e.g., health checks) */
  skipPaths?: string[];
}

// =============================================================================
// Plugin
// =============================================================================

const tracingPlugin: FastifyPluginAsync<TracingPluginOptions> = async (fastify, options) => {
  // Initialize tracing
  // exactOptionalPropertyTypes: avoid passing explicit `undefined` for optional fields
  const tracingConfig: {
    serviceName: string;
    serviceVersion?: string;
    environment?: string;
    otlpEndpoint?: string;
    enableConsoleExporter?: boolean;
  } = { serviceName: options.serviceName };
  if (options.serviceVersion) tracingConfig.serviceVersion = options.serviceVersion;
  if (options.environment) tracingConfig.environment = options.environment;
  if (options.otlpEndpoint) tracingConfig.otlpEndpoint = options.otlpEndpoint;
  if (options.enableConsoleExporter !== undefined) {
    tracingConfig.enableConsoleExporter = options.enableConsoleExporter;
  }
  initTracing(tracingConfig);

  const tracer = getTracer(options.serviceName);
  const skipPaths = new Set(options.skipPaths ?? ['/health', '/ready', '/metrics']);

  // Request hook: start span
  fastify.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    // Skip tracing for health checks etc.
    if (skipPaths.has(request.url.split('?')[0] ?? '')) {
      return;
    }

    // HOT-PATH: Extract context from incoming headers (~100ns)
    const carrier: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') {
        carrier[key] = value;
      }
    }

    const parentContext = extractContext(carrier);

    // HOT-PATH: Create request span (~5μs)
    const span = tracer.startSpan(
      `${request.method} ${request.routeOptions?.url ?? request.url}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.method': request.method,
          'http.url': request.url,
          'http.target': request.routeOptions?.url ?? request.url,
          'http.user_agent': request.headers['user-agent'] ?? '',
        },
      },
      parentContext,
    );

    // Extract Aflow-specific attributes from headers/params
    const tenantId = request.headers['x-tenant-id'];
    if (typeof tenantId === 'string') {
      span.setAttribute('aflow.tenant_id', tenantId);
    }

    // Store span on request for later use
    request.span = span;
  });

  // Response hook: end span with status
  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const span = request.span;
    if (!span) return;

    span.setAttribute('http.status_code', reply.statusCode);

    if (reply.statusCode >= 400) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${reply.statusCode}`,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
  });

  // Error hook: record exception
  fastify.addHook(
    'onError',
    async (request: FastifyRequest, _reply: FastifyReply, error: Error) => {
      const span = request.span;
      if (!span) return;

      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
    },
  );

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    const { shutdownTracing } = await import('@aflow/observability');
    await shutdownTracing();
  });

  fastify.log.info(`[tracing] Plugin registered for ${options.serviceName}`);
};

export default fp(tracingPlugin, {
  name: 'tracing',
  fastify: '5.x',
});

// =============================================================================
// Helpers for Route Handlers
// =============================================================================

/**
 * Get the current request span.
 * Useful for adding custom attributes or creating child spans.
 */
export function getRequestSpan(request: FastifyRequest): Span | undefined {
  return request.span;
}

/**
 * Create a child span for a sub-operation within a request handler.
 *
 * @example
 * ```typescript
 * await withChildSpan(request, "database-query", async (span) => {
 *   span.setAttribute("db.operation", "select");
 *   return await db.query(...);
 * });
 * ```
 */
export async function withChildSpan<T>(
  request: FastifyRequest,
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const parentSpan = request.span;
  const tracer = getTracer('aflow-server');

  if (!parentSpan) {
    // No parent span, just execute without tracing
    return fn(tracer.startSpan(name));
  }

  const ctx = trace.setSpan(context.active(), parentSpan);
  const childSpan = tracer.startSpan(name, { kind: SpanKind.INTERNAL }, ctx);

  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      childSpan.setAttribute(key, value);
    }
  }

  try {
    const result = await fn(childSpan);
    childSpan.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    childSpan.recordException(error as Error);
    childSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  } finally {
    childSpan.end();
  }
}
