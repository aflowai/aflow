import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { DirectiveCapabilityDiscovery, TenantId } from '@aflow/schemas';
import {
  MAX_PINNED_TOOLS,
  MAX_CAPABILITY_SCHEMA_TOKENS,
  SKILL_AWARENESS_TOKEN_BUDGET,
  processEditionDescriptor,
} from '@aflow/schemas';
import { resolveHelmsmanCapabilities } from '@aflow/platform-artifacts';
import { validatePinnedSkillBudget } from '@aflow/cybernetic-runtime';
import { loadSpaceConnections } from './spaceConnections.js';
import { alwaysOnBindingTools } from './spacesShared.js';

export async function validateAgentCapabilitySettings(
  ctx: { db: PostgresJsDatabase; tenantId: TenantId; spaceId?: string },
  discovery: DirectiveCapabilityDiscovery,
) {
  const resolved = resolveHelmsmanCapabilities(processEditionDescriptor(), discovery);
  const pins = alwaysOnBindingTools(discovery.connections);
  let tools = resolved.pinnedCount;
  let tokens = resolved.pinnedTokens;
  if (ctx.spaceId && pins.size) {
    const connections = await loadSpaceConnections(ctx.db, ctx.tenantId, ctx.spaceId);
    for (const connection of connections) {
      if (!pins.has(connection.bindingId)) continue;
      const names = pins.get(connection.bindingId) ?? null;
      const selected =
        names === null
          ? connection.tools
          : connection.tools.filter((tool) => names.includes(tool.name));
      tools += selected.length;
      tokens += selected.reduce((n, tool) => n + tool.tokens, 0);
    }
  }
  if (tools > MAX_PINNED_TOOLS)
    return {
      error: 'PLACEMENT_OVER_TOOL_CAP',
      message: `Always-on capabilities and connections would pin ${String(tools)} tools, over the limit of ${String(MAX_PINNED_TOOLS)}. Move something to on demand.`,
    };
  if (tokens > MAX_CAPABILITY_SCHEMA_TOKENS)
    return {
      error: 'PLACEMENT_OVER_TOKEN_BUDGET',
      message: `Pinned tool schemas need approximately ${String(tokens)} tokens; the budget is ${String(MAX_CAPABILITY_SCHEMA_TOKENS)}. Move tools to on demand.`,
    };
  if (discovery.skillPlacements) {
    const skillTokens = await validatePinnedSkillBudget(
      { ...ctx, spaceId: ctx.spaceId ?? randomUUID() },
      discovery.skillPlacements,
    );
    if (skillTokens > SKILL_AWARENESS_TOKEN_BUDGET)
      return {
        error: 'SKILL_AWARENESS_OVER_BUDGET',
        message: `Pinned skill summaries need approximately ${String(skillTokens)} tokens; the budget is ${String(SKILL_AWARENESS_TOKEN_BUDGET)}. Move skills to on demand.`,
      };
  }
  return undefined;
}
