export interface PerformanceLogThresholds {
  /** Total tenant transaction duration before a warning is emitted. */
  slowQueryMs: number;
  /** Allowed delay beyond a Redis BLOCK timeout before an idle-read warning is emitted. */
  slowReadOverrunMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function readPositiveMilliseconds(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getPerformanceLogThresholds(
  env: Environment = process.env,
): PerformanceLogThresholds {
  const production = env['NODE_ENV'] === 'production';
  return {
    slowQueryMs: readPositiveMilliseconds(env, 'PERF_SLOW_QUERY_MS', production ? 100 : 1_000),
    slowReadOverrunMs: readPositiveMilliseconds(env, 'PERF_SLOW_READ_MS', production ? 350 : 1_500),
  };
}

export function isSlowBlockingRead(
  elapsedMs: number,
  blockMs: number,
  env: Environment = process.env,
): boolean {
  return elapsedMs > blockMs + getPerformanceLogThresholds(env).slowReadOverrunMs;
}

export function backgroundWorkVerboseLogsEnabled(env: Environment = process.env): boolean {
  return env['BACKGROUND_WORK_VERBOSE_LOGS'] === '1';
}
