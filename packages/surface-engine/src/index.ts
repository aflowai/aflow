/**
 * @aflow/surface-engine — Shared surface state management and mutation processing.
 *
 * Used by:
 * - UI executor (server-side validation during generation)
 * - Frontend SurfaceRenderer (client-side state management)
 * - Tests and tooling
 */
export { SurfaceStore, getAtPointer, setAtPointer } from './store.js';
export type { SurfaceState, SurfaceChangeListener } from './store.js';

export { MessageAssembler } from './assembler.js';
export type {
  AssembledMessageCallback,
  AssemblerErrorCallback,
  MessageAssemblerOptions,
} from './assembler.js';

export { SurfaceMutationValidator } from './validator.js';
export type { ValidationResult, ValidationError, ValidationWarning } from './validator.js';

export { buildSurfaceSystemPrompt, buildSurfaceUserPrompt, getSurfaceExample } from './prompt.js';
