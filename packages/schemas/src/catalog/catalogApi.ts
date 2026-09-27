/**
 * Catalog API response types.
 *
 * Shared types for GET /v1/catalog/operations and GET /v1/catalog/step-types.
 * Use these in both server (response validation) and web (typed consumption).
 */
import type { OperationId } from '../runtime/ids.js';
import type { StepType } from '../artifact/operationDefinition.js';

// ============================================================================
// Operation entry (matches server response shape)
// ============================================================================

export interface CatalogOperationResponse {
  operationId: OperationId;
  stepType: StepType;
  displayName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Step config schema — superset of inputSchema for flow-editor config fields */
  stepConfigSchema?: Record<string, unknown>;
  /** Fields managed internally by the orchestrator (hidden from flow editor UI) */
  internalFields?: {
    input?: string[];
    output?: string[];
  };
  /** False for structural runtime primitives that are not agent-callable tools. */
  agentTool?: boolean;
}

// ============================================================================
// Step type entry (matches server response shape)
// ============================================================================

export interface CatalogStepTypeResponse {
  type: StepType;
  displayName: string;
  description: string;
  category: string;
  operations: OperationId[];
}

// ============================================================================
// Response envelopes
// ============================================================================

export interface CatalogOperationsResponse {
  operations: CatalogOperationResponse[];
}

export interface CatalogStepTypesResponse {
  stepTypes: CatalogStepTypeResponse[];
}
