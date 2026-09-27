import { describe, it, expect } from 'vitest';
import { getAuthSlots, isAuthHalfBuilt } from './authSlots.js';
import type { ApiBindingSummary } from '@aflow/web-product/ui';

function makeBinding(auth: Record<string, unknown>): ApiBindingSummary {
  return {
    bindingId: 'test-default',
    apiId: 'test',
    name: 'test',
    description: null,
    scope: {},
    authType: (auth['type'] as string) ?? 'unknown',
    auth,
    credentialKeys: [],
    egressPolicy: {},
    fulfillment: { mode: 'live' as const },
    enabled: true,
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
  };
}

describe('getAuthSlots', () => {
  it('basic produces TWO slots — username + password — that map to the schema fields', () => {
    const slots = getAuthSlots('basic');
    expect(slots.primary?.authField).toBe('usernameCredentialKey');
    expect(slots.secondary?.authField).toBe('passwordCredentialKey');
    expect(slots.primary?.defaultKey('alpaca-default')).toBe('alpaca-default-username');
    expect(slots.secondary?.defaultKey('alpaca-default')).toBe('alpaca-default-secret');
  });

  it('oauth2 produces TWO slots — client-id + client-secret — that map to the schema fields', () => {
    const slots = getAuthSlots('oauth2');
    expect(slots.primary?.authField).toBe('clientIdCredentialKey');
    expect(slots.secondary?.authField).toBe('clientSecretCredentialKey');
    expect(slots.primary?.defaultKey('stripe-default')).toBe('stripe-default-client-id');
    expect(slots.secondary?.defaultKey('stripe-default')).toBe('stripe-default-client-secret');
  });

  it('bearer produces ONE slot mapping to credentialKey', () => {
    const slots = getAuthSlots('bearer');
    expect(slots.primary?.authField).toBe('credentialKey');
    expect(slots.secondary).toBeUndefined();
    expect(slots.primary?.defaultKey('openai-default')).toBe('openai-default-token');
  });

  it('api_key produces ONE slot mapping to credentialKey', () => {
    const slots = getAuthSlots('api_key');
    expect(slots.primary?.authField).toBe('credentialKey');
    expect(slots.secondary).toBeUndefined();
    expect(slots.primary?.defaultKey('anthropic-default')).toBe('anthropic-default-key');
  });

  it('none produces ZERO slots — no credential UI rendered', () => {
    expect(getAuthSlots('none')).toEqual({});
  });

  it('falls back to empty slots for unknown auth types — defensive, never renders garbage inputs', () => {
    expect(getAuthSlots('mtls')).toEqual({});
    expect(getAuthSlots('')).toEqual({});
  });

  it('produces labels distinguishing primary vs secondary roles for basic auth', () => {
    const slots = getAuthSlots('basic');
    // Primary and secondary labels must differ — otherwise the form would
    // render two identical-looking inputs.
    expect(slots.primary?.keyInputLabel).not.toEqual(slots.secondary?.keyInputLabel);
    expect(slots.primary?.secretInputLabel).not.toEqual(slots.secondary?.secretInputLabel);
  });

  it('produces labels distinguishing primary vs secondary roles for oauth2', () => {
    const slots = getAuthSlots('oauth2');
    expect(slots.primary?.keyInputLabel).not.toEqual(slots.secondary?.keyInputLabel);
    expect(slots.primary?.secretInputLabel).not.toEqual(slots.secondary?.secretInputLabel);
  });
});

describe('isAuthHalfBuilt', () => {
  it('flags a basic binding missing passwordCredentialKey', () => {
    const b = makeBinding({
      type: 'basic',
      usernameCredentialKey: 'alpaca-username',
      // passwordCredentialKey deliberately omitted — the bug shape
    });
    expect(isAuthHalfBuilt(b)).toBe(true);
  });

  it('flags a basic binding missing usernameCredentialKey', () => {
    const b = makeBinding({
      type: 'basic',
      passwordCredentialKey: 'alpaca-secret',
    });
    expect(isAuthHalfBuilt(b)).toBe(true);
  });

  it('flags a basic binding missing BOTH credential keys', () => {
    const b = makeBinding({ type: 'basic' });
    expect(isAuthHalfBuilt(b)).toBe(true);
  });

  it('passes a basic binding with BOTH credential keys populated', () => {
    const b = makeBinding({
      type: 'basic',
      usernameCredentialKey: 'alpaca-username',
      passwordCredentialKey: 'alpaca-secret',
    });
    expect(isAuthHalfBuilt(b)).toBe(false);
  });

  it('flags an oauth2 binding missing clientSecretCredentialKey', () => {
    const b = makeBinding({
      type: 'oauth2_client_credentials',
      clientIdCredentialKey: 'stripe-client-id',
    });
    expect(isAuthHalfBuilt(b)).toBe(true);
  });

  it('passes an oauth2 binding with BOTH credential keys populated', () => {
    const b = makeBinding({
      type: 'oauth2_client_credentials',
      clientIdCredentialKey: 'stripe-client-id',
      clientSecretCredentialKey: 'stripe-client-secret',
    });
    expect(isAuthHalfBuilt(b)).toBe(false);
  });

  it('does not flag single-credential auth types — they are not "half-built" by this definition', () => {
    expect(isAuthHalfBuilt(makeBinding({ type: 'bearer', credentialKey: 'token-name' }))).toBe(
      false,
    );
    expect(isAuthHalfBuilt(makeBinding({ type: 'api_key', credentialKey: 'key-name' }))).toBe(
      false,
    );
    expect(isAuthHalfBuilt(makeBinding({ type: 'none' }))).toBe(false);
  });

  it('treats empty-string credential keys as missing', () => {
    // Defensive: an empty string is a legitimate "unset" sentinel; the
    // runtime auth resolver would skip it the same as an absent key.
    const b = makeBinding({
      type: 'basic',
      usernameCredentialKey: 'alpaca-username',
      passwordCredentialKey: '',
    });
    expect(isAuthHalfBuilt(b)).toBe(true);
  });

  it('treats non-string values as missing', () => {
    // Old/corrupt rows could conceivably carry `null` — equivalent to absent.
    const b = makeBinding({
      type: 'basic',
      usernameCredentialKey: 'alpaca-username',
      passwordCredentialKey: null,
    });
    expect(isAuthHalfBuilt(b)).toBe(true);
  });
});
