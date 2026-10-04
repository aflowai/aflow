import type { IconName } from '@aflow/design-system';

/**
 * Canonical operation-ID → user-facing action label.
 *
 * Keyed by the platform's `{stepType}.{group}.{verb}` operation IDs
 * (see `packages/schemas/src/catalog/`).
 */
export const ACTION_LABELS: Record<string, string> = {
  // AI (canonical 3-segment IDs)
  'ai.text.generate': 'Generating text…',
  'ai.text.generate_json': 'Generating structured output…',
  'ai.text.generate_stream': 'Generating text…',
  'ai.embedding.generate': 'Embedding…',
  'ai.agent.turn': 'Working…',
  'ai.media.image': 'Generating image…',
  'ai.media.edit_image': 'Editing image…',
  'ai.media.video': 'Generating video…',
  'ai.media.animate': 'Generating video…',
  // Memory
  'memory.store.query': 'Searching memory…',
  'memory.store.get': 'Reading memory…',
  'memory.store.put': 'Saving to memory…',
  'memory.patch': 'Updating memory…',
  // API + MCP — direct substrate calls. The normal path is `catalog.tool.promote`
  // followed by the promoted-tool native call, which renders an integration-aware
  'api.http.call': 'Calling API…',
  'mcp.tool.call': 'Calling MCP tool…',
  // User
  'user.interaction.ask': 'Waiting for input…',
  'user.interaction.approve': 'Waiting for approval…',
  // Search
  'search.web': 'Searching the web…',
  'search.web.search': 'Searching the web…',
  'search.web.fetch': 'Fetching page…',
  // Compute
  'compute.sandbox.exec': 'Running code…',
  // Coding lane (Plan 219) — code.agent.run always carries a live phase detail,
  // so its label reads as a constant head with the phase appended.
  'code.agent.run': 'Coding agent',
  'code.repo.push': 'Pushing branch…',
  'code.repo.describe': 'Resolving repo…',
  // Agent control
  'agent.control.dispatch': 'Dispatching…',
  'agent.control.delegate': 'Delegating…',
  'agent.control.abort': 'Aborting…',
  'agent.control.end': 'Finishing…',
  'agent.control.run_step': 'Running step…',
};

export { THINKING_CLASS_OPS } from '@aflow/run-view';

/**
 * Canonical operation-ID → design-system icon name. Lets surfaces show
 * *what kind of work* a step is at a glance (a globe for an API call, a
 * terminal for code, a database for memory) independently of the
 * lifecycle marker. Keyed by the same `{stepType}.{group}.{verb}` IDs as
 * `ACTION_LABELS`. Resolve via `resolveActionIcon()`.
 */
export const ACTION_ICONS: Record<string, IconName> = {
  'ai.text.generate': 'text-t',
  'ai.text.generate_json': 'file-code',
  'ai.text.generate_stream': 'text-t',
  'ai.embedding.generate': 'cube',
  // An agent turn is a decision step — it carries the generic agent mark
  // (robot), the single glyph used wherever an agent is referenced.
  'ai.agent.turn': 'robot',
  'ai.media.image': 'image',
  'ai.media.edit_image': 'image',
  'ai.media.video': 'video',
  'ai.media.animate': 'video',
  'memory.store.query': 'database',
  'memory.store.get': 'database',
  'memory.store.put': 'database',
  'memory.patch': 'database',
  'api.http.call': 'globe',
  'mcp.tool.call': 'plugs-connected',
  'user.interaction.ask': 'chat-dots',
  // A human-approval row's icon identifies the family (a person decides); the
  // outcome is read from the resolved-decision pill + row status, so a tick
  // here would be redundant (and wrong on a rejected row). Keep the neutral
  // person icon. `ask` keeps `chat-dots` — an input request has no decision
  // pill, so the "you're being asked something" cue still earns its place.
  'user.interaction.approve': 'user',
  'search.web': 'magnifying-glass',
  'search.web.search': 'magnifying-glass',
  'search.web.fetch': 'globe',
  'compute.sandbox.exec': 'terminal',
  // The coding lane runs a Claude Code session as a task, so it carries the
  // Claude brand mark rather than the generic `code` (</>) glyph. Other
  // `code.*` ops (repo.push/describe) stay on the `code` step-type fallback.
  'code.agent.run': 'claude',
  'agent.control.dispatch': 'git-branch',
  'agent.control.delegate': 'git-branch',
  'agent.control.abort': 'flag',
  'agent.control.end': 'flag',
  'agent.control.run_step': 'git-branch',
  // Workflow/skill ops — `workflow` step-type default below covers the rest;
  // `workflow.learn` reads as "recording a learning", so a more specific
  // book overrides the generic orchestration icon.
  'workflow.learn': 'book',
};

/**
 * Icon fallback per step type — the second tier of the layered op→icon
 * mapper. A `{stepType}.{group}.{verb}` op with no exact `ACTION_ICONS`
 * entry resolves by its first segment here, so a whole step-type family
 * gets a sensible icon and only the ones worth distinguishing need an exact
 * override above. Keys mirror the catalog's registered `stepType` values;
 * keep this in sync when a new step type is added (the generic `cube` is the
 * last resort, and a step type sitting on `cube` is the signal it's missing).
 */
const STEP_TYPE_ICON_FALLBACKS: Record<string, IconName> = {
  ai: 'robot',
  agent: 'robot',
  memory: 'database',
  api: 'globe',
  mcp: 'plugs-connected',
  integration: 'plugs',
  user: 'user',
  human: 'user',
  search: 'magnifying-glass',
  compute: 'terminal',
  code: 'code',
  flow: 'git-branch',
  workflow: 'git-branch',
  skill: 'skill',
  learner: 'stethoscope',
  eval: 'scales',
  proposal: 'lightbulb',
  guardrail: 'shield-check',
  space: 'buildings',
  capability: 'key',
  catalog: 'list-magnifying-glass',
  artifact: 'file',
  platform: 'gear',
  ui: 'cube',
  design_system: 'cube',
};

/**
 * Resolve the best icon for a step. Mirrors `resolveActionLabel`'s
 * priority: operation-specific → step-type fallback → generic `cube`.
 */
export function resolveActionIcon(
  operationId: string | undefined,
  stepType: string | undefined,
): IconName {
  if (operationId) {
    const icon = ACTION_ICONS[operationId];
    if (icon) return icon;
    const derivedType = operationId.split('.')[0];
    if (derivedType) {
      const fallback = STEP_TYPE_ICON_FALLBACKS[derivedType];
      if (fallback) return fallback;
    }
  }
  if (stepType) {
    const fallback = STEP_TYPE_ICON_FALLBACKS[stepType];
    if (fallback) return fallback;
  }
  return 'cube';
}

/**
 * Minimal task shape the surface needs to resolve an icon. A workflow task
 * lowers into exactly one dispatch family; only `agent` / `operation` tasks
 * carry an `operationId`, so `human` tasks borrow the icon of the matching
 * `user.interaction.*` op (the family they're semantically equivalent to).
 */
export interface TaskIconInput {
  taskType?: 'agent' | 'operation' | 'human' | undefined;
  humanIntent?: 'approve' | 'collect' | undefined;
  operationId?: string | undefined;
}

/**
 * Resolve the canonical op id used to look up a task's icon. Keeps the icon
 * resolution **purely op-based** (one configurable `ACTION_ICONS` /
 * `STEP_TYPE_ICON_FALLBACKS` mapper, no bespoke per-task icon table):
 *
 *   - `agent` / `operation` tasks already record their dispatch op
 *     (`ai.agent.turn` / the real op id) — use it directly.
 *   - `human` tasks record no op, so map to the registered user-interaction
 *     op whose icon already fits: approve → `user.interaction.approve`,
 *     collect (or unspecified) → `user.interaction.ask`.
 *
 * Returns `undefined` only when nothing identifies the task (e.g. a recorded
 * row from before `taskType` was carried), which falls through to `cube`.
 */
export function iconOpIdForTask(task: TaskIconInput): string | undefined {
  if (task.operationId) return task.operationId;
  if (task.taskType === 'human') {
    return task.humanIntent === 'approve' ? 'user.interaction.approve' : 'user.interaction.ask';
  }
  return undefined;
}

/**
 * Resolve a workflow task-row icon through the same layered op→icon mapper as
 * every other surface (`resolveActionIcon`). The only task-specific step is
 * picking the lookup op id (`iconOpIdForTask`); the mapper itself stays the
 * single place to add or override icons.
 */
export function resolveTaskIcon(task: TaskIconInput): IconName {
  return resolveActionIcon(iconOpIdForTask(task), undefined);
}

const THINKING_VERBS: readonly string[] = [
  'Working…',
  'Thinking…',
  'Pondering…',
  'Mulling it over…',
  'Reasoning…',
  'Processing…',
  'Considering…',
  'Reflecting…',
  'Deliberating…',
  'Analyzing…',
  'Synthesizing…',
  'Weighing options…',
  'Connecting the dots…',
  'Figuring it out…',
  'Sussing it out…',
  'Piecing it together…',
  'Wrangling thoughts…',
  'Following the thread…',
  'Chewing on it…',
  'Sketching it out…',
  'Untangling…',
  'Iterating…',
  'Computing…',
  'Crunching…',
];

/**
 * Deterministic verb pick for a given `(taskId, sequence)` pair. Stable
 * across re-renders (so the subline doesn't flicker between verbs within
 * a single thinking phase), varies across phases (a fresh `sequence`
 * picks a different verb). Uses a small FNV-1a hash for distribution;
 * the verb count is small enough that hash quality doesn't matter much.
 */
export function pickThinkingVerb(taskId: string, sequence: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < taskId.length; i++) {
    hash ^= taskId.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  hash ^= sequence;
  hash = (hash * 0x01000193) >>> 0;
  return THINKING_VERBS[hash % THINKING_VERBS.length] ?? 'Working…';
}

/** Fallback labels per step type when `operationId` is unknown/missing. */
export const STEP_TYPE_FALLBACKS: Record<string, string> = {
  ai: 'AI processing…',
  memory: 'Accessing memory…',
  api: 'Calling API…',
  user: 'Waiting for user…',
  search: 'Searching…',
  compute: 'Running code…',
  flow: 'Orchestrating…',
  platform: 'Managing platform…',
  ui: 'Building UI…',
  design_system: 'Consulting design system…',
};

const HUMANIZED_TOKEN_OVERRIDES: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  ui: 'UI',
};

/**
 * Humanize a dotted/underscored identifier (e.g. an operationId or stepType)
 * into a Title-Case label, with overrides for common acronyms (AI, API, UI).
 */
export function humanizeToken(value: string): string {
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      const override = HUMANIZED_TOKEN_OVERRIDES[lower];
      if (override) return override;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

/** What a step parked on its missing executor is waiting for. */
export function executorWaitLabel(stepType: string | undefined): string {
  if (stepType === 'host') return 'Waiting for the host executor';
  if (stepType === 'browser') return 'Waiting for the browser';
  return stepType ? `Waiting for the ${stepType} executor` : 'Waiting for its executor';
}

/**
 * Resolve the best user-facing action label for a step.
 *
 * Priority:
 *  1. Schema-driven `ACTION_LABELS[operationId]`
 *  2. `STEP_TYPE_FALLBACKS[stepType]`
 *  3. Humanized stepType ("Running AI step…")
 *  4. Humanized operationId ("Running ai.unknown.thing…")
 *  5. Generic "Working…"
 */
export function resolveActionLabel(
  operationId: string | undefined,
  stepType: string | undefined,
): string {
  if (operationId) {
    const label = ACTION_LABELS[operationId];
    if (label) return label;
  }
  if (stepType) {
    const fallback = STEP_TYPE_FALLBACKS[stepType];
    if (fallback) return fallback;
    return `Running ${humanizeToken(stepType)} step…`;
  }
  if (operationId) return `Running ${humanizeToken(operationId)}…`;
  return 'Working…';
}
