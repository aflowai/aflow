import { describe, it, expect } from 'vitest';
import { parseWwwAuthenticateResourceMetadata } from './parseWwwAuth.js';

describe('parseWwwAuthenticateResourceMetadata', () => {
  it('returns null for missing / empty headers', () => {
    expect(parseWwwAuthenticateResourceMetadata(null)).toBeNull();
    expect(parseWwwAuthenticateResourceMetadata(undefined)).toBeNull();
    expect(parseWwwAuthenticateResourceMetadata('')).toBeNull();
  });

  it('extracts resource_metadata from a quoted Bearer challenge', () => {
    const url = parseWwwAuthenticateResourceMetadata(
      'Bearer resource_metadata="https://server.example.com/.well-known/oauth-protected-resource"',
    );
    expect(url).toBe('https://server.example.com/.well-known/oauth-protected-resource');
  });

  it('extracts resource_metadata from an unquoted token', () => {
    const url = parseWwwAuthenticateResourceMetadata(
      'Bearer resource_metadata=https://server.example.com/.well-known/oauth-protected-resource',
    );
    expect(url).toBe('https://server.example.com/.well-known/oauth-protected-resource');
  });

  it('tolerates other Bearer params before resource_metadata', () => {
    const url = parseWwwAuthenticateResourceMetadata(
      'Bearer realm="example", error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource"',
    );
    expect(url).toBe('https://x/.well-known/oauth-protected-resource');
  });

  it('finds Bearer challenge among multiple schemes', () => {
    const url = parseWwwAuthenticateResourceMetadata(
      'Digest realm="legacy", Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"',
    );
    expect(url).toBe('https://x/.well-known/oauth-protected-resource');
  });

  it('returns null when Bearer is present but resource_metadata is absent', () => {
    expect(
      parseWwwAuthenticateResourceMetadata('Bearer realm="example", error="invalid_token"'),
    ).toBeNull();
  });

  it('case-insensitive on the scheme name', () => {
    const url = parseWwwAuthenticateResourceMetadata('bearer resource_metadata="https://x/prm"');
    expect(url).toBe('https://x/prm');
  });

  it('case-insensitive on parameter keys', () => {
    const url = parseWwwAuthenticateResourceMetadata('Bearer Resource_Metadata="https://x/prm"');
    expect(url).toBe('https://x/prm');
  });
});
