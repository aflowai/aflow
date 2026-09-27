import { describe, it, expect } from 'vitest';
import type { McpCachedTool } from './mcpServerDefinition.js';
import {
  applyToolFilter,
  toolOpTaskOnly,
  extractUrlOrigin,
  McpElicitationRequestSchema,
} from './mcpServerDefinition.js';

function t(name: string): McpCachedTool {
  return { name, description: `Tool ${name}`, inputSchema: { type: 'object' } };
}

describe('applyToolFilter (definition layer — sole surface gate)', () => {
  it('returns NO tools when no filter is set (opt-in semantics)', () => {
    expect(applyToolFilter([t('a'), t('b'), t('c')], undefined).map((x) => x.name)).toEqual([]);
  });

  it('returns NO tools when include is empty', () => {
    expect(applyToolFilter([t('a'), t('b'), t('c')], { include: [] }).map((x) => x.name)).toEqual(
      [],
    );
  });

  it('returns NO tools when include is absent (even with exclude/opTaskOnly set)', () => {
    expect(
      applyToolFilter([t('a'), t('b'), t('c')], { exclude: ['b'] }).map((x) => x.name),
    ).toEqual([]);
    expect(
      applyToolFilter([t('a'), t('b'), t('c')], { opTaskOnly: ['a'] }).map((x) => x.name),
    ).toEqual([]);
  });

  it('include narrows to the allowlist', () => {
    expect(
      applyToolFilter([t('a'), t('b'), t('c')], { include: ['a', 'c'] }).map((x) => x.name),
    ).toEqual(['a', 'c']);
  });

  it('exclude is applied after include', () => {
    expect(
      applyToolFilter([t('a'), t('b'), t('c')], { include: ['a', 'b'], exclude: ['b'] }).map(
        (x) => x.name,
      ),
    ).toEqual(['a']);
  });

  it('opTaskOnly does NOT filter the surface (metadata only)', () => {
    expect(
      applyToolFilter([t('a'), t('b')], { include: ['a', 'b'], opTaskOnly: ['a'] }).map(
        (x) => x.name,
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('toolOpTaskOnly', () => {
  it('returns false when filter is unset', () => {
    expect(toolOpTaskOnly('delete_dataset', undefined)).toBe(false);
  });

  it('returns false when opTaskOnly is unset', () => {
    expect(toolOpTaskOnly('delete_dataset', { include: ['delete_dataset'] })).toBe(false);
  });

  it('returns true when the tool is in opTaskOnly', () => {
    expect(toolOpTaskOnly('delete_dataset', { opTaskOnly: ['delete_dataset'] })).toBe(true);
  });
});

describe('McpElicitationRequestSchema url mode', () => {
  const base = { mode: 'url', elicitationId: 'e1', message: 'Open this link' };

  it('accepts https URLs', () => {
    const result = McpElicitationRequestSchema.safeParse({
      ...base,
      url: 'https://vendor.example.com/authorize?state=abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts http for localhost and 127.0.0.1 only', () => {
    for (const url of ['http://localhost:3100/consent', 'http://127.0.0.1:8080/consent']) {
      expect(McpElicitationRequestSchema.safeParse({ ...base, url }).success).toBe(true);
    }
  });

  it('rejects plain http to a remote host', () => {
    const result = McpElicitationRequestSchema.safeParse({
      ...base,
      url: 'http://vendor.example.com/authorize',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/x']) {
      expect(McpElicitationRequestSchema.safeParse({ ...base, url }).success).toBe(false);
    }
  });
});

describe('extractUrlOrigin', () => {
  it('returns scheme+host for a URL with default port', () => {
    expect(extractUrlOrigin('https://www.kaggle.com/mcp')).toBe('https://www.kaggle.com');
  });

  it('includes non-default ports', () => {
    expect(extractUrlOrigin('https://mcp.example.com:8443/foo')).toBe(
      'https://mcp.example.com:8443',
    );
  });

  it('strips path + query + fragment', () => {
    expect(extractUrlOrigin('https://mcp.example.com/foo?bar=1#baz')).toBe(
      'https://mcp.example.com',
    );
  });
});
