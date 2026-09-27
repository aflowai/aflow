export const getGreeting = (name: string) => `Hello, ${name}!`;

export * from './email-templates/index.js';
export * from './bindingScopeResolution.js';
export * from './envMs.js';
export * from './jsonPatch.js';
export * from './restrictedJsonpath.js';
export * from './webBaseUrl.js';
export * from './performanceLogging.js';
export * from './backgroundTask/runner.js';
export * from './leasedWork/consumer.js';

// ============================================================================
// Default AI model IDs (single source of truth)
// ============================================================================
// Generic keys (e.g. 'flash-lite') resolve to the latest version via catalog
// aliases. When a new model version ships, update the alias mapping in
// packages/ai-client/src/catalog.ts — all consumers stay untouched.
//
// Version-pinned keys (e.g. 'flash-lite-3.5') are available for flows that
// need deterministic model selection.
export const DEFAULT_AI_MODELS = {
  text: 'haiku',
  image: 'flash-image',
  video: 'veo',
  embedding: 'text-embedding-3-small',
  decision: 'jev',
} as const;

// ============================================================================
// Model Selection Lists (single source of truth for UI dropdowns & schemas)
// ============================================================================
// These curated lists drive Zod enum schemas, flow editor dropdowns, and
// the get_schema operation output. Each entry MUST be a valid alias or ID
// in the ai-client model catalog.
//
// To add a model to the selection: add it here AND ensure a matching alias
// or ID exists in packages/ai-client/src/catalog.ts.
export const MODEL_SELECTIONS = {
  text: [
    'openai-gpt',
    'openai-mini',
    'anthropic-opus',
    'anthropic-sonnet',
    'anthropic-haiku',
    'google-pro',
    'google-flash',
    'google-flash-lite',
    'openai/gpt-oss-120b',
    'kimi-pro',
    'glm-pro',
    'glm-flash',
    'grok',
  ] as const,
  embedding: ['text-embedding-3-small', 'text-embedding-3-large'] as const,
  decision: ['jev'] as const,
} as const;

export interface ShutdownLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface ShutdownController {
  readonly shuttingDown: boolean;
  shutdownOnce(): Promise<void>;
}

export interface CreateShutdownControllerOptions {
  name: string;
  logger: ShutdownLogger;
  onShutdown: () => Promise<void>;
}

export function createShutdownController(
  options: CreateShutdownControllerOptions,
): ShutdownController {
  const { name, logger, onShutdown } = options;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const shutdownOnce = async (): Promise<void> => {
    if (shuttingDown) {
      await shutdownPromise;
      return;
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      try {
        logger.info(`${name}: shutting down gracefully...`);
        await onShutdown();
        logger.info(`${name}: shutdown complete`);
      } catch (error) {
        logger.warn(`${name}: error during shutdown`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    await shutdownPromise;
  };

  return {
    get shuttingDown() {
      return shuttingDown;
    },
    shutdownOnce,
  };
}

export interface AttachSignalHandlersOptions {
  onShutdown: () => Promise<void>;
  exitCode?: number;
}

/**
 * Cross-package contract: `@aflow/observability`'s `initSentry` registers a flush
 * fn on this global (see `SENTRY_SHUTDOWN_FLUSH_KEY`) so we can drain buffered Sentry
 * events before exit without importing `@sentry/node` into this generic package.
 * No-op when Sentry never initialized.
 */
async function drainSentry(): Promise<void> {
  const flush = (globalThis as Record<string, unknown>)['__phoenixSentryShutdownFlush'];
  if (typeof flush === 'function') {
    try {
      await (flush as () => Promise<void>)();
    } catch {
      // Never let a flush failure block exit.
    }
  }
}

export function attachSignalHandlers(options: AttachSignalHandlersOptions): void {
  const { onShutdown, exitCode = 0 } = options;
  let handling = false;

  const handle = () => {
    if (handling) return;
    handling = true;
    void (async () => {
      try {
        await onShutdown();
      } finally {
        await drainSentry();
        process.exit(exitCode);
      }
    })();
  };

  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
}
