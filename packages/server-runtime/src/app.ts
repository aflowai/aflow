/**
 * Fastify application builder.
 * Configures all plugins, middleware, and routes.
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { clientIp } from './lib/clientIp.js';
import { globalErrorHandler } from './lib/errorHandler.js';
import { registerJsonBodyParser } from './lib/jsonBodyParser.js';
import { assertProductionSecurityConfig } from './lib/productionSecurityConfig.js';
import {
  applyCrashReporterFastifyHandler,
  isCrashReporterActive,
} from '@aflow/observability/crashReporting';
import { buildRateLimitOptions } from './lib/rateLimitPolicy.js';
import { createRedisConnection, getRedisConfig } from '@aflow/redis';
import { isTierEnabled } from '@aflow/schemas';

// Plugins
import tracingPlugin from './plugins/tracing.js';
import { editionPlugin } from './plugins/edition.js';
import { authPlugin } from './plugins/auth.js';
import { auditPlugin } from './plugins/audit.js';
import { authzPlugin } from './plugins/authz.js';
import { tenantPlugin } from './plugins/tenant.js';
import { spacePlugin } from './plugins/space.js';
import { registerAppContext } from './services/context.js';
import { createRunWatchdog } from './services/runWatchdog.js';
import type { ServerComposition } from './compose/surfaceTier.js';

// Routes
import { registerRealtimeTopic } from './routes/realtime.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createSessionEventsTopicHandler } from './routes/realtimeTopics/sessionEvents.js';
import { createSessionPresenceTopicHandler } from './routes/realtimeTopics/sessionPresence.js';
import { createAppletInstanceTopicHandler } from './routes/realtimeTopics/appletInstance.js';
import { createSpaceEntityEventsTopicHandler } from './routes/realtimeTopics/spaceEntityEvents.js';
import { createSpaceActionCenterTopicHandler } from './routes/realtimeTopics/spaceActionCenter.js';
import {
  createSpaceCoachSurfaceTopicHandler,
  defaultListPendingAnomalies,
} from './routes/realtimeTopics/spaceCoachSurface.js';
import { buildActiveSurface } from '@aflow/cybernetic-runtime';
import { buildSpaceActionCenterAggregator } from './services/actionCenter/buildSpaceAggregator.js';
import { createSessionService } from './services/sessions.js';
import { createActivityTopicHandler } from './routes/realtimeTopics/activity.js';

/**
 * Build the Fastify application with all plugins and routes.
 *
 * `composition` is required: which surfaces a process serves is the caller's
 * decision, and a builder that supplied its own default would be deciding it
 * from inside the shared half.
 */
export async function buildApp(
  composition: ServerComposition,
  options: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  assertProductionSecurityConfig(composition.identityPlane);

  const app = Fastify(options).withTypeProvider<ZodTypeProvider>();
  try {
    return await registerApp(app, composition);
  } catch (err) {
    // Registration opens the application context and arms its release through
    // `onClose`, which a half-built instance never reaches on its own. The
    // caller is holding a rejected promise and no handle, so closing here is
    // the only place the database and Redis connections can be given back.
    await app.close().catch(() => undefined);
    throw err;
  }
}

async function registerApp<T extends FastifyInstance>(
  app: T,
  composition: ServerComposition,
): Promise<T> {
  await app.register(editionPlugin);

  // Registers an onError hook (additive — coexists with our setErrorHandler) that
  // reports 5xx errors to the crash reporter, where a build has one. The server
  // is core and the reporter is not, so it asks whether anything registered a
  // handler rather than naming the vendor.
  if (isCrashReporterActive()) {
    applyCrashReporterFastifyHandler(app);
  }

  // Set up Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerJsonBodyParser(app);

  // ============================================================================
  // Observability (registered first for full request tracing)
  // ============================================================================

  // Only enable tracing if OTEL endpoint is configured or in development with console export
  const enableTracing =
    Boolean(process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) ||
    process.env['ENABLE_CONSOLE_TRACING'] === 'true';
  if (enableTracing) {
    // exactOptionalPropertyTypes: avoid passing explicit `undefined` for optional fields
    const tracingOpts: {
      serviceName: string;
      serviceVersion?: string;
      environment?: string;
      otlpEndpoint?: string;
      enableConsoleExporter?: boolean;
      skipPaths?: string[];
    } = {
      serviceName: 'aflow-server',
      serviceVersion: process.env['npm_package_version'] ?? '0.1.0',
      environment: process.env['NODE_ENV'] ?? 'development',
      enableConsoleExporter: process.env['ENABLE_CONSOLE_TRACING'] === 'true',
      skipPaths: ['/health', '/ready', '/metrics'],
    };
    const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    if (otlpEndpoint) {
      tracingOpts.otlpEndpoint = otlpEndpoint;
    }
    await app.register(tracingPlugin, tracingOpts);
  }

  // ============================================================================
  // Security & Infrastructure Plugins
  // ============================================================================

  // CORS - configure for your frontend origin
  const corsOrigin = process.env['CORS_ORIGIN'];
  await app.register(cors, {
    origin: corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim())
      : process.env['NODE_ENV'] === 'production'
        ? false // Reject all cross-origin in production when CORS_ORIGIN is unset
        : true, // Allow all in development
    credentials: true,
    // `Retry-After` is not CORS-safelisted, so without this the browser cannot
    // read it and every rate-limit refusal looks to the client like one that
    // named no delay — the limiter publishes a window nothing can honour.
    exposedHeaders: ['Retry-After'],
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy:
      process.env['NODE_ENV'] === 'production'
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              connectSrc: ["'self'"],
              imgSrc: ["'self'", 'data:'],
              styleSrc: ["'self'", "'unsafe-inline'"],
            },
          }
        : false, // Disabled in dev for Swagger UI and hot reload
    hsts:
      process.env['NODE_ENV'] === 'production'
        ? { maxAge: 31536000, includeSubDomains: true }
        : false,
  });

  // Only when Redis is actually configured; dev without it keeps the
  // in-memory counters rather than failing to boot.
  const rateLimitStore =
    process.env['REDIS_URL'] || process.env['REDIS_HOST']
      ? createRedisConnection({
          ...getRedisConfig(),
          connectionName: 'rate-limiter',
          enableOfflineQueue: false,
        })
      : undefined;

  await app.register(
    rateLimit,
    buildRateLimitOptions({ ...(rateLimitStore ? { redis: rateLimitStore } : {}), clientIp }),
  );

  // Sensible defaults (error handling, etc.)
  await app.register(sensible);

  app.setErrorHandler(globalErrorHandler);

  // WebSocket support
  await app.register(websocket);

  // ============================================================================
  // OpenAPI Documentation (disabled in production)
  // ============================================================================

  if (process.env['NODE_ENV'] !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Phoenix Aflow API',
          description: 'Event-driven workflow engine API',
          version: '1.0.0',
        },
        servers: [
          {
            url: process.env['API_BASE_URL'] ?? 'http://localhost:3000',
            description: 'API Server',
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'Auth0 JWT token',
            },
          },
        },
        security: [{ bearerAuth: [] }],
        tags: [
          { name: 'Health', description: 'Health check endpoints' },
          { name: 'Runs', description: 'Flow run management' },
          { name: 'Flows', description: 'Flow definition management' },
          { name: 'Catalog', description: 'Step types and operations catalog' },
          { name: 'Events', description: 'Real-time event streaming (SSE)' },
          { name: 'Realtime', description: 'WebSocket activity signals' },
          { name: 'Payloads', description: 'Large payload storage' },
          { name: 'Admin', description: 'Administrative and operational endpoints' },
          { name: 'Integrations', description: 'API definitions, bindings, and credentials' },
          { name: 'Users', description: 'User management and profile' },
          { name: 'Invites', description: 'Tenant invite management' },
          { name: 'Spaces', description: 'Space management within tenants' },
          { name: 'API Keys', description: 'API key management' },
          { name: 'Audit', description: 'Audit log queries' },
          { name: 'Guardrails', description: 'Guardrail policy management' },
          { name: 'Evals', description: 'Evaluation suites and runs' },
        ],
      },
    });

    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  }

  // ============================================================================
  // Application Context (Database, Redis, Services)
  // ============================================================================

  await registerAppContext(app, {
    useMock: process.env['USE_MOCK_CONTEXT'] === 'true',
  });

  // ============================================================================
  // Authentication & Tenant Context
  // ============================================================================

  await app.register(authPlugin, { identityPlane: composition.identityPlane });
  await app.register(tenantPlugin);
  await app.register(spacePlugin);
  await app.register(auditPlugin);
  await app.register(authzPlugin);

  // ============================================================================
  // API Routes
  // ============================================================================

  // A hosted process composed from the core root serves a product missing its
  // identity, admission and governance surfaces, and says nothing about it:
  // every route that remains answers normally. Refusing is the only way the
  // absence is visible, and production is where a deploy path that dropped the
  // hosted composition root would otherwise reach users.
  if (
    process.env['NODE_ENV'] === 'production' &&
    app.edition.edition !== 'community-local' &&
    !composition.tiers.some((tier) => tier.tier === 'enterprise')
  ) {
    throw new Error(
      `Edition "${app.edition.edition}" composed no enterprise surfaces. ` +
        'Run the hosted composition root, or set PHOENIX_EDITION=community-local.',
    );
  }

  const enabledTiers = composition.tiers.filter((tier) =>
    isTierEnabled(app.edition.edition, tier.tier),
  );

  // Named from the same roots the registrations come from, so a client that
  // hides a control because its surface is absent cannot disagree with what
  // this process serves.
  app.decorate(
    'enabledSurfaces',
    enabledTiers
      .flatMap((tier) => [...tier.root, ...tier.v1({ actionCenterAggregator: null })])
      .map((surface) => surface.name),
  );

  for (const tier of enabledTiers) {
    for (const surface of tier.root) await surface.register(app);
  }

  await app.register(
    async (v1) => {
      if (v1.appContext.db && v1.appContext.payloadStore) {
        registerRealtimeTopic(
          createSessionEventsTopicHandler({
            db: v1.appContext.db as PostgresJsDatabase,
            redis: v1.appContext.redis,
            payloadStore: v1.appContext.payloadStore,
            pubsubSubscriber: v1.appContext.pubsubSubscriber,
          }),
        );
      }
      if (v1.appContext.db && v1.appContext.redis) {
        registerRealtimeTopic(
          createSessionPresenceTopicHandler({
            db: v1.appContext.db as PostgresJsDatabase,
            redis: v1.appContext.redis,
          }),
        );
      }
      if (v1.appContext.db) {
        registerRealtimeTopic(
          createAppletInstanceTopicHandler({
            db: v1.appContext.db as PostgresJsDatabase,
            redis: v1.appContext.redis,
          }),
        );
      }
      if (v1.appContext.redis) {
        registerRealtimeTopic(
          createSpaceEntityEventsTopicHandler({
            redis: v1.appContext.redis,
            db: v1.appContext.db as PostgresJsDatabase,
          }),
        );
      }
      let spaceActionCenterAggregator: ReturnType<typeof buildSpaceActionCenterAggregator> | null =
        null;
      if (v1.appContext.db && v1.appContext.redis && v1.appContext.payloadStore) {
        spaceActionCenterAggregator = buildSpaceActionCenterAggregator({
          db: v1.appContext.db as PostgresJsDatabase,
          redis: v1.appContext.redis,
          payloadStore: v1.appContext.payloadStore,
          sessionService: createSessionService(v1.appContext),
          audit: v1.audit,
        });
        registerRealtimeTopic(
          createSpaceActionCenterTopicHandler({
            db: v1.appContext.db as PostgresJsDatabase,
            redis: v1.appContext.redis,
            aggregator: spaceActionCenterAggregator,
          }),
        );
      }

      if (v1.appContext.db && v1.appContext.redis) {
        registerRealtimeTopic(
          createSpaceCoachSurfaceTopicHandler({
            db: v1.appContext.db as PostgresJsDatabase,
            redis: v1.appContext.redis,
            source: {
              buildActiveSurface: ({ db, redis, tenantId, spaceId }) =>
                buildActiveSurface({ db, redis, tenantId, spaceId }),
              listPendingAnomalies: defaultListPendingAnomalies,
            },
          }),
        );
      }

      registerRealtimeTopic(createActivityTopicHandler());

      for (const tier of enabledTiers) {
        for (const surface of tier.v1({ actionCenterAggregator: spaceActionCenterAggregator })) {
          await surface.register(v1);
        }
      }
    },
    { prefix: '/v1' },
  );

  // ============================================================================
  // Run Watchdog (orphaned QUEUED → STALLED detector)
  // ============================================================================

  const context = app.appContext;
  if (context.redis && !context.isMock) {
    const watchdog = createRunWatchdog(
      {
        redis: context.redis,
        logger: {
          info: (...args: unknown[]) => {
            app.log.info(...(args as [object, string?, ...unknown[]]));
          },
          warn: (...args: unknown[]) => {
            app.log.warn(...(args as [object, string?, ...unknown[]]));
          },
          error: (...args: unknown[]) => {
            app.log.error(...(args as [object, string?, ...unknown[]]));
          },
          debug: (...args: unknown[]) => {
            app.log.debug(...(args as [object, string?, ...unknown[]]));
          },
        },
      },
      {
        intervalMs: 15_000, // Check every 15s
        gracePeriodMs: 30_000, // Allow 30s for orchestrator to pick up
      },
    );

    watchdog.start();

    // Clean up on server close
    app.addHook('onClose', async () => {
      await watchdog.stop();
    });
  }

  return app;
}
