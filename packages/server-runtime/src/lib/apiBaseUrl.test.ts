import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canonicalApiOrigin, resolveApiBaseUrl, resolveWebSocketOrigin } from './apiBaseUrl.js';

describe('resolveApiBaseUrl', () => {
  const originalBase = process.env['API_BASE_URL'];
  const originalPort = process.env['PORT'];

  beforeEach(() => {
    delete process.env['API_BASE_URL'];
    delete process.env['PORT'];
  });

  afterEach(() => {
    if (originalBase === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = originalBase;
    if (originalPort === undefined) delete process.env['PORT'];
    else process.env['PORT'] = originalPort;
  });

  it('returns API_BASE_URL when set', () => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai';
    expect(resolveApiBaseUrl()).toBe('https://api.aflow.ai');
  });

  it('strips a trailing slash so path concatenation stays single-slashed', () => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai/';
    expect(`${resolveApiBaseUrl()}/v1/sessions`).toBe('https://api.aflow.ai/v1/sessions');
  });

  it('falls back to loopback, never to a caller-supplied host', () => {
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });

  it('honours PORT in the loopback fallback', () => {
    process.env['PORT'] = '3100';
    expect(resolveApiBaseUrl()).toBe('http://localhost:3100');
  });

  // Every consumer appends a fixed path, and the realtime route exchanges the
  // scheme, so each of these raw forms builds a URL addressing something else.
  it.each([
    ['an upper-case scheme and host', 'HTTPS://API.Aflow.AI'],
    ['surrounding whitespace', '  https://api.aflow.ai\n'],
    ['a query', 'https://api.aflow.ai?tenant=1'],
    ['a fragment', 'https://api.aflow.ai#frag'],
    ['a path', 'https://api.aflow.ai/base'],
    ['credentials', 'https://user:pass@api.aflow.ai'],
    ['a default port', 'https://api.aflow.ai:443'],
  ])('reduces %s to the canonical origin', (_label, value) => {
    process.env['API_BASE_URL'] = value;
    expect(resolveApiBaseUrl()).toBe('https://api.aflow.ai');
    expect(`${resolveApiBaseUrl()}/v1/sessions`).toBe('https://api.aflow.ai/v1/sessions');
  });

  it('keeps a non-default port', () => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai:8443/';
    expect(resolveApiBaseUrl()).toBe('https://api.aflow.ai:8443');
  });

  // A deployed process never reaches this branch: the startup security check
  // refuses to boot on a value that is not an origin.
  it.each([
    ['no scheme', 'api.aflow.ai'],
    ['a non-HTTP scheme', 'ftp://api.aflow.ai'],
    ['blank', '   '],
  ])('falls back to loopback for a configured value with %s', (_label, value) => {
    process.env['API_BASE_URL'] = value;
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });

  it('canonicalizes the loopback fallback too, so a default port is dropped', () => {
    process.env['PORT'] = '80';
    expect(resolveApiBaseUrl()).toBe('http://localhost');
  });

  it('falls back to the default port when PORT is not a port', () => {
    process.env['PORT'] = 'not-a-port';
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });
});

describe('canonicalApiOrigin', () => {
  it('returns the origin for an absolute http(s) URL', () => {
    expect(canonicalApiOrigin('HTTP://Localhost:3000/base?x=1#y')).toBe('http://localhost:3000');
  });

  it('returns null for anything that is not one', () => {
    expect(canonicalApiOrigin('api.aflow.ai')).toBeNull();
    expect(canonicalApiOrigin('ws://api.aflow.ai')).toBeNull();
    expect(canonicalApiOrigin('javascript:alert(1)')).toBeNull();
    expect(canonicalApiOrigin('')).toBeNull();
  });
});

describe('resolveWebSocketOrigin', () => {
  const originalBase = process.env['API_BASE_URL'];
  const originalPort = process.env['PORT'];

  beforeEach(() => {
    delete process.env['API_BASE_URL'];
    delete process.env['PORT'];
  });

  afterEach(() => {
    if (originalBase === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = originalBase;
    if (originalPort === undefined) delete process.env['PORT'];
    else process.env['PORT'] = originalPort;
  });

  it.each([
    ['https://api.aflow.ai', 'wss://api.aflow.ai'],
    ['HTTPS://API.Aflow.AI/', 'wss://api.aflow.ai'],
    ['https://api.aflow.ai:8443', 'wss://api.aflow.ai:8443'],
    ['http://appliance.lan:3000', 'ws://appliance.lan:3000'],
  ])('addresses %s as %s', (base, expected) => {
    process.env['API_BASE_URL'] = base;
    expect(resolveWebSocketOrigin()).toBe(expected);
  });

  it('carries the loopback fallback', () => {
    expect(`${resolveWebSocketOrigin()}/v1/realtime`).toBe('ws://localhost:3000/v1/realtime');
  });
});
