import { describe, it, expect } from 'vitest';
import {
  parseRbacInvalidationMessage,
  rbacKeysForInvalidation,
  RBAC_TENANT_CACHE_PREFIX,
  RBAC_SPACE_CACHE_PREFIX,
  type RbacInvalidationMessage,
} from './cache.js';

describe('parseRbacInvalidationMessage', () => {
  it('parses a valid tenant-only message', () => {
    const raw = JSON.stringify({ userId: 'u1', tenantId: 't1' });
    const result = parseRbacInvalidationMessage(raw);
    expect(result).toEqual({ userId: 'u1', tenantId: 't1' });
    // spaceId should be absent, not undefined (exactOptionalPropertyTypes)
    expect('spaceId' in result!).toBe(false);
  });

  it('parses a valid message with spaceId', () => {
    const raw = JSON.stringify({ userId: 'u1', tenantId: 't1', spaceId: 's1' });
    const result = parseRbacInvalidationMessage(raw);
    expect(result).toEqual({ userId: 'u1', tenantId: 't1', spaceId: 's1' });
  });

  it('rejects a non-JSON string', () => {
    expect(parseRbacInvalidationMessage('u1:t1')).toBeNull();
  });

  it('rejects JSON missing required fields', () => {
    expect(parseRbacInvalidationMessage(JSON.stringify({ userId: 'u1' }))).toBeNull();
    expect(parseRbacInvalidationMessage(JSON.stringify({ tenantId: 't1' }))).toBeNull();
    expect(parseRbacInvalidationMessage(JSON.stringify({}))).toBeNull();
  });

  it('rejects JSON with wrong field types', () => {
    expect(parseRbacInvalidationMessage(JSON.stringify({ userId: 1, tenantId: 't1' }))).toBeNull();
  });

  it('ignores extra fields', () => {
    const raw = JSON.stringify({ userId: 'u1', tenantId: 't1', extra: true });
    const result = parseRbacInvalidationMessage(raw);
    expect(result).toEqual({ userId: 'u1', tenantId: 't1' });
  });
});

describe('rbacKeysForInvalidation', () => {
  it('returns tenant key + space pattern for broad invalidation (no spaceId)', () => {
    const msg: RbacInvalidationMessage = { userId: 'u1', tenantId: 't1' };
    const { exact, patterns } = rbacKeysForInvalidation(msg);

    expect(exact).toEqual([`${RBAC_TENANT_CACHE_PREFIX}:u1:t1`]);
    expect(patterns).toEqual([`${RBAC_SPACE_CACHE_PREFIX}:u1:t1:*`]);
  });

  it('returns tenant key + specific space key for targeted invalidation', () => {
    const msg: RbacInvalidationMessage = { userId: 'u1', tenantId: 't1', spaceId: 's1' };
    const { exact, patterns } = rbacKeysForInvalidation(msg);

    expect(exact).toEqual([
      `${RBAC_TENANT_CACHE_PREFIX}:u1:t1`,
      `${RBAC_SPACE_CACHE_PREFIX}:u1:t1:s1`,
    ]);
    expect(patterns).toEqual([]);
  });

  it('produces keys consistent with getCachedTenantRole/getCachedSpaceRole key format', () => {
    // The exact keys must match what the get/set functions use
    const msg: RbacInvalidationMessage = {
      userId: 'user-abc',
      tenantId: 'tenant-xyz',
      spaceId: 'space-123',
    };
    const { exact } = rbacKeysForInvalidation(msg);

    expect(exact[0]).toBe('aflow:rbac:tenant:user-abc:tenant-xyz');
    expect(exact[1]).toBe('aflow:rbac:space:user-abc:tenant-xyz:space-123');
  });
});
