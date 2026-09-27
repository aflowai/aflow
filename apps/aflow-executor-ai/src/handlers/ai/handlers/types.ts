/**
 * Shared types for AI handlers.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import type { AflowError, TenantId } from '@aflow/schemas';
import type { AsyncJobRepository } from '@aflow/database';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';

export interface HandlerDeps {
  payloadStore: PayloadStore;
  /**
   * Absent when the executor runs without a database. Operations whose provider
   * work outlives the step refuse to submit rather than buy work no row records.
   */
  asyncJobs?: (tenantId: TenantId) => AsyncJobRepository;
  /** Absent when the executor runs without a database — media writes refuse. */
  db?: PostgresJsDatabase;
  /** Absent transport only costs the sidecar its embedding, so writes proceed. */
  redis?: Redis;
  handleError: (ctx: ExecutorContext, label: string, error: unknown) => Promise<StepResult>;
  validateToolArgs: (
    stepId: string,
    args: Record<string, unknown>,
    inputSchema: Record<string, unknown>,
  ) => AflowError | null;
}
