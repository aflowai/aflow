/**
 * Core services a distribution's routes resolve through.
 */
export {
  INTEGRATION_REQUEST_SCOPE,
  mapIntegrationHostRequestRow,
  resolveIntegrationHostRequest,
} from './integrationHostRequests.js';
export {
  MAX_PENDING_GRANTS_PER_SPACE,
  redeemSpaceGrantsForUser,
  redeemSpaceGrantsForVerifiedEmail,
} from './spaceGrants.js';
