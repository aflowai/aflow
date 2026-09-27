/**
 * Structured Logging with Correlation IDs
 *
 * DESIGN PRINCIPLES:
 * - JSON structured output for easy parsing
 * - Correlation IDs propagated via async context
 * - Minimal overhead on hot path
 * - Secret redaction built-in
 *
 * HOT-PATH IMPACT: MINIMAL
 * - Log formatting: ~1-5μs
 * - Console write: async via Node.js event loop
 */

import { trace, context } from '@opentelemetry/api';

// =============================================================================
// Types
// =============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  tenantId?: string;
  runId?: string;
  stepExecutionId?: string;
  stepType?: string;
  operationId?: string;
  attempt?: number;
  requestId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service: string;
  traceId?: string;
  spanId?: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

export interface LoggerConfig {
  service: string;
  level?: LogLevel;
  /** Fields to redact from logs */
  redactFields?: string[];
  /**
   * Human-readable lines for local terminals (default: on when NODE_ENV is not production,
   * matching apps/server Fastify + pino-pretty behavior).
   */
  prettyPrint?: boolean;
}

// =============================================================================
// Module State
// =============================================================================

/** Match server dev detection: `packages/server-runtime/src/serve.ts` uses NODE_ENV !== 'production' for pino-pretty. */
function defaultPrettyPrint(): boolean {
  return process.env['NODE_ENV'] !== 'production';
}

/** ANSI colors for pretty mode — disabled for non-TTY, NO_COLOR, or FORCE_COLOR=0. */
function shouldColorizePretty(): boolean {
  if (process.env['NO_COLOR'] != null) {
    return false;
  }
  if (process.env['FORCE_COLOR'] === '0') {
    return false;
  }
  if (process.env['FORCE_COLOR'] != null && process.env['FORCE_COLOR'] !== '0') {
    return true;
  }
  return process.stdout.isTTY;
}

const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
} as const;

function paint(color: keyof typeof ansi, text: string, useColor: boolean): string {
  if (!useColor) {
    return text;
  }
  return `${ansi[color]}${text}${ansi.reset}`;
}

function levelPaint(level: LogLevel, text: string, useColor: boolean): string {
  if (!useColor) {
    return text;
  }
  switch (level) {
    case 'debug':
      return `${ansi.dim}${ansi.cyan}${text}${ansi.reset}`;
    case 'info':
      return `${ansi.green}${text}${ansi.reset}`;
    case 'warn':
      return `${ansi.yellow}${text}${ansi.reset}`;
    case 'error':
      return `${ansi.red}${text}${ansi.reset}`;
    default:
      return text;
  }
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default redact patterns
const DEFAULT_REDACT_FIELDS = [
  'password',
  'secret',
  'apiKey',
  'api_key',
  'token',
  'authorization',
  'credential',
  'private_key',
  'privateKey',
];

// =============================================================================
// Logger Class
// =============================================================================

export class Logger {
  private service: string;
  private minLevel: number;
  private redactFields: string[];
  private prettyPrint: boolean;
  private baseContext: LogContext;

  constructor(config: LoggerConfig, baseContext: LogContext = {}) {
    this.service = config.service;
    this.minLevel = LOG_LEVELS[config.level ?? 'info'];
    this.redactFields = [...DEFAULT_REDACT_FIELDS, ...(config.redactFields ?? [])];
    this.prettyPrint = config.prettyPrint ?? defaultPrettyPrint();
    this.baseContext = baseContext;
  }

  /**
   * Create a child logger with additional context.
   *
   * HOT-PATH: MINIMAL (~1μs)
   */
  child(additionalContext: LogContext): Logger {
    const childLogger = new Logger(
      {
        service: this.service,
        level: this.getLevelName(this.minLevel),
        redactFields: this.redactFields,
        prettyPrint: this.prettyPrint,
      },
      { ...this.baseContext, ...additionalContext },
    );
    return childLogger;
  }

  private getLevelName(level: number): LogLevel {
    const entry = Object.entries(LOG_LEVELS).find(([, v]) => v === level);
    return (entry?.[0] as LogLevel) ?? 'info';
  }

  /**
   * Log at debug level.
   *
   * HOT-PATH: MINIMAL (~1-5μs if enabled, skipped if level filtered)
   */
  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  /**
   * Log at info level.
   *
   * HOT-PATH: MINIMAL (~1-5μs)
   */
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  /**
   * Log at warn level.
   *
   * HOT-PATH: MINIMAL (~1-5μs)
   */
  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  /**
   * Log at error level.
   *
   * HOT-PATH: MINIMAL (~1-5μs)
   */
  error(message: string, error?: Error, context?: LogContext): void {
    this.log('error', message, context, error);
  }

  private log(level: LogLevel, message: string, ctx?: LogContext, error?: Error): void {
    if (LOG_LEVELS[level] < this.minLevel) {
      return;
    }

    const entry = this.buildEntry(level, message, ctx, error);
    this.write(level, entry);
  }

  private buildEntry(level: LogLevel, message: string, ctx?: LogContext, error?: Error): LogEntry {
    // Extract trace context from OTel
    const span = trace.getSpan(context.active());
    const spanContext = span?.spanContext();

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.service,
    };

    if (spanContext) {
      entry.traceId = spanContext.traceId;
      entry.spanId = spanContext.spanId;
    }

    const mergedContext = { ...this.baseContext, ...ctx };
    if (Object.keys(mergedContext).length > 0) {
      entry.context = this.redact(mergedContext);
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        ...(error.stack != null && { stack: error.stack }),
      };
    }

    return entry;
  }

  private redact(obj: LogContext): LogContext {
    const redacted: LogContext = {};

    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const shouldRedact = this.redactFields.some((field) =>
        lowerKey.includes(field.toLowerCase()),
      );

      if (shouldRedact) {
        redacted[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        redacted[key] = this.redact(value as LogContext);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  private write(level: LogLevel, entry: LogEntry): void {
    const output = this.prettyPrint ? this.formatPretty(entry) : JSON.stringify(entry);

    switch (level) {
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.info(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  }

  /** Compact dev-terminal lines (pino-pretty–like: time, level color, service, message). */
  private formatPretty(entry: LogEntry): string {
    const useColor = shouldColorizePretty();
    const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm
    const lvl = entry.level.toUpperCase().padEnd(5);
    const timePart = paint('gray', `[${time}]`, useColor);
    const lvlPart = levelPaint(entry.level, lvl, useColor);
    const svcPart = paint('cyan', `(${entry.service})`, useColor);
    let line = `${timePart} ${lvlPart} ${svcPart}: ${entry.message}`;
    if (entry.context && Object.keys(entry.context).length > 0) {
      line += paint('dim', ` ${JSON.stringify(entry.context)}`, useColor);
    }
    if (entry.error) {
      line += paint('red', ` ERR: ${entry.error.message}`, useColor);
      if (entry.error.stack) {
        line += `\n${paint('dim', entry.error.stack, useColor)}`;
      }
    }
    return line;
  }
}

// =============================================================================
// Default Logger Factory
// =============================================================================

let defaultConfig: LoggerConfig | null = null;

/**
 * Configure the default logger settings.
 * Call once at application startup.
 *
 * HOT-PATH: NO - Called once at startup
 */
export function configureLogging(config: LoggerConfig): void {
  defaultConfig = config;
}

/**
 * Create a new logger instance.
 *
 * HOT-PATH: MINIMAL (~1μs)
 */
export function createLogger(context?: LogContext): Logger {
  if (!defaultConfig) {
    throw new Error('Logging not configured. Call configureLogging() at startup.');
  }
  return new Logger(defaultConfig, context);
}

/**
 * Create a logger with explicit config (useful for packages).
 *
 * HOT-PATH: MINIMAL (~1μs)
 */
export function createLoggerWithConfig(config: LoggerConfig, context?: LogContext): Logger {
  return new Logger(config, context);
}

// =============================================================================
// Request Context Helpers
// =============================================================================

/**
 * Build log context from Aflow identifiers.
 * Commonly used when processing a step or run.
 *
 * HOT-PATH: MINIMAL (~100ns)
 */
export function buildAflowContext(params: {
  tenantId?: string;
  runId?: string;
  stepExecutionId?: string;
  stepType?: string;
  operationId?: string;
  attempt?: number;
}): LogContext {
  const ctx: LogContext = {};
  if (params.tenantId) ctx.tenantId = params.tenantId;
  if (params.runId) ctx.runId = params.runId;
  if (params.stepExecutionId) ctx.stepExecutionId = params.stepExecutionId;
  if (params.stepType) ctx.stepType = params.stepType;
  if (params.operationId) ctx.operationId = params.operationId;
  if (params.attempt !== undefined) ctx.attempt = params.attempt;
  return ctx;
}
