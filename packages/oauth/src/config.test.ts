import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOAuthCallbackUrl, resolveCimdDocumentUrl } from './config.js';

describe('resolveOAuthCallbackUrl', () => {
  const originalBase = process.env['API_BASE_URL'];
  afterEach(() => {
    if (originalBase === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = originalBase;
  });
  beforeEach(() => {
    delete process.env['API_BASE_URL'];
  });

  it('uses the localhost default when API_BASE_URL is unset', () => {
    expect(resolveOAuthCallbackUrl()).toBe('http://localhost:3000/v1/oauth/callback');
  });

  it('appends the canonical callback path to API_BASE_URL', () => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai';
    expect(resolveOAuthCallbackUrl()).toBe('https://api.aflow.ai/v1/oauth/callback');
  });

  it('strips a trailing slash from API_BASE_URL', () => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai/';
    expect(resolveOAuthCallbackUrl()).toBe('https://api.aflow.ai/v1/oauth/callback');
  });
});

describe('resolveCimdDocumentUrl', () => {
  const originalBase = process.env['API_BASE_URL'];
  afterEach(() => {
    if (originalBase === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = originalBase;
  });
  beforeEach(() => {
    delete process.env['API_BASE_URL'];
  });

  it('returns the .well-known/cimd path against API_BASE_URL', () => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai';
    expect(resolveCimdDocumentUrl()).toBe('https://api.aflow.ai/.well-known/cimd');
  });

  it('strips a trailing slash', () => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai/';
    expect(resolveCimdDocumentUrl()).toBe('https://api.aflow.ai/.well-known/cimd');
  });

  it('and the callback URL share the same base (drift detector)', () => {
    process.env['API_BASE_URL'] = 'https://example.com';
    const cimd = new URL(resolveCimdDocumentUrl());
    const callback = new URL(resolveOAuthCallbackUrl());
    expect(cimd.origin).toBe(callback.origin);
  });
});
