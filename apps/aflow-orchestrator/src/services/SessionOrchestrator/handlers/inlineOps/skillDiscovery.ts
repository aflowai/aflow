import { getDatabase } from '@aflow/database';
import { SkillSearchInputSchema, type AgentDefinition } from '@aflow/schemas';
import {
  searchInstalledSkills,
  loadHelmsmanDiscovery,
  isHelmsmanDefinition,
} from '@aflow/cybernetic-runtime';
import { skillPlacement } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { readInlineInput } from './readInlineInput.js';
import { requireSpaceId } from './spaceScope.js';

export function isHelmsmanSkillCaller(context: {
  agentDefinition?: Pick<AgentDefinition, 'metadata'>;
}): boolean {
  const metadata = context.agentDefinition?.metadata;
  return metadata?.system === true && isHelmsmanDefinition(metadata);
}

export async function handleSkillSearch(args: InlineHandlerArgs): Promise<void> {
  const start = Date.now();
  try {
    const raw = await readInlineInput(args, start);
    if (!raw) return;
    const input = SkillSearchInputSchema.parse(raw);
    const result = await searchInstalledSkills(
      { db: getDatabase(), tenantId: args.context.tenantId, spaceId: requireSpaceId(args.context) },
      input,
    );
    await emitStepSuccess(args, result, start);
  } catch (error) {
    await emitStepError(
      args,
      'SKILL_SEARCH_FAILED',
      error instanceof Error ? error.message : String(error),
      start,
      'validation',
    );
  }
}

export async function enforceSkillSelection(
  args: InlineHandlerArgs,
  slug: string,
  start: number,
): Promise<boolean> {
  if (args.workflowExecution || !isHelmsmanSkillCaller(args.context)) return true;
  const discovery = await loadHelmsmanDiscovery({
    db: getDatabase(),
    tenantId: args.context.tenantId,
    spaceId: requireSpaceId(args.context),
  });
  if (skillPlacement(slug, discovery.skillPlacements) !== 'off') return true;
  await emitStepError(
    args,
    'SKILL_OFF_FOR_HELMSMAN',
    `Skill "${slug}" is Off for Helmsman. The operator can invoke it directly or change its placement in agent settings. Nothing was started.`,
    start,
    'permission',
    false,
  );
  return false;
}
