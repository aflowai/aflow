import { TaskGraphDraftSchema, registerValidator } from '@aflow/schemas';

/**
 * Stable validatorRef for the compose-skill `draft-task-graph` output.
 *
 * `TaskGraphDraftSchema` carries cross-field `superRefine`s (per-kind grants,
 * optimization-archetype coherence, inputTemplate binds) that a JSON-Schema
 * projection cannot express. Wiring it as the authoritative submit_output
 * validatorRef makes the Runner see every rule in-session instead of failing
 * a downstream task hop.
 */
export const COMPOSE_TASK_GRAPH_DRAFT_VALIDATOR_REF = 'compose.task-graph-draft' as const;

// Register at module load. The cybernetic-runtime barrel re-exports this file
// so registration happens once when the orchestrator boots.
registerValidator(COMPOSE_TASK_GRAPH_DRAFT_VALIDATOR_REF, TaskGraphDraftSchema);
