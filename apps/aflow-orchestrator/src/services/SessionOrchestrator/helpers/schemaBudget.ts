import {
  estimateToolSchemaTokens,
  MAX_CAPABILITY_SCHEMA_TOKENS,
  MAX_PINNED_SCHEMA_TOKENS,
  type AgentToolSpec,
} from '@aflow/schemas';
import { getOrchestratorLogger } from '../../../lib/orchestratorLogger.js';

/**
 * The Helmsman's schema spend as this turn's surface left it, so that
 * `catalog.tool.promote` can tell whether a promotion will load next turn.
 * Promotion raises `committedTokens` by what it admits. The next turn's
 * assembly writes the measurement afresh.
 */
export const SCHEMA_BUDGET_VAR = 'ai.agent._schemaBudget';

export interface SchemaBudgetMeasure {
  maxTokens: number;
  pinnedTokens: number;
  pinnedToolIds: string[];
  /** Pinned tokens plus every promotion admitted since the surface was built. */
  committedTokens: number;
}

export interface SchemaBudgetCandidate {
  toolId: string;
  /** The id the surface lists it under. A promoted agent is listed by its delegate tool. */
  surfaceToolId: string;
  tokens: number;
}

/** The stored measurement, or undefined for an agent the budget does not bind. */
export function readSchemaBudget(
  variables: Record<string, unknown> | undefined,
): SchemaBudgetMeasure | undefined {
  const entry = variables?.[SCHEMA_BUDGET_VAR] as
    { ref?: { kind: string; value?: unknown } } | undefined;
  const value = entry?.ref?.kind === 'inline' ? entry.ref.value : undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Partial<SchemaBudgetMeasure>;
  if (
    typeof v.maxTokens !== 'number' ||
    typeof v.pinnedTokens !== 'number' ||
    typeof v.committedTokens !== 'number' ||
    !Array.isArray(v.pinnedToolIds)
  )
    return undefined;
  return v as SchemaBudgetMeasure;
}

/**
 * Keep the Helmsman's surface inside the schema budget. Pinned tools come
 * first and an overflow among them throws, because that is a settings error
 * that dropping a tool would hide. Promoted tools follow in their LRU order,
 * and one that would cross the budget is left unloaded.
 */
export function fitToolsToSchemaBudget(
  tools: AgentToolSpec[],
  isPinned: (tool: AgentToolSpec) => boolean,
): AgentToolSpec[] {
  let schemaTokens = 0;
  for (const tool of tools) if (isPinned(tool)) schemaTokens += estimateToolSchemaTokens(tool);
  if (schemaTokens > MAX_PINNED_SCHEMA_TOKENS)
    throw new Error('Pinned tool schemas exceed the token budget. Move capabilities to on demand.');
  return tools.filter((tool) => {
    if (isPinned(tool)) return true;
    const tokens = estimateToolSchemaTokens(tool);
    if (schemaTokens + tokens > MAX_CAPABILITY_SCHEMA_TOKENS) {
      getOrchestratorLogger().warn(
        `Promoted tool ${tool.toolId} left unloaded at ${String(schemaTokens)} of ${String(MAX_CAPABILITY_SCHEMA_TOKENS)} schema tokens`,
      );
      return false;
    }
    schemaTokens += tokens;
    return true;
  });
}

/** Measure a surface `buildAvailableTools` returned. A promoted tool carries `discoveredAtTurn`. */
export function measureSchemaBudget(availableTools: AgentToolSpec[]): SchemaBudgetMeasure {
  const pinned = availableTools.filter((tool) => tool.discoveredAtTurn === undefined);
  const pinnedTokens = pinned.reduce((n, tool) => n + estimateToolSchemaTokens(tool), 0);
  return {
    maxTokens: MAX_CAPABILITY_SCHEMA_TOKENS,
    pinnedTokens,
    pinnedToolIds: pinned.map((tool) => tool.toolId),
    committedTokens: pinnedTokens,
  };
}

/**
 * Decide which promotions the next turn's surface will load.
 *
 * A promotion ranks first among promoted tools on the next turn, behind only
 * the pinned tier and the promotions made earlier in this turn. So a candidate
 * lands exactly when it fits beside `committedTokens`, and the older promoted
 * tools it may displace do not count against it. A pinned tool is already
 * loaded and costs nothing.
 */
export function fitPromotionsToSchemaBudget(
  budget: SchemaBudgetMeasure,
  candidates: readonly SchemaBudgetCandidate[],
): {
  admitted: string[];
  refused: Array<{ toolId: string; reason: string }>;
  budget: SchemaBudgetMeasure;
} {
  const pinned = new Set(budget.pinnedToolIds);
  const admitted: string[] = [];
  const refused: Array<{ toolId: string; reason: string }> = [];
  let committed = budget.committedTokens;
  for (const { toolId, surfaceToolId, tokens } of candidates) {
    if (pinned.has(surfaceToolId)) {
      admitted.push(toolId);
      continue;
    }
    if (committed + tokens <= budget.maxTokens) {
      committed += tokens;
      admitted.push(toolId);
      continue;
    }
    refused.push({ toolId, reason: schemaBudgetRefusal(budget, committed, tokens) });
  }
  return { admitted, refused, budget: { ...budget, committedTokens: committed } };
}

function schemaBudgetRefusal(
  budget: SchemaBudgetMeasure,
  committed: number,
  tokens: number,
): string {
  const promotedThisTurn = committed - budget.pinnedTokens;
  const short = committed + tokens - budget.maxTokens;
  return (
    `schema_budget: this tool needs about ${String(tokens)} schema tokens. ` +
    `The tool surface already holds ${String(committed)} of the ${String(budget.maxTokens)}-token budget: ` +
    `${String(budget.pinnedTokens)} pinned and ${String(promotedThisTurn)} promoted this turn. ` +
    'It would not load on the next turn, so it was not promoted. ' +
    `It lands once ${String(short)} more tokens are free. ` +
    (budget.pinnedTokens + tokens <= budget.maxTokens
      ? 'Promote it again on the next turn before promoting anything else. ' +
        'The operator can also free room by moving pinned capabilities to on demand.'
      : 'Only the operator can free that room, by moving pinned capabilities to on demand.')
  );
}
