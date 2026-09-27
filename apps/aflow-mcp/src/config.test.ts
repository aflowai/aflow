/**
 * The two decisions one `devMode` flag used to make.
 *
 * Whether a session may proceed with no credential is a property of the API
 * this talks to — sending nothing reaches something only where that stack has a
 * development bypass. Whether a browser's preflight is answered is a property of
 * this process's exposure. Reading both from `NODE_ENV` tied the local edition,
 * which composes no bypass, to a fallback that can only produce a 401 two hops
 * from the cause.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadConfig } from './config.js';

const ENV_KEYS = ['NODE_ENV', 'PHOENIX_EDITION'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function configWith(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return loadConfig();
}

describe('an uncredentialed session', () => {
  it('may proceed against a development stack', () => {
    expect(configWith({ NODE_ENV: 'development' }).unauthenticatedFallback).toBe(true);
  });

  it('is refused in production', () => {
    expect(configWith({ NODE_ENV: 'production' }).unauthenticatedFallback).toBe(false);
  });

  /** The appliance sets NODE_ENV=production, but the edition is what decides. */
  it('is refused by the local edition whatever NODE_ENV says', () => {
    const config = configWith({ NODE_ENV: 'development', PHOENIX_EDITION: 'community-local' });
    expect(config.unauthenticatedFallback).toBe(false);
  });
});

describe('a browser preflight', () => {
  it('is answered outside production', () => {
    expect(configWith({ NODE_ENV: 'development' }).allowBrowserOrigins).toBe(true);
  });

  it('is not answered in production', () => {
    expect(configWith({ NODE_ENV: 'production' }).allowBrowserOrigins).toBe(false);
  });

  /**
   * The decision the split exists for: a local instance a developer is driving
   * from a browser still refuses an uncredentialed session.
   */
  it('is independent of whether a session may go uncredentialed', () => {
    const config = configWith({ NODE_ENV: 'development', PHOENIX_EDITION: 'community-local' });
    expect(config.allowBrowserOrigins).toBe(true);
    expect(config.unauthenticatedFallback).toBe(false);
  });
});
