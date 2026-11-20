import { describe, it, expect } from 'vitest';
import { defaultClientScopeOptions } from './defaultClientScopeOptions.js';

const values = (edition: 'community-local' | 'enterprise') =>
  defaultClientScopeOptions(edition).map((option) => option.value);

describe('the Default OAuth app choices by edition', () => {
  it('offers only Tenant in the local edition', () => {
    // Local bootstrap moves a stored default onto Tenant on every start. That
    // undoes no operator choice only while this list offers nothing else.
    expect(values('community-local')).toEqual(['tenant']);
  });

  it('offers every client scope in the hosted edition', () => {
    expect(values('enterprise')).toEqual(['platform', 'tenant', 'space']);
  });
});
