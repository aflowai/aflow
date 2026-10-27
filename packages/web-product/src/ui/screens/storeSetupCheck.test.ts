import { describe, expect, it } from 'vitest';
import { CODE_LANE_ABSENT_CAPABILITY_ID } from '@aflow/schemas';
import { setupCapabilityRemediation } from './storeSetupCheck.js';

describe('setup check capability remediation', () => {
  it('offers no capability remediation when only checklist tasks or broken readiness remain', () => {
    expect(setupCapabilityRemediation([])).toEqual({
      openIntegrations: false,
      editionUnavailable: false,
    });
  });

  it('reports edition availability independently of integration remediation', () => {
    expect(setupCapabilityRemediation([CODE_LANE_ABSENT_CAPABILITY_ID, 'github'])).toEqual({
      openIntegrations: true,
      editionUnavailable: true,
    });
    expect(setupCapabilityRemediation(['github']).editionUnavailable).toBe(false);
  });
});
