/**
 * Operation catalog module.
 *
 * Provides functions to generate and export operation catalogs
 * in various formats (OperationCatalog JSON, ToolCatalog).
 */

export type * from './catalogApi.js';
export type * from './operationCatalog.js';
export {
  AGENT_SIGNAL_BLOCKED_OPERATION_ID,
  MEMORY_READ_OPERATION_ID,
  RUN_OUTPUT_READ_OPERATION_ID,
  buildOperationId,
  buildGroupId,
  validateSegment,
} from './operationId.js';
export {
  getAllOperations,
  getAllOperationIds,
  getOperationsByStepType,
  getOperationsByGroupId,
  getOperation,
  getAvailableGroups,
  getActionLabels,
  isPrivilegedOperation,
  isEvalPlaneOperation,
  isPlanOperation,
  getOperationCapability,
  deriveCapabilityGroups,
  getDerivedCapabilityGroup,
  getDerivedCapabilityGroupIds,
  getPlatformOperationPrefixes,
  SPACE_POLICY_OPERATION_PREFIXES,
  SPACE_POLICY_RUNS_WHEN_UNSET,
  type DerivedCapabilityGroup,
} from './registry.js';
export {
  getOperationCatalog,
  serializeOperationCatalog,
  getToolCatalog,
  serializeToolCatalog,
  type ToolCatalogStrictness,
  type ToolCatalogOptions,
} from './export.js';
export {
  validateStepInput,
  detectUnresolvedRefs,
  REFERENCE_ROOTS,
  REFERENCE_PATTERN_SOURCE,
  type ReferenceRoot,
  mapZodErrors,
  zodIssueMessage,
  mapZodIssuesToFormErrors,
  compactShapeFromJsonSchema,
  stripNullsRejectedBySchema,
  type StepInputValidationResult,
  type StepInputValidationError,
  type UnresolvedRefError,
} from './validation.js';
export {
  type CapabilityAccessMode,
  type RiskModifier,
  RISK_MODIFIERS,
} from './capabilityGroups.js';
export {
  type CapabilityBundle,
  type CapabilityBundleTier,
  CAPABILITY_BUNDLES,
  getCapabilityBundle,
  bundleForCapabilityGroup,
  bundleForOperation,
  bundlesForSurface,
  capabilityGroupsForBundles,
  shedableBundleIds,
  withGuaranteedReadOps,
  applyBundlePlacements,
  validateBundlePlacements,
  effectivePlacement,
  defaultPlacement,
  MAX_PINNED_TOOLS,
  type ShedableCatalogConfig,
  type CapabilityBundlePlacement,
  type PlacedSurface,
  type PlacementValidation,
} from './capabilityBundles.js';
export {
  type DefinitionType,
  type DefinitionSchemaBundle,
  type DefinitionValidationRuleDescriptor,
  type RuleSeverity,
  DEFINITION_TYPES,
  isDefinitionType,
  buildDefinitionSchemaBundle,
} from './definitionSchemas.js';
export { summarizeStepInput } from './stepDetailSummarizer.js';
export {
  pruneSchemaForAgent,
  buildParamSignature,
  buildCompactEntry,
  buildCompactCatalog,
  buildDetailedCatalog,
  buildSummaryCatalog,
  buildCompactAwareness,
} from './compactFormat.js';
export { buildCoreToolSpec } from './coreToolSpec.js';
export {
  searchCatalog,
  resetSearchIndex,
  type CatalogSearchInput,
  type CatalogSearchResult,
} from './search.js';
export {
  scoreFieldWeightedBM25,
  tokenize,
  tokenizeQuery,
  type Bm25Corpus,
  type Bm25Score,
  type FieldWeightedDocument,
} from './bm25.js';
export { normalizeAgentInput } from './agentInputNormalizer.js';
export { suggestOperations } from './suggestions.js';
export { STEP_TYPE_DESCRIPTIONS, getStepTypeDescription } from './stepTypeDescriptions.js';
export {
  computeSegmentCoverage,
  tokenizeIdentifier,
  COMMON_OP_VERBS,
  type SegmentCoverageResult,
} from './reranking.js';
