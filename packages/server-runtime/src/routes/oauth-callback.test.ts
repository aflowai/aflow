import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSameOriginRedirect } from './oauth-callback.js';

describe('isSameOriginRedirect', () => {
  const originalBase = process.env['API_BASE_URL'];
  beforeEach(() => {
    process.env['API_BASE_URL'] = 'https://api.aflow.ai';
  });
  afterEach(() => {
    if (originalBase === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = originalBase;
  });

  it('accepts absolute paths', () => {
    expect(isSameOriginRedirect('/integrations/mcp')).toBe(true);
    expect(isSameOriginRedirect('/')).toBe(true);
  });

  it('accepts URLs whose origin matches API_BASE_URL', () => {
    expect(isSameOriginRedirect('https://api.aflow.ai/dashboard')).toBe(true);
    expect(isSameOriginRedirect('https://api.aflow.ai/integrations/mcp?bindingId=x')).toBe(true);
  });

  it('rejects cross-origin redirects', () => {
    expect(isSameOriginRedirect('https://attacker.example.com')).toBe(false);
    expect(isSameOriginRedirect('https://api.aflow.com')).toBe(false); // close but no
    expect(isSameOriginRedirect('https://aflow.ai')).toBe(false); // different subdomain
  });

  it('rejects protocol-relative URLs', () => {
    expect(isSameOriginRedirect('//attacker.example.com/x')).toBe(false);
  });

  it('rejects script-y schemes even when URL constructor accepts them', () => {
    expect(isSameOriginRedirect('javascript:alert(1)')).toBe(false);
    expect(isSameOriginRedirect('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSameOriginRedirect('  javascript:alert(1)')).toBe(false);
    expect(isSameOriginRedirect('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSameOriginRedirect('vbscript:msgbox(1)')).toBe(false);
    expect(isSameOriginRedirect('file:///etc/passwd')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isSameOriginRedirect('not a url')).toBe(false);
    expect(isSameOriginRedirect('http://')).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    expect(isSameOriginRedirect('ftp://api.aflow.ai/x')).toBe(false);
  });
});
