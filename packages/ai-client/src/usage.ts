/**
 * Usage recorder for tracking AI usage and costs.
 */
import { z } from 'zod';
import type { UsageRecord, CostBreakdown, TokenUsage, AIProvider } from './types.js';

// ============================================================================
// Usage Schemas
// ============================================================================

/**
 * Schema for persisted usage records.
 */
export const UsageRecordSchema = z.object({
  /** Unique record ID */
  id: z.string(),
  /** Tenant ID */
  tenantId: z.string(),
  /** Run ID */
  runId: z.string(),
  /** Step execution ID */
  stepExecutionId: z.string(),
  /** Attempt number */
  attempt: z.number().int().positive(),
  /** Provider used */
  provider: z.enum(['openai', 'anthropic', 'google', 'openrouter', 'fireworks', 'xai', 'local']),
  /** Model used */
  model: z.string(),
  /** Token usage */
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
  /** Cost breakdown */
  cost: z.object({
    promptCost: z.number().nonnegative(),
    completionCost: z.number().nonnegative(),
    totalCost: z.number().nonnegative(),
    currency: z.string(),
  }),
  /** Timestamp */
  timestamp: z.string().datetime(),
  /** Provider request ID for tracing */
  providerRequestId: z.string().optional(),
});

/**
 * Schema for usage summary.
 */
export const UsageSummarySchema = z.object({
  /** Total prompt tokens */
  totalPromptTokens: z.number().int().nonnegative(),
  /** Total completion tokens */
  totalCompletionTokens: z.number().int().nonnegative(),
  /** Total tokens */
  totalTokens: z.number().int().nonnegative(),
  /** Total cost */
  totalCost: z.number().nonnegative(),
  /** Currency */
  currency: z.string(),
  /** Number of operations */
  operationCount: z.number().int().nonnegative(),
  /** Breakdown by model */
  byModel: z.record(
    z.string(),
    z.object({
      tokens: z.number().int().nonnegative(),
      cost: z.number().nonnegative(),
      count: z.number().int().nonnegative(),
    }),
  ),
  /** Breakdown by provider */
  byProvider: z.record(
    z.string(),
    z.object({
      tokens: z.number().int().nonnegative(),
      cost: z.number().nonnegative(),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

// ============================================================================
// Budget Configuration
// ============================================================================

/**
 * Budget configuration for cost control.
 */
export interface BudgetConfig {
  /** Maximum cost per step execution (in USD) */
  maxCostPerStep?: number | undefined;
  /** Maximum cost per run (in USD) */
  maxCostPerRun?: number | undefined;
  /** Maximum cost per tenant per day (in USD) */
  maxCostPerTenantPerDay?: number | undefined;
  /** Maximum tokens per step execution */
  maxTokensPerStep?: number | undefined;
  /** Action when budget exceeded */
  onBudgetExceeded: 'abort' | 'warn' | 'log';
}

/**
 * Budget check result.
 */
export interface BudgetCheckResult {
  /** Whether the budget allows this operation */
  allowed: boolean;
  /** Reason if not allowed */
  reason?: string | undefined;
  /** Current usage */
  currentUsage: {
    stepCost: number;
    runCost: number;
    tenantDailyCost: number;
    stepTokens: number;
  };
  /** Remaining budget */
  remaining: {
    stepCost: number | null;
    runCost: number | null;
    tenantDailyCost: number | null;
    stepTokens: number | null;
  };
}

// ============================================================================
// Usage Recorder Interface
// ============================================================================

/**
 * Usage recorder for tracking AI operations.
 */
export interface UsageRecorder {
  /**
   * Record a usage event.
   */
  record(record: UsageRecord): void;

  /**
   * Get all recorded usage.
   */
  getRecords(): UsageRecord[];

  /**
   * Get records for a specific step execution.
   */
  getRecordsForStep(stepExecutionId: string): UsageRecord[];

  /**
   * Get records for a specific tenant.
   */
  getRecordsForTenant(tenantId: string): UsageRecord[];

  /**
   * Get records for a specific run.
   */
  getRecordsForRun(runId: string): UsageRecord[];

  /**
   * Clear all records.
   */
  clear(): void;

  /**
   * Get total cost for a step execution.
   */
  getTotalCostForStep(stepExecutionId: string): number;

  /**
   * Get total cost for a tenant.
   */
  getTotalCostForTenant(tenantId: string): number;

  /**
   * Get total cost for a run.
   */
  getTotalCostForRun(runId: string): number;

  /**
   * Get usage summary for a step execution.
   */
  getSummaryForStep(stepExecutionId: string): UsageSummary;

  /**
   * Get usage summary for a run.
   */
  getSummaryForRun(runId: string): UsageSummary;

  /**
   * Check budget before an operation.
   */
  checkBudget(params: {
    tenantId: string;
    runId: string;
    stepExecutionId: string;
    estimatedCost: number;
    estimatedTokens: number;
    budgetConfig: BudgetConfig;
  }): BudgetCheckResult;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build usage summary from records.
 */
function buildSummary(records: UsageRecord[]): UsageSummary {
  const byModel: Record<string, { tokens: number; cost: number; count: number }> = {};
  const byProvider: Record<string, { tokens: number; cost: number; count: number }> = {};

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCost = 0;

  for (const r of records) {
    totalPromptTokens += r.usage.promptTokens;
    totalCompletionTokens += r.usage.completionTokens;
    totalCost += r.cost.totalCost;

    // By model
    let modelEntry = byModel[r.model];
    if (!modelEntry) {
      modelEntry = { tokens: 0, cost: 0, count: 0 };
      byModel[r.model] = modelEntry;
    }
    modelEntry.tokens += r.usage.totalTokens;
    modelEntry.cost += r.cost.totalCost;
    modelEntry.count += 1;

    // By provider
    let providerEntry = byProvider[r.provider];
    if (!providerEntry) {
      providerEntry = { tokens: 0, cost: 0, count: 0 };
      byProvider[r.provider] = providerEntry;
    }
    providerEntry.tokens += r.usage.totalTokens;
    providerEntry.cost += r.cost.totalCost;
    providerEntry.count += 1;
  }

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    totalCost,
    currency: 'USD',
    operationCount: records.length,
    byModel,
    byProvider,
  };
}

// ============================================================================
// In-Memory Usage Recorder
// ============================================================================

/**
 * Create an in-memory usage recorder.
 * For production, this should be replaced with a durable storage backend.
 */
export function createUsageRecorder(): UsageRecorder {
  const records: UsageRecord[] = [];

  return {
    record(record) {
      records.push(record);
    },

    getRecords() {
      return [...records];
    },

    getRecordsForStep(stepExecutionId) {
      return records.filter((r) => r.stepExecutionId === stepExecutionId);
    },

    getRecordsForTenant(tenantId) {
      return records.filter((r) => r.tenantId === tenantId);
    },

    getRecordsForRun(runId) {
      return records.filter((r) => r.runId === runId);
    },

    clear() {
      records.length = 0;
    },

    getTotalCostForStep(stepExecutionId) {
      return this.getRecordsForStep(stepExecutionId).reduce((sum, r) => sum + r.cost.totalCost, 0);
    },

    getTotalCostForTenant(tenantId) {
      return this.getRecordsForTenant(tenantId).reduce((sum, r) => sum + r.cost.totalCost, 0);
    },

    getTotalCostForRun(runId) {
      return this.getRecordsForRun(runId).reduce((sum, r) => sum + r.cost.totalCost, 0);
    },

    getSummaryForStep(stepExecutionId) {
      return buildSummary(this.getRecordsForStep(stepExecutionId));
    },

    getSummaryForRun(runId) {
      return buildSummary(this.getRecordsForRun(runId));
    },

    checkBudget(params) {
      const { tenantId, runId, stepExecutionId, estimatedCost, estimatedTokens, budgetConfig } =
        params;

      const stepRecords = this.getRecordsForStep(stepExecutionId);
      const runRecords = this.getRecordsForRun(runId);
      const tenantRecords = this.getRecordsForTenant(tenantId);

      // Calculate current usage
      const stepCost = stepRecords.reduce((sum, r) => sum + r.cost.totalCost, 0);
      const runCost = runRecords.reduce((sum, r) => sum + r.cost.totalCost, 0);
      const stepTokens = stepRecords.reduce((sum, r) => sum + r.usage.totalTokens, 0);

      // Calculate tenant daily cost (last 24 hours)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const tenantDailyCost = tenantRecords
        .filter((r) => r.timestamp > oneDayAgo)
        .reduce((sum, r) => sum + r.cost.totalCost, 0);

      const currentUsage = { stepCost, runCost, tenantDailyCost, stepTokens };

      // Calculate remaining budgets
      const remaining = {
        stepCost:
          budgetConfig.maxCostPerStep !== undefined ? budgetConfig.maxCostPerStep - stepCost : null,
        runCost:
          budgetConfig.maxCostPerRun !== undefined ? budgetConfig.maxCostPerRun - runCost : null,
        tenantDailyCost:
          budgetConfig.maxCostPerTenantPerDay !== undefined
            ? budgetConfig.maxCostPerTenantPerDay - tenantDailyCost
            : null,
        stepTokens:
          budgetConfig.maxTokensPerStep !== undefined
            ? budgetConfig.maxTokensPerStep - stepTokens
            : null,
      };

      // Check budget violations
      const violations: string[] = [];

      if (
        budgetConfig.maxCostPerStep !== undefined &&
        stepCost + estimatedCost > budgetConfig.maxCostPerStep
      ) {
        violations.push(
          `Step cost ($${stepCost.toFixed(4)} + $${estimatedCost.toFixed(4)}) exceeds limit ($${budgetConfig.maxCostPerStep.toFixed(4)})`,
        );
      }

      if (
        budgetConfig.maxCostPerRun !== undefined &&
        runCost + estimatedCost > budgetConfig.maxCostPerRun
      ) {
        violations.push(
          `Run cost ($${runCost.toFixed(4)} + $${estimatedCost.toFixed(4)}) exceeds limit ($${budgetConfig.maxCostPerRun.toFixed(4)})`,
        );
      }

      if (
        budgetConfig.maxCostPerTenantPerDay !== undefined &&
        tenantDailyCost + estimatedCost > budgetConfig.maxCostPerTenantPerDay
      ) {
        violations.push(
          `Tenant daily cost ($${tenantDailyCost.toFixed(4)} + $${estimatedCost.toFixed(4)}) exceeds limit ($${budgetConfig.maxCostPerTenantPerDay.toFixed(4)})`,
        );
      }

      if (
        budgetConfig.maxTokensPerStep !== undefined &&
        stepTokens + estimatedTokens > budgetConfig.maxTokensPerStep
      ) {
        violations.push(
          `Step tokens (${String(stepTokens)} + ${String(estimatedTokens)}) exceeds limit (${String(budgetConfig.maxTokensPerStep)})`,
        );
      }

      return {
        allowed: violations.length === 0,
        reason: violations.length > 0 ? violations.join('; ') : undefined,
        currentUsage,
        remaining,
      };
    },
  };
}

// ============================================================================
// Usage Record Builder
// ============================================================================

/**
 * Build a usage record from operation details.
 */
export function buildUsageRecord(params: {
  tenantId: string;
  runId: string;
  stepExecutionId: string;
  attempt: number;
  provider: AIProvider;
  model: string;
  usage: TokenUsage;
  cost: CostBreakdown;
  providerRequestId?: string;
}): UsageRecord {
  return {
    id: `usage_${String(Date.now())}_${Math.random().toString(36).slice(2, 11)}`,
    tenantId: params.tenantId,
    runId: params.runId,
    stepExecutionId: params.stepExecutionId,
    attempt: params.attempt,
    provider: params.provider,
    model: params.model,
    usage: params.usage,
    cost: params.cost,
    timestamp: new Date().toISOString(),
    providerRequestId: params.providerRequestId,
  };
}
