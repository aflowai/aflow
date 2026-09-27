import { describe, expect, it } from 'vitest';
import { parseTenantQuotas } from './governance.js';

describe('parseTenantQuotas', () => {
  it('treats an unset column as no quotas (unlimited)', () => {
    expect(parseTenantQuotas(null)).toEqual({});
    expect(parseTenantQuotas(undefined)).toEqual({});
  });

  it('passes a valid maxSpacesPerUser through', () => {
    expect(parseTenantQuotas({ maxSpacesPerUser: 3 })).toEqual({ maxSpacesPerUser: 3 });
  });

  it('strips unknown keys instead of failing', () => {
    expect(parseTenantQuotas({ maxSpacesPerUser: 3, futureKnob: true })).toEqual({
      maxSpacesPerUser: 3,
    });
  });

  it('falls back to unlimited on malformed values — a bad row must not lock anyone out', () => {
    expect(parseTenantQuotas('garbage')).toEqual({});
    expect(parseTenantQuotas({ maxSpacesPerUser: 0 })).toEqual({});
    expect(parseTenantQuotas({ maxSpacesPerUser: 2.5 })).toEqual({});
    expect(parseTenantQuotas({ maxSpacesPerUser: 'three' })).toEqual({});
  });
});
