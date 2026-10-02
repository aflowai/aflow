export const getGreeting = (name: string) => `Hello, ${name}!`;

export * from './email-templates/index.js';
export * from './bindingScopeResolution.js';
export * from './envMs.js';
export * from './jsonPatch.js';
export * from './restrictedJsonpath.js';
export * from './webBaseUrl.js';
export * from './performanceLogging.js';
export * from './backgroundTask/runner.js';
export * from './leasedWork/consumer.js';
export * from './shutdown.js';

// ============================================================================
// Default AI model IDs (single source of truth)
// ============================================================================
// Generic keys (e.g. 'flash-lite') resolve to the latest version via catalog
// aliases. When a new model version ships, update the alias mapping in
// packages/ai-client/src/catalog.ts — all consumers stay untouched.
//
// Version-pinned keys (e.g. 'flash-lite-3.5') are available for flows that
// need deterministic model selection.
export const DEFAULT_AI_MODELS = {
  text: 'haiku',
  image: 'flash-image',
  video: 'veo',
  embedding: 'text-embedding-3-small',
  decision: 'jev',
} as const;

// ============================================================================
// Model Selection Lists (single source of truth for UI dropdowns & schemas)
// ============================================================================
// These curated lists drive Zod enum schemas, flow editor dropdowns, and
// the get_schema operation output. Each entry MUST be a valid alias or ID
// in the ai-client model catalog.
//
// To add a model to the selection: add it here AND ensure a matching alias
// or ID exists in packages/ai-client/src/catalog.ts.
export const MODEL_SELECTIONS = {
  text: [
    'openai-gpt',
    'openai-mini',
    'anthropic-opus',
    'anthropic-sonnet',
    'anthropic-haiku',
    'google-pro',
    'google-flash',
    'google-flash-lite',
    'openai/gpt-oss-120b',
    'kimi-pro',
    'glm-pro',
    'glm-flash',
    'grok',
  ] as const,
  embedding: ['text-embedding-3-small', 'text-embedding-3-large'] as const,
  decision: ['jev'] as const,
} as const;
