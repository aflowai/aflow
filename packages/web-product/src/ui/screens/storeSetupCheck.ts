import { CODE_LANE_ABSENT_CAPABILITY_ID } from '@aflow/schemas';

export function setupCapabilityRemediation(missingCapabilities: readonly string[]) {
  return {
    openIntegrations: missingCapabilities.some(
      (capability) => capability !== CODE_LANE_ABSENT_CAPABILITY_ID,
    ),
    editionUnavailable: missingCapabilities.includes(CODE_LANE_ABSENT_CAPABILITY_ID),
  };
}
