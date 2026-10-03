/**
 * The two decisions one `devMode` flag used to make.
 *
 * Whether a session may proceed with no credential is a property of the API
 * this talks to — sending nothing reaches something only where that stack has a
 * development bypass. Whether a browser origin may be admitted is a property of
 * this process's exposure. Reading both from `NODE_ENV` tied the local edition,
 * which composes no bypass, to a fallback that can only produce a 401 two hops
 * from the cause.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadConfig } from './config.js';

const ENV_KEYS = [
  'NODE_ENV',
  'PHOENIX_EDITION',
  'MCP_HOST',
  'HOST',
  'ALLOWED_HOSTS',
  'MCP_ALLOWED_ORIGINS',
] as const;
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

describe('a browser origin', () => {
  it('may be configured outside production', () => {
    expect(configWith({ NODE_ENV: 'development' }).allowBrowserOrigins).toBe(true);
  });

  it('is never admitted in production', () => {
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

/**
 * A session that picks up the local auth file is the owner. The loopback
 * listener keeps other machines out; the Host and Origin checks keep out a web
 * page reaching it through a rebound name. It takes both to keep the owner on
 * this machine.
 */
describe('the listen host', () => {
  it('is loopback when none is configured', () => {
    expect(configWith({}).host).toBe('127.0.0.1');
  });

  it('is loopback when MCP_HOST is blank', () => {
    expect(configWith({ MCP_HOST: '   ' }).host).toBe('127.0.0.1');
  });

  /** The shared `.env` sets HOST to every interface for the API server. */
  it('ignores HOST', () => {
    expect(configWith({ HOST: '0.0.0.0' }).host).toBe('127.0.0.1');
  });

  it('is MCP_HOST when one is configured', () => {
    expect(configWith({ MCP_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
});

describe('the hosts and origins this server answers to', () => {
  it('are none beyond the loopback default when nothing is configured', () => {
    const config = configWith({});
    expect(config.allowedHosts).toEqual([]);
    expect(config.allowedOrigins).toEqual([]);
  });

  it('are read as trimmed, lower-case lists with blanks dropped', () => {
    const config = configWith({
      ALLOWED_HOSTS: ' MCP.example.test, ,localhost ',
      MCP_ALLOWED_ORIGINS: 'http://LOCALHOST:5173/ ,',
    });
    expect(config.allowedHosts).toEqual(['mcp.example.test', 'localhost']);
    expect(config.allowedOrigins).toEqual(['http://localhost:5173']);
  });
});
