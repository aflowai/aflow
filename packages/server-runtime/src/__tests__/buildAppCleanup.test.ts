/**
 * A failed build must give back what it already opened.
 *
 * `buildApp` opens the application context and arms its release through
 * `onClose` well before the last route registers. A rejection after that point
 * returns no instance, so the caller cannot close what it never received — the
 * process entrypoint hides this by exiting, an embedding caller does not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import type { ServerComposition } from '../compose/surfaceTier.js';

const SAVED_MOCK = process.env['USE_MOCK_CONTEXT'];

beforeEach(() => {
  // No database and no Redis: this asserts the cleanup runs, not what it frees.
  process.env['USE_MOCK_CONTEXT'] = 'true';
});

afterEach(() => {
  if (SAVED_MOCK === undefined) delete process.env['USE_MOCK_CONTEXT'];
  else process.env['USE_MOCK_CONTEXT'] = SAVED_MOCK;
});

function compositionFailingAfter(onClose: () => void): ServerComposition {
  return {
    tiers: [
      {
        tier: 'core',
        root: [
          {
            name: 'holds-a-resource',
            register: (scope) =>
              Promise.resolve(
                scope.addHook('onClose', () => {
                  onClose();
                  return Promise.resolve();
                }),
              ),
          },
          {
            name: 'fails-to-register',
            register: () => Promise.reject(new Error('registration failed')),
          },
        ],
        v1: () => [],
      },
      // This edition refuses a build carrying no enterprise tier; it contributes
      // nothing, so the failure under test stays the only one.
      { tier: 'enterprise', root: [], v1: () => [] },
    ],
  };
}

describe('buildApp', () => {
  it('closes a half-built instance before rethrowing', async () => {
    let released = false;
    const composition = compositionFailingAfter(() => {
      released = true;
    });

    await expect(buildApp(composition, { logger: false })).rejects.toThrow('registration failed');

    expect(released).toBe(true);
  });
});
