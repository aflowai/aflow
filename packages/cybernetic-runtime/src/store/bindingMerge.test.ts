import { describe, it, expect } from 'vitest';
import { extractCredentialKeys } from '../stagedChange/apiWriteHelpers.js';
import { extractMcpCredentialKeys } from '../stagedChange/mcpWriteHelpers.js';
import { mergeBindingAuth } from './bindingMerge.js';

describe('mergeBindingAuth', () => {
  it('keeps the existing auth verbatim when type and slot names match', () => {
    const existing = { type: 'bearer', credentialKey: 'github-default-token', extra: 'kept' };
    const result = mergeBindingAuth({
      existingAuthJson: existing,
      placeholderAuthJson: { type: 'bearer', credentialKey: 'github-default-token' },
      extractCredentialKeys,
    });
    expect(result.reset).toBe(false);
    expect(result.authJson).toBe(existing);
  });

  it('resets when the auth type changed', () => {
    const placeholder = { type: 'bearer', credentialKey: 'x-default-token' };
    const result = mergeBindingAuth({
      existingAuthJson: {
        type: 'basic',
        usernameCredentialKey: 'x-default-username',
        passwordCredentialKey: 'x-default-secret',
      },
      placeholderAuthJson: placeholder,
      extractCredentialKeys,
    });
    expect(result.reset).toBe(true);
    expect(result.authJson).toBe(placeholder);
  });

  it('resets when the credential slot names differ', () => {
    const result = mergeBindingAuth({
      existingAuthJson: { type: 'bearer', credentialKey: 'legacy-token-name' },
      placeholderAuthJson: { type: 'bearer', credentialKey: 'x-default-token' },
      extractCredentialKeys,
    });
    expect(result.reset).toBe(true);
  });

  it('resets when the OAuth issuer changed', () => {
    const result = mergeBindingAuth({
      existingAuthJson: {
        type: 'oauth2_authorization_code',
        issuerKey: 'google',
        ownerScope: 'tenant',
      },
      placeholderAuthJson: {
        type: 'oauth2_authorization_code',
        issuerKey: 'github',
        ownerScope: 'tenant',
      },
      extractCredentialKeys,
    });
    expect(result.reset).toBe(true);
  });

  it('keeps a compatible OAuth profile (same issuer, no slots)', () => {
    const existing = {
      type: 'oauth2_authorization_code',
      issuerKey: 'github',
      ownerScope: 'user',
      clientScope: 'tenant',
    };
    const result = mergeBindingAuth({
      existingAuthJson: existing,
      placeholderAuthJson: {
        type: 'oauth2_authorization_code',
        issuerKey: 'github',
        ownerScope: 'tenant',
        clientScope: 'platform',
      },
      extractCredentialKeys,
    });
    expect(result.reset).toBe(false);
    expect(result.authJson).toBe(existing);
  });

  it('applies the same rule with MCP slot extraction', () => {
    const existing = { type: 'bearer', credentialKey: 'mcp-default-token' };
    expect(
      mergeBindingAuth({
        existingAuthJson: existing,
        placeholderAuthJson: { type: 'bearer', credentialKey: 'mcp-default-token' },
        extractCredentialKeys: extractMcpCredentialKeys,
      }).reset,
    ).toBe(false);
    expect(
      mergeBindingAuth({
        existingAuthJson: existing,
        placeholderAuthJson: { type: 'none' },
        extractCredentialKeys: extractMcpCredentialKeys,
      }).reset,
    ).toBe(true);
  });
});
