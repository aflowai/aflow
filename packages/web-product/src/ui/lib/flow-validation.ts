/**
 * Client-side flow validation — thin wrapper around the shared pipeline
 * in @aflow/schemas.
 *
 * Re-exports the types and delegates to `validateAgentDefinition` so that
 * frontend and backend always use the same validation logic.
 */
export {
  validateAgentDefinition as validateFlow,
  getStepIssues,
  type ValidationIssue,
  type ValidationResult,
  type CatalogEntryForValidation as OperationCatalogEntry,
} from '@aflow/schemas';
