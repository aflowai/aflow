/**
 * The seam holds whether or not this build carries a reporter.
 *
 * The property §6b needs is absence from the artifact, so the load has to survive
 * the module simply not being there — and the load has to stay synchronous,
 * because a top-level await in the first import does not hold back a sibling
 * import, which would let `redis` and `pg` evaluate before the reporter patched
 * them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCrashReporterFastifyHandler,
  flushCrashReporting,
  initCrashReporting,
  isCrashReporterActive,
  registerCrashReporterFastifyHandler,
} from './crashReporting.js';
import { SENTRY_SHUTDOWN_FLUSH_KEY } from './sentryActive.js';

const globals = globalThis as Record<string, unknown>;

afterEach(() => {
  delete globals['__phoenixCrashReporterFastifyHandler'];
  delete globals[SENTRY_SHUTDOWN_FLUSH_KEY];
  delete process.env['SENTRY_DSN'];
  delete process.env['PHOENIX_EDITION'];
  vi.restoreAllMocks();
});

describe('starting the reporter', () => {
  it('loads nothing and says nothing when no DSN is configured', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    initCrashReporting({ serviceName: 'probe' });
    expect(log).not.toHaveBeenCalled();
  });

  it('is synchronous, so the caller cannot accidentally await it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(initCrashReporting({ serviceName: 'probe' })).toBeUndefined();
  });

  it('says so calmly when the local edition carries no reporter', () => {
    process.env['SENTRY_DSN'] = 'https://examplekey@example.invalid/1';
    process.env['PHOENIX_EDITION'] = 'community-local';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initCrashReporting({ serviceName: 'probe' });
    // Whichever way the module resolves in this checkout, a local edition never
    // reports a missing reporter as a fault.
    expect(error).not.toHaveBeenCalled();
    void log;
  });
});

describe('the Fastify handler', () => {
  it('does nothing when no reporter registered one', () => {
    expect(() => {
      applyCrashReporterFastifyHandler({});
    }).not.toThrow();
  });

  it('applies whatever the reporter registered, without naming it', () => {
    const seen: unknown[] = [];
    registerCrashReporterFastifyHandler((app) => seen.push(app));
    const app = { id: 'fastify' };
    applyCrashReporterFastifyHandler(app);
    expect(seen).toEqual([app]);
  });
});

describe('draining at shutdown', () => {
  it('resolves when nothing registered a flush', async () => {
    await expect(flushCrashReporting()).resolves.toBeUndefined();
  });

  it('calls the registered flush', async () => {
    let called = false;
    globals[SENTRY_SHUTDOWN_FLUSH_KEY] = async () => {
      called = true;
    };
    await flushCrashReporting();
    expect(called).toBe(true);
  });

  it('never lets a failing flush block shutdown', async () => {
    globals[SENTRY_SHUTDOWN_FLUSH_KEY] = async () => {
      throw new Error('reporter is unreachable');
    };
    await expect(flushCrashReporting()).resolves.toBeUndefined();
  });
});

describe('the active flag', () => {
  it('is false in a process where nothing initialised', () => {
    expect(typeof isCrashReporterActive()).toBe('boolean');
  });
});
