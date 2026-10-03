/**
 * Canonical operation input/output schemas and registrations.
 *
 * Each operation has a well-defined input and output schema.
 * These are the contracts between flow definitions and executors.
 *
 * Organized by step type:
 * - ai.*       — AI/LLM operations (text, image, video, agent, embed)
 * - api.*      — External API calls
 * - memory.*   — Memory/state operations
 * - user.*     — User interaction operations
 * - search.*   — Search operations
 * - compute.*  — Compute/sandboxed execution
 * - flow.*     — Flow control operations (was flowControl)
 * - platform.* — Platform management operations
 */

export * from './ai.js';
export * from './aiDecision.js';
export * from './api.js';
export * from './memory.js';
export * from './user.js';
export * from './search.js';
export * from './compute.js';
export * from './host.js';
export * from './hostRegistrations.js';
export * from './browser.js';
export * from './browserObservation.js';
export * from './browserProfile.js';
export * from './browserWindow.js';
export * from './agentControl.js';
export * from './platform.js';
export * from './guardrailOps.js';
export * from './ui.js';
export * from './uiArtifactView.js';
export * from './designSystem.js';
export * from './mcp.js';
export * from './workflow.js';
export * from './learner.js';
export * from './learnerLearningResolveCandidate.js';
export * from './learnerLearningResolve.js';
export * from './learnerLearningConsolidate.js';
export * from './proposal.js';
export * from './skill.js';
export * from './capability.js';
export * from './integration.js';
export * from './simulation.js';
export * from './composeSkillOps.js';
export * from './human.js';
export * from './artifactInspect.js';
export * from './code.js';
export * from './store.js';
export * from './evalOps.js';
export * from './evalBatchOps.js';
