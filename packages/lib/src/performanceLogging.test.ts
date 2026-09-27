import { describe, expect, it } from 'vitest';
import {
  backgroundWorkVerboseLogsEnabled,
  getPerformanceLogThresholds,
  isSlowBlockingRead,
} from './performanceLogging.js';

describe('performance logging configuration', () => {
  it('keeps production thresholds sensitive', () => {
    expect(getPerformanceLogThresholds({ NODE_ENV: 'production' })).toEqual({
      slowQueryMs: 100,
      slowReadOverrunMs: 350,
    });
  });

  it('uses quieter thresholds outside production', () => {
    expect(getPerformanceLogThresholds({ NODE_ENV: 'development' })).toEqual({
      slowQueryMs: 1_000,
      slowReadOverrunMs: 1_500,
    });
  });

  it('accepts positive millisecond overrides and ignores invalid values', () => {
    expect(
      getPerformanceLogThresholds({
        NODE_ENV: 'development',
        PERF_SLOW_QUERY_MS: '250',
        PERF_SLOW_READ_MS: '900.9',
      }),
    ).toEqual({ slowQueryMs: 250, slowReadOverrunMs: 900 });

    expect(
      getPerformanceLogThresholds({
        NODE_ENV: 'production',
        PERF_SLOW_QUERY_MS: '0',
        PERF_SLOW_READ_MS: 'not-a-number',
      }),
    ).toEqual({ slowQueryMs: 100, slowReadOverrunMs: 350 });
  });

  it('measures idle read delay beyond the requested Redis block time', () => {
    const env = { NODE_ENV: 'production', PERF_SLOW_READ_MS: '350' };
    expect(isSlowBlockingRead(850, 500, env)).toBe(false);
    expect(isSlowBlockingRead(851, 500, env)).toBe(true);
  });

  it('enables background-work summaries only for the explicit opt-in value', () => {
    expect(backgroundWorkVerboseLogsEnabled({ BACKGROUND_WORK_VERBOSE_LOGS: '1' })).toBe(true);
    expect(backgroundWorkVerboseLogsEnabled({ BACKGROUND_WORK_VERBOSE_LOGS: 'true' })).toBe(false);
    expect(backgroundWorkVerboseLogsEnabled({})).toBe(false);
  });
});
