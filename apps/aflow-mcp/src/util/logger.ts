/**
 * Structured JSON logger for the MCP server.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const entry = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...data,
  };

  // Write to stderr (stdout is reserved for MCP protocol in stdio mode,
  // and for general hygiene with HTTP mode)
  process.stderr.write(JSON.stringify(entry) + '\n');
}
