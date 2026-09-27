import { buildCoreToolSpec, estimateStringTokens, type AgentToolSpec } from '@aflow/schemas';
import { CYBERNETIC_AGENTS, HELMSMAN_DISCOVERY_PRESET } from '@aflow/platform-artifacts';
import { assembleHelmsmanPromptSections } from '@aflow/cybernetic-runtime';
import { buildToolSurface } from '../../apps/aflow-executor-ai/src/handlers/ai/handlers/agentToolSurface.js';
import type { AgentTurnInput } from '../../apps/aflow-executor-ai/src/handlers/ai/schema.js';
import {
  MEMORY_GUIDANCE,
  COMPUTE_GUIDANCE,
  INTEGRATIONS_GUIDANCE,
  REPOSITORIES_GUIDANCE,
  SKILLS_GUIDANCE,
} from '../../apps/aflow-orchestrator/src/services/SessionOrchestrator/helpers/spaceContext.js';
import { SCAN_SPACE_NAME, type BudgetComponent, type BudgetReport } from './config.js';
import { MAX_PINNED_TOOLS } from '@aflow/schemas';

type DeliveryMode = 'native_fc' | 'generate_json';

/**
 * The provider the surface is priced against.
 *
 * `buildFunctionDeclarations` branches only on `google`, whose sanitizer strips
 * unsupported keywords and therefore emits fewer bytes; every other provider
 * takes one shared path. Anthropic stands in for that path and ties for the
 * largest output, so the baseline reads the worst case rather than the mean.
 *
 * Known gap: provider adapters mutate tool definitions AFTER this point (the
 * OpenAI adapter adds `strict`, the Anthropic one can add an object wrapper),
 * so this row is pre-adapter bytes. It moves with the same changes the wire
 * moves with, which is what a drift guard needs.
 */
const SCAN_PROVIDER = 'anthropic';

function agentStepConfig(flowId: string): Record<string, unknown> | undefined {
  const agent = CYBERNETIC_AGENTS.find((a) => a.flowId === flowId);
  const step = agent?.steps.find((s) => s['operation'] === 'ai.agent.turn');
  return step?.['config'] as Record<string, unknown> | undefined;
}

function coreOperationsOf(flowId: string): string[] {
  const catalog = agentStepConfig(flowId)?.['catalog'] as { coreOperations?: string[] } | undefined;
  return catalog?.coreOperations ?? [];
}

function systemPromptOf(flowId: string): string {
  return (agentStepConfig(flowId)?.['systemPrompt'] as string | undefined) ?? '';
}

interface ScanAgentShape {
  agentRole: string;
  policy: {
    maxToolCallsPerTurn: number;
    allowParallel: boolean;
    maxParallel: number;
    allowComplete: boolean;
  };
  requestInputPolicy?: string;
}

/**
 * Read the turn shape the orchestrator would derive for this agent.
 *
 * `allowComplete` is derived from `completionPolicy` exactly as
 * `buildAgentTurnInput` derives it, because it decides whether a `complete`
 * meta declaration is emitted. Hardcoding it to `true` prices a function the
 * Helmsman never sends -- roughly 140 tokens of budget that does not exist.
 */
function agentShape(flowId: string): ScanAgentShape {
  const config = agentStepConfig(flowId) ?? {};
  const completionPolicy = config['completionPolicy'] as string | undefined;
  const requestInputPolicy = config['requestInputPolicy'] as string | undefined;
  return {
    agentRole: (config['agentRole'] as string | undefined) ?? 'assistant',
    policy: {
      maxToolCallsPerTurn: (config['maxToolCallsPerTurn'] as number | undefined) ?? 10,
      allowParallel: (config['allowParallel'] as boolean | undefined) ?? true,
      maxParallel: (config['maxParallel'] as number | undefined) ?? 5,
      allowComplete: completionPolicy !== 'open_ended',
    },
    ...(requestInputPolicy ? { requestInputPolicy } : {}),
  };
}

/**
 * Price a tool set exactly as the executor emits it.
 *
 * Routed through `buildToolSurface` rather than a local
 * `JSON.stringify({name, description, input_schema})`: that recipe matches the
 * operator panel but not the wire, because the executor sanitizes per provider
 * and adds the meta functions.
 */
function priceTools(
  specs: AgentToolSpec[],
  deliveryMode: DeliveryMode,
  shape: ScanAgentShape,
): { tokens: number; chars: number; count: number } {
  const params = {
    availableTools: specs,
    ...shape,
  } as unknown as AgentTurnInput;

  const { surface, toolsTokens, toolsChars } = buildToolSurface({
    params,
    provider: SCAN_PROVIDER,
    model: 'scan',
    deliveryMode,
  });

  return { tokens: toolsTokens, chars: toolsChars, count: surface.active.length };
}

/**
 * Resolve declared operation ids to tool specs, keeping the ones that did not.
 *
 * `buildAvailableTools` drops an unresolvable id silently, so an op that is
 * renamed or removed from the registry shrinks the surface without anything
 * failing — and a shrink never trips a budget check. Returning the misses lets
 * the scan name them.
 */
function resolveSpecs(operationIds: readonly string[]): {
  specs: AgentToolSpec[];
  unresolved: string[];
} {
  const specs: AgentToolSpec[] = [];
  const unresolved: string[] = [];
  for (const id of operationIds) {
    const spec = buildCoreToolSpec(id);
    if (spec) specs.push(spec);
    else unresolved.push(id);
  }
  return { specs, unresolved };
}

export function buildScanReport(): BudgetReport {
  const components: BudgetComponent[] = [];
  const push = (
    key: string,
    group: BudgetComponent['group'],
    tokens: number,
    chars: number,
  ): void => {
    components.push({ key, group, tokens, chars });
  };

  // -- Tool surface, per agent and delivery mode ----------------------------
  const unresolvedOps: string[] = [];
  for (const flowId of ['cybernetic-helmsman', 'cybernetic-coach'] as const) {
    const role = flowId.replace('cybernetic-', '');
    const declared = coreOperationsOf(flowId);
    const { specs, unresolved } = resolveSpecs(declared);
    unresolvedOps.push(...unresolved.map((id) => `${role}: ${id}`));
    // Recorded so a tool that stops resolving shows as a dropped row rather
    // than as an unexplained shrink in the priced surface below.
    push(`tools.${role}.resolvedOps`, 'tools', specs.length, specs.length);
    for (const mode of ['native_fc', 'generate_json'] as const) {
      const priced = priceTools(specs, mode, agentShape(flowId));
      push(`tools.${role}.${mode}`, 'tools', priced.tokens, priced.chars);
    }
  }

  // -- Helmsman prompt, per section -----------------------------------------
  const sections = assembleHelmsmanPromptSections({
    spaceName: SCAN_SPACE_NAME,
    directives: {
      version: 1,
      responsibility: 'Baseline responsibility used only for scanning.',
      priorities: [],
      resourceBudget: {},
      modelDefaults: {},
      reasoningDefaults: {},
      learningPolicy: {},
      capabilityDiscovery: {},
    } as never,
    // A representative self-model, not `undefined`. A learned space populates
    // `/identity/self-model.json`, and the assembler appends a section for it —
    // scanning without one leaves that section with no baseline row, so growth
    // in a genuinely model-visible part of the prompt would pass unseen. The
    // shape is fixed here so the row measures the section's framing rather than
    // whatever one space happens to have learned.
    selfModel: {
      behavioralPatterns: [
        { pattern: 'Reaches for a skill before improvising.', confidence: 'established' },
      ],
      communicationStyle: {
        description: 'Direct, concrete, and short.',
        vocabularyNotes: ['Says "skill", never "workflow".'],
      },
      expertiseAreas: [{ domain: 'baseline-domain' }],
    } as never,
  });
  for (const section of sections) {
    push(
      `helmsmanPrompt.${section.name}`,
      'helmsmanPrompt',
      estimateStringTokens(section.text),
      section.text.length,
    );
  }

  // -- Runner prompt ---------------------------------------------------------
  const runnerPrompt = systemPromptOf('cybernetic-runner');
  push(
    'runnerPrompt.total',
    'runnerPrompt',
    estimateStringTokens(runnerPrompt),
    runnerPrompt.length,
  );

  // -- SpaceContext guidance constants --------------------------------------
  // Fixed prose shipped inside a data block; the scanner prices it separately
  // so relocating it into the (cached) system prompt shows as a move rather
  // than as an unexplained drop.
  for (const [key, text] of [
    ['memory', MEMORY_GUIDANCE],
    ['integrations', INTEGRATIONS_GUIDANCE],
    ['repositories', REPOSITORIES_GUIDANCE],
    ['skills', SKILLS_GUIDANCE],
    ['compute', COMPUTE_GUIDANCE],
  ] as const) {
    push(
      `spaceContextGuidance.${key}`,
      'spaceContextGuidance',
      estimateStringTokens(text),
      text.length,
    );
  }

  // -- Worst-case pinned surface --------------------------------------------
  // The highest-cost ops the discovery preset admits, up to the pinned cap.
  // `MAX_PINNED_TOOLS` is a count cap, so this row is what that count can cost
  // if an operator pins the most expensive things reachable.
  const helmsman = agentShape('cybernetic-helmsman');
  const presetPriced = resolveSpecs(HELMSMAN_DISCOVERY_PRESET)
    .specs.map((spec) => ({ spec, tokens: priceTools([spec], 'native_fc', helmsman).tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_PINNED_TOOLS);
  const worstCase = priceTools(
    presetPriced.map((p) => p.spec),
    'native_fc',
    helmsman,
  );
  push('worstCase.pinnedSurface', 'worstCase', worstCase.tokens, worstCase.chars);

  const totals: BudgetReport['totals'] = {};
  for (const component of components) {
    const prior = totals[component.group] ?? { tokens: 0, chars: 0 };
    totals[component.group] = {
      tokens: prior.tokens + component.tokens,
      chars: prior.chars + component.chars,
    };
  }

  return { components, totals, unresolvedOps };
}

export function formatScanReport(report: BudgetReport): string {
  const lines: string[] = ['Context budget'];
  if (report.unresolvedOps.length > 0) {
    lines.push('');
    lines.push('  ⚠ declared operations that do not resolve (silently dropped at assembly):');
    for (const entry of report.unresolvedOps) lines.push(`      ${entry}`);
  }
  const width = Math.max(...report.components.map((c) => c.key.length));
  let group = '';
  for (const component of report.components) {
    if (component.group !== group) {
      group = component.group;
      lines.push('');
      lines.push(`  ${group}`);
    }
    lines.push(
      `    ${component.key.padEnd(width)}  ${String(component.tokens).padStart(6)} tok  ${String(component.chars).padStart(7)} chars`,
    );
  }
  lines.push('');
  for (const [name, total] of Object.entries(report.totals)) {
    lines.push(`  ${name.padEnd(width + 2)}${String(total.tokens).padStart(6)} tok (total)`);
  }
  return lines.join('\n');
}
