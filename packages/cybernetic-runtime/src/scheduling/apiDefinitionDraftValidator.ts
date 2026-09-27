import { DraftApiDefinitionOutputSchema, registerValidator } from '@aflow/schemas';

/**
 * Stable validatorRef for the bind-capability `draft-definition` output.
 *
 * `ApiDefinitionDraftSchema` carries `superRefine`s a JSON-Schema projection
 * cannot express — callMode/auth coherence, and the requirement that every
 * endpoint schema be self-contained. `zod-to-json-schema` drops them, so without
 * this ref the Runner's `submit_output` accepts a draft that the downstream
 * `capability.binding.propose` then rejects, one task hop after the Runner could
 * still have fixed it.
 *
 * Registered on the WRAPPER, not the inner draft: a registered validator is
 * handed the task's whole output, and this task submits
 * `{ apiDefinition: ... }`. Validating the inner schema against the wrapper
 * rejects every valid submission for missing root-level fields — the workflow
 * would never reach propose-binding at all.
 */
export const API_DEFINITION_DRAFT_VALIDATOR_REF = 'capability.api-definition-draft' as const;

// Register at module load. The cybernetic-runtime barrel re-exports this file
// so registration happens once when the orchestrator boots.
registerValidator(API_DEFINITION_DRAFT_VALIDATOR_REF, DraftApiDefinitionOutputSchema);
