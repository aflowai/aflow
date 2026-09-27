import { describe, it, expect } from 'vitest';
import { AflowErrorSchema } from './errors.js';
import {
  MCP_CREDENTIALS_UNRESOLVED_CODE,
  mcpCredentialsError,
  isMcpCredentialFailure,
  extractMcpCredentialBlock,
} from './mcpCredentialFailure.js';

describe('mcpCredentialFailure (Plan 182 Task 1)', () => {
  it('mcpCredentialsError builds a schema-valid AflowError with the typed code', () => {
    const err = mcpCredentialsError('Credential "kaggle" not found for binding "b-1"', {
      bindingId: 'b-1',
      serverId: 'kaggle',
      bindingName: 'kaggle-default',
      missingFields: ['apiKey'],
      reason: 'credential_unresolved',
    });
    // Must pass the strict AflowError schema (SCREAMING_SNAKE_CASE code, etc).
    expect(AflowErrorSchema.safeParse(err).success).toBe(true);
    expect(err.code).toBe(MCP_CREDENTIALS_UNRESOLVED_CODE);
    expect(err.classification).toBe('permission');
    expect(err.retryable).toBe(false);
  });

  it('isMcpCredentialFailure matches only the typed code (not free text)', () => {
    expect(isMcpCredentialFailure({ code: MCP_CREDENTIALS_UNRESOLVED_CODE })).toBe(true);
    // A generic provider/validation error — even one whose MESSAGE mentions
    // auth — must NOT be classified as a credential failure.
    expect(isMcpCredentialFailure({ code: 'PROVIDER_ERROR' })).toBe(false);
    expect(isMcpCredentialFailure({ code: 'VALIDATION_ERROR' })).toBe(false);
    expect(isMcpCredentialFailure(null)).toBe(false);
    expect(isMcpCredentialFailure(undefined)).toBe(false);
  });

  it('extractMcpCredentialBlock round-trips the structured block', () => {
    const block = {
      bindingId: 'b-1',
      serverId: 'kaggle',
      bindingName: 'kaggle-default',
      missingFields: ['apiKey'],
      reason: 'credential_unresolved',
    };
    const err = mcpCredentialsError('msg', block);
    expect(extractMcpCredentialBlock(err)).toEqual(block);
  });

  it('extractMcpCredentialBlock returns null for a non-credential error', () => {
    const generic = AflowErrorSchema.parse({
      code: 'PROVIDER_ERROR',
      message: 'tool returned isError=true',
      classification: 'provider',
      retryable: false,
      timestamp: new Date().toISOString(),
    });
    expect(extractMcpCredentialBlock(generic)).toBeNull();
  });
});
