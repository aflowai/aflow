/**
 * @aflow/schemas - Canonical schemas for the Aflow platform
 *
 * This package is the source of truth for all platform schemas.
 * All artifacts, runtime structures, and API contracts are defined here.
 *
 * @packageDocumentation
 */

// Re-export Zod for convenience
export { z } from 'zod';

// Artifact schemas (declarative definitions)
export * from './artifact/index.js';

// Runtime schemas (execution-time structures)
export * from './memory/reservedPaths.js';
export * from './runtime/index.js';

// Operation schemas (canonical input/output for each operation)
export * from './operations/index.js';

// Utilities (schema conversion, OpenAPI generation)
export * from './utils/index.js';

// Catalog (operation catalog export and tool catalog generation)
export * from './catalog/index.js';

// Domain models (API definitions, bindings, etc.)
export * from './models/index.js';

// Identity schemas (users, memberships, actor context, audit events)
export * from './identity/index.js';

export * from './eval/index.js';

export * from './guardrails/index.js';

export * from './interop/index.js';

export * from './surface/index.js';

export * from './schedules/index.js';

export * from './credentials/index.js';

export * from './oauth/index.js';

export * from './webhooks/index.js';

export * from './cybernetic/index.js';

export * from './integrations/index.js';

export * from './store/index.js';

export * from './applet/index.js';

export * from './media/index.js';

export * from './background/index.js';

export * from './simulation/index.js';
export * from './edition/index.js';
export * from './modelOutput/cappedText.js';
