/**
 * @aflow/database - Database layer for the Aflow platform
 *
 * This package provides:
 * - PostgreSQL connection management
 * - Schema-per-tenant architecture
 * - Drizzle ORM schemas
 * - Repository patterns for data access
 *
 * @packageDocumentation
 */

// Connection management
export {
  type DatabaseConfig,
  getDatabaseConfig,
  getConnection,
  getDatabase,
  closeConnection,
  createDatabase,
} from './connection.js';
export {
  type PoolBuilder,
  type ReplaceablePool,
  createReplaceablePool,
  isAbruptCloseWrite,
  replacePoolsThatLostAConnection,
} from './replaceablePool.js';

// Tenant management
export {
  tenantIdToSchemaName,
  schemaNameToTenantId,
  isValidSchemaName,
  type TenantContext,
  createTenantContext,
  createTenantSchema,
  dropTenantSchema,
  tenantSchemaExists,
  listTenantSchemas,
  withTenantSchema,
  withTenantSchemaRaw,
  applyMigrationsToAllTenants,
  type WorkflowRunDueSource,
  WORKFLOW_RUN_DUE_SOURCES,
  WORKFLOW_RUN_DUE_TABLE,
  WORKFLOW_RUN_DUE_TRIGGER,
  workflowRunDuePointerDdl,
  workflowRunDueTriggerDdl,
  workflowRunDueTriggerNameFor,
  workflowRunDueRecomputeSql,
  workflowRunDueSeedDdl,
  type EvalBatchDueSource,
  EVAL_BATCH_DUE_SOURCES,
  EVAL_BATCH_DUE_TABLE,
  EVAL_BATCH_DUE_TRIGGER,
  evalBatchDuePointerDdl,
  evalBatchDueTriggerDdl,
  evalBatchDueRecomputeSql,
  evalBatchDueSeedDdl,
  SIMULATED_FULFILLMENT_INDEX_NAME,
  SIMULATED_EVENT_PREDICATE,
  SIMULATED_BINDING_EXPRESSION,
  simulatedFulfillmentIndexDdl,
  type TenantDueSource,
  type TenantDuePointer,
  tenantDuePointerDdl,
  tenantDueTriggerDdl,
  tenantDueRecomputeSql,
  tenantDueSeedDdl,
  TENANT_DUE_POINTERS,
  WORKFLOW_RUN_DUE_POINTER,
  SCHEDULE_DUE_POINTER,
  OAUTH_STATE_DUE_POINTER,
  MEMORY_EMBED_DUE_POINTER,
  EVAL_BATCH_DUE_POINTER,
  SCHEDULE_DISPATCH_OUTBOX_TABLE,
  scheduleDispatchOutboxDdl,
  PROJECTION_FAILURES_TABLE,
  projectionFailuresDdl,
  TIMER_DEAD_LETTERS_TABLE,
  timerDeadLettersDdl,
  insertTimerDeadLetter,
  type TimerDeadLetterEntry,
  type CascadeCounts,
  cascadeDeleteSpace,
  previewCascadeForSpace,
  type AccountCascadeCounts,
  type AccountDeletionPlan,
  type AccountSpaceDisposition,
  type AccountTenantPlan,
  type PlanAccountDeletionOptions,
  planAccountDeletion,
  executeAccountDeletion,
  type UserReferencePolicy,
  USER_REFERENCE_POLICY,
  deriveUserReferenceColumns,
  type CatalogGrantArtifactType,
  type CatalogGrantArtifactRef,
  type CatalogHostGrant,
  getCatalogHostGrants,
  listCatalogHostGrants,
  applyTenantMigrations,
} from './tenant.js';

// Database schemas
export * from './schema/index.js';

// Repositories
export * from './repositories/index.js';

// Migrations
export * from './migrations/index.js';

// Seeds
export * from './seeds/index.js';

// Credential encryption
export {
  encryptCredential,
  encryptCredentialEnvelope,
  decryptCredential,
  decryptCredentialAsync,
  credentialNeedsRewrap,
} from './lib/credentials.js';

// KMS (Key Management Service)
export {
  type KmsProvider,
  LocalKmsProvider,
  MigratingKmsProvider,
  localKeyId,
  envelopeEncrypt,
  envelopeDecrypt,
  getKmsProvider,
  setKmsProvider,
  resetKmsProvider,
} from './lib/kms.js';

export { GcpKmsProvider, getGcpKmsConfig, type GcpKmsConfig } from './lib/gcpKms.js';

export {
  type SessionCascadeResult,
  cascadeDeleteSession,
  collectSessionPayloadRefs,
} from './tenant/sessionCascade.js';
export {
  type SessionReferencePolicy,
  type DerivedSessionColumn,
  SESSION_REFERENCE_POLICY,
  deriveSessionReferenceColumns,
} from './tenant/sessionReferencePolicy.js';

export {
  assessPoolHeadroom,
  poolHeadroomWarning,
  serverCapacityDrift,
  OPERATIONAL_CONNECTION_RESERVE,
  SUPERUSER_RESERVED_CONNECTIONS,
  type PoolHeadroom,
} from './poolHeadroom.js';

// Also reachable as `@aflow/database/connection-budget`, which is how the
// production launcher reads it — that entry point must not drag drizzle and
// the Postgres driver in just to size a pool.
export {
  poolPlan,
  poolMaxForService,
  serverMaxConnectionsFromEnv,
  instanceCeilingDrift,
  SERVICE_POOL_WEIGHTS,
  POOLED_FLEET,
  DEFAULT_SERVER_MAX_CONNECTIONS,
  type PoolPlan,
  type PooledHost,
  type PooledService,
} from './connectionBudget.js';
