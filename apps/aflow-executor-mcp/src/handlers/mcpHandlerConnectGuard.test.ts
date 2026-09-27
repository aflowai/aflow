import { describe, it, expect } from 'vitest';
import { McpHandler } from './mcpHandler.js';
import type { PoolEntry } from './connectionPool.js';
import type { McpTenantGuardRef } from './tenantPolicyGuard.js';

interface PrivateAccess {
  acquireManaged(
    key: string,
    serverUrl: string,
    headers: Record<string, string>,
    guard: McpTenantGuardRef | null,
  ): Promise<PoolEntry>;
}

const acquireManaged = (serverUrl: string, headers: Record<string, string>): Promise<PoolEntry> =>
  (new McpHandler({}) as unknown as PrivateAccess).acquireManaged(
    'key-1',
    serverUrl,
    headers,
    null,
  );

describe('acquireManaged SSRF guard', () => {
  it('rejects a loopback serverUrl before any connect', async () => {
    await expect(acquireManaged('https://127.0.0.1/mcp', {})).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
  });

  it('rejects the cloud metadata host', async () => {
    await expect(acquireManaged('https://169.254.169.254/mcp', {})).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
  });

  it('rejects a private-range serverUrl', async () => {
    await expect(acquireManaged('https://10.1.2.3/mcp', {})).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
  });

  it('rejects http when credential headers ride the connect', async () => {
    await expect(
      acquireManaged('http://8.8.8.8/mcp', { Authorization: 'Bearer tok' }),
    ).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-protocol',
    });
  });

  it('still blocks private hosts on credential-less http connects', async () => {
    await expect(acquireManaged('http://127.0.0.1/mcp', {})).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'private-ip',
    });
  });

  it('rejects a malformed serverUrl', async () => {
    await expect(acquireManaged('not-a-url', {})).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      kind: 'invalid-url',
    });
  });
});
