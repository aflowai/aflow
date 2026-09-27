/**
 * The guard's whole reason to exist is that it does NOT depend on Sentry being
 * configured, so that is what these assert.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  installUnhandledRejectionGuard,
  resetUnhandledRejectionGuardForTests,
} from './unhandledRejection.js';

describe('unhandled rejection guard', () => {
  beforeEach(() => {
    resetUnhandledRejectionGuardForTests();
  });

  it('handles a rejection without rethrowing it', () => {
    let handler: ((reason: unknown) => void) | undefined;
    const reported: unknown[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    installUnhandledRejectionGuard('phoenix-test', {
      report: (reason) => reported.push(reason),
      onProcess: (_event, h) => {
        handler = h;
      },
    });

    const reason = new Error('connect ECONNREFUSED 10.5.0.3:5432');
    expect(() => handler?.(reason)).not.toThrow();
    expect(reported).toEqual([reason]);
    errors.mockRestore();
  });

  it('installs once, so a second service in the same process does not stack listeners', () => {
    const attached: string[] = [];
    const attach = (event: 'unhandledRejection') => {
      attached.push(event);
    };

    expect(installUnhandledRejectionGuard('first', { onProcess: (e) => attach(e) })).toBe(true);
    expect(installUnhandledRejectionGuard('second', { onProcess: (e) => attach(e) })).toBe(false);
    expect(attached).toEqual(['unhandledRejection']);
  });
});

describe('initSentry', () => {
  const savedDsn = process.env['SENTRY_DSN'];

  beforeEach(() => {
    resetUnhandledRejectionGuardForTests();
    delete process.env['SENTRY_DSN'];
  });

  afterEach(() => {
    if (savedDsn === undefined) delete process.env['SENTRY_DSN'];
    else process.env['SENTRY_DSN'] = savedDsn;
  });

  it('is installed by crash-reporting startup even with no DSN and no reporter', async () => {
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { initCrashReporting } = await import('./crashReporting.js');
    initCrashReporting({ serviceName: 'phoenix-test' });

    // The guarantee is core and unconditional: a build with no reporter, and an
    // operator who configured no reporting, still survive a stray rejection.
    expect(on.mock.calls.map(([event]) => event)).toContain('unhandledRejection');

    on.mockRestore();
    log.mockRestore();
  });
});
