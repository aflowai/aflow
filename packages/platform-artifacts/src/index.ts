// Types
export type {
  PlatformAgentEntry,
  PlatformSkillBundleEntry,
  PlatformSkillManifest,
  PlatformWorkflowDef,
} from './types.js';

// Registry lookups
export {
  getPlatformAgent,
  getPlatformAgentBySystemRole,
  listPlatformAgents,
  getPlatformSkillBundle,
  listPlatformSkillBundles,
  getPlatformWorkflow,
  listPlatformWorkflows,
  getPlatformEvalSuite,
} from './registry.js';

// Reserved key checks (for write guards and UI badges)
export {
  isPlatformAgentId,
  isPlatformSystemRole,
  isPlatformSkillId,
  isPlatformWorkflowSlug,
  isPlatformArtifactId,
  PLATFORM_AGENT_IDS,
  PLATFORM_SYSTEM_ROLES,
  PLATFORM_SKILL_IDS,
  PLATFORM_WORKFLOW_SLUGS,
} from './reservedKeys.js';

// Re-export CapabilityFlowDefinition type for consumers that need it
export type { CapabilityFlowDefinition } from './capabilityAgents.js';

// Direct access to definition arrays (for seed migration / cleanup scripts)
export { CAPABILITY_FLOWS, ML_PREDICTION_AGENT } from './capabilityAgents.js';
export {
  CYBERNETIC_AGENTS,
  CYBERNETIC_SYSTEM_ROLES,
  HELMSMAN_DISCOVERY_PRESET,
  RUNNER_PROMPT_TEMPLATE,
  SHARED_EVIDENCE_DIRECTIVE,
} from './cyberneticAgents.js';
export { composeHelmsmanSurface } from './helmsmanSurface.js';
export type { HelmsmanSurface } from './helmsmanSurface.js';
export { PLATFORM_SKILL_BUNDLES, ALL_PLATFORM_WORKFLOWS } from './skillBundles.js';

export { SKILL_CATALOG, getSkillCatalogEntry, listSkillCatalog } from './skillCatalog.js';

export {
  CONNECTOR_CATALOG,
  getConnectorCatalogEntry,
  listConnectorCatalog,
} from './connectorCatalog/index.js';

export {
  SKILL_BUNDLE_CATALOG,
  getSkillBundleEntry,
  listSkillBundles,
  findUnresolvedSkillCatalogIds,
} from './skillBundleCatalog.js';

export {
  STORE_CATALOG,
  listCatalog,
  getCatalogEntry,
  curatedIntegrationIcon,
  computeStoreCatalogHashes,
} from './storeCatalog/index.js';
export type { ListCatalogFilter, StoreCatalogHashes } from './storeCatalog/index.js';
export { catalogEntryContentHash } from './storeCatalog/contentHash.js';
export { issuerHosts, templateHostPattern } from './storeCatalog/hostManifest.js';
export {
  isListingComposed,
  listingRequiredOperations,
  uncomposedListingReason,
} from './storeCatalog/composedLanes.js';
export { searchCatalog, searchListings } from './storeCatalog/search.js';
export type { StoreSearchOptions, StoreSearchResult } from './storeCatalog/search.js';

export {
  WORK_BOARD_DEFINITION,
  WORK_BOARD_CATALOG_PIN,
  WORK_BOARD_VIEW_SOURCE,
} from './appletFixtures/workBoard.js';
export { CHESS_DEFINITION, CHESS_CATALOG_PIN, CHESS_VIEW_SOURCE } from './appletFixtures/chess.js';
export { FILM_DEFINITION, FILM_CATALOG_PIN, FILM_VIEW_SOURCE } from './appletFixtures/film.js';

export { APPLET_CATALOG } from './appletCatalog/index.js';
export type { AppletCatalogListing } from './appletCatalog/index.js';

export {
  StrategyArchetypeSchema,
  StrategyArchetypePresetSchema,
  STRATEGY_ARCHETYPES,
  getStrategyArchetype,
  listStrategyArchetypes,
  getArchetypePreset,
} from './strategyArchetypes.js';
export type { StrategyArchetype, StrategyArchetypePreset } from './strategyArchetypes.js';
