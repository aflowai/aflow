/**
 * First-boot and instance-configuration work, for the executables that run it.
 *
 * Separate from the server's own entry point because a local instance
 * bootstraps and initialises as distinct Compose services, before anything
 * listens.
 */
export { bootstrapLocalEdition } from './localEdition.js';
export { ensureInstanceConfig } from './instanceConfig.js';
export {
  REDIS_ACL_FILENAME,
  renderRedisAcl,
  loadRedisAclIntoRunningServer,
  assertHostGrantOnRunningServer,
  ensureHostIdentityOnRunningServer,
} from './redisAcl.js';
export { findLocalAuthConfigViolations, localOwner } from '../plugins/localInstanceAuth.js';
