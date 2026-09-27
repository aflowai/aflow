/**
 * Canonical step type descriptions — single source of truth.
 *
 * Used by:
 *   - Server catalog API (GET /v1/catalog/step-types)
 *   - Orchestrator inline ops (catalog.tool.list directory mode)
 *   - Compact awareness block (buildCompactAwareness)
 *   - Web UI (CatalogPickers step type metadata)
 *
 * Keep these concise but informative — they appear in agent context blocks
 * and drive the compact awareness format (~200 tokens target).
 */

/**
 * Human-readable descriptions for each step type.
 * Keys match StepTypeSchema values in artifact/operationDefinition.ts.
 */
export const STEP_TYPE_DESCRIPTIONS: Record<string, string> = {
  ai: 'AI generation — text, structured JSON, media (images, video, animation), embeddings',
  api: 'External API integration — call endpoints, manage API definitions, bindings, webhooks',
  memory: 'Persistent document store — read, write, query, vector search',
  compute: 'Sandboxed code execution — run Python, Node.js, Bash, or Deno in isolated containers',
  search: 'Web search and page fetching — find information and retrieve web page content',
  agent: 'Agent management and session control — CRUD for definitions, delegation, scheduling',
  user: 'Human-in-the-loop — request input, approval, send notifications',
  eval: 'Evaluation management — create test suites, run evaluations, compare results',
  guardrail: 'Safety guardrails — manage content policies and inspect violations',
  ui: 'Generative UI — interactive artifacts, streaming surfaces, design system catalog',
  mcp: 'External tool servers — call tools on remote MCP (Model Context Protocol) servers',
  catalog: 'Platform introspection — discover available operations and their schemas',
  space: 'Workspace management — create and manage spaces, rules, compute policies',
  workflow: 'Structured workflows — outcomes, tasks, runs, learnings, evaluations',
  integration: 'External-service registry — list and look up bound API/MCP integrations',
  code: 'Coding-agent execution lane — run a managed coding harness over a real git checkout, returns a patch bundle',
};

/**
 * Get the description for a step type, with a sensible fallback.
 */
export function getStepTypeDescription(stepType: string): string {
  return STEP_TYPE_DESCRIPTIONS[stepType] ?? `${stepType} operations`;
}
