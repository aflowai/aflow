import { describe, it, expect } from 'vitest';

import { isAllowedFieldOrigin, type CredentialField } from './provider.js';
import { getProviderDefinition } from './registry.js';

const BASE_URL_FIELD: CredentialField = {
  fieldId: 'base_url',
  label: 'Base URL',
  type: 'url',
  required: false,
  allowedOrigins: ['https://api.z.ai'],
};

describe('isAllowedFieldOrigin', () => {
  it('accepts the provider origin, path and query notwithstanding', () => {
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'https://api.z.ai/api/anthropic')).toBe(true);
  });

  it('refuses an arbitrary public host', () => {
    // The whole attack: a credential writer who has never seen the key points it
    // at a host they control and receives it on the next run.
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'https://attacker.example')).toBe(false);
  });

  it('refuses a lookalike that only shares a prefix or suffix', () => {
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'https://api.z.ai.evil.com')).toBe(false);
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'https://evil.com/api.z.ai')).toBe(false);
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'https://notapi.z.ai')).toBe(false);
  });

  it('refuses the same host over plaintext, and a credentialed authority', () => {
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'http://api.z.ai')).toBe(false);
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'https://user:pw@api.z.ai')).toBe(false);
  });

  it('refuses a value that is not a URL at all', () => {
    expect(isAllowedFieldOrigin(BASE_URL_FIELD, 'not-a-url')).toBe(false);
  });

  it('accepts an origin the deployment operator added', () => {
    // The escape hatch for a corporate gateway — operator configuration, never a
    // tenant admin through the API.
    expect(
      isAllowedFieldOrigin(BASE_URL_FIELD, 'https://gateway.corp.internal/v1', [
        'https://gateway.corp.internal',
      ]),
    ).toBe(true);
  });

  it('leaves fields that constrain nothing alone', () => {
    const free: CredentialField = {
      fieldId: 'region',
      label: 'Region',
      type: 'text',
      required: false,
    };
    expect(isAllowedFieldOrigin(free, 'anything at all')).toBe(true);
  });

  it("constrains the registry's zai base_url, the only url field that exists", () => {
    const field = getProviderDefinition('zai')?.fields.find((f) => f.fieldId === 'base_url');
    expect(field?.allowedOrigins).toEqual(['https://api.z.ai']);
  });
});
