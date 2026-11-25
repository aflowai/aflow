/**
 * A count of the rules the alpaca-thesis-trading bundle holds its agents to,
 * so a redesign can say how many it removed and a guard can stop them
 * growing back. A machine rule is anything the platform enforces: a
 * derivedFrom binding (a cap or a pin), a conditional schema rule, a
 * validator, a campaign rule or start check, or a decide rule. A prose rule
 * is a sentence an agent or operator reads that forbids or requires
 * something.
 */
import { ALPACA_THESIS_TRADING } from '../skillBundleCatalog/alpacaThesisTrading.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';

export interface SkillRuleCount {
  skill: string;
  derivedFrom: number;
  conditionals: number;
  validators: number;
  decideRules: number;
  campaignRules: number;
  proseRules: number;
}

const RULE_WORDS =
  /\b(never|must|refuse[sd]?|only|cannot|may not|no new|forbid|at most|at least|exactly|verbatim|pinned)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function proseRules(texts: readonly string[]): number {
  return texts.flatMap(sentences).filter((s) => RULE_WORDS.test(s)).length;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    visit(node);
    for (const child of Object.values(node)) walk(child, visit);
  }
}

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, into);
  else if (value !== null && typeof value === 'object')
    for (const v of Object.values(value)) strings(v, into);
  return into;
}

const length = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

export function countSkillRules(catalogId: string): SkillRuleCount {
  const entry = getSkillCatalogEntry(catalogId);
  if (!entry) throw new Error(`no skill ${catalogId}`);
  const workflow = entry.bundle.workflow as unknown as {
    tasks: Array<Record<string, unknown>>;
    usage?: unknown;
    description?: string;
  };
  let derivedFrom = 0;
  let conditionals = 0;
  let validators = 0;
  let decideRules = 0;
  const prose: string[] = [entry.description, workflow.description ?? ''];
  prose.push(...strings(workflow.usage));
  for (const task of workflow.tasks) {
    const contract = task['outputContract'] as Record<string, unknown> | undefined;
    derivedFrom += length(contract?.['derivedFrom']);
    validators += length(contract?.['validatorRefs']);
    walk(contract?.['schema'], (node) => {
      if ('if' in node && 'then' in node) conditionals += 1;
    });
    const template = task['inputTemplate'] as Record<string, unknown> | undefined;
    if (task['operation'] === 'workflow.run.decide') decideRules += length(template?.['rules']);
    if (typeof task['goal'] === 'string') prose.push(task['goal']);
    if (typeof template?.['task'] === 'string') prose.push(template['task']);
  }
  const campaign = (entry.bundle.manifest as unknown as { campaign?: Record<string, unknown> })
    .campaign;
  return {
    skill: catalogId,
    derivedFrom,
    conditionals,
    validators,
    decideRules,
    campaignRules: length(campaign?.['validatorRefs']) + length(campaign?.['startChecks']),
    proseRules: proseRules(prose),
  };
}

export interface BundleRuleCensus {
  skills: SkillRuleCount[];
  bundleProseRules: number;
  machineRules: number;
  proseRules: number;
  total: number;
}

export function tradingRuleCensus(): BundleRuleCensus {
  const skills = ALPACA_THESIS_TRADING.skillCatalogIds.map(countSkillRules);
  const bundleProseRules = proseRules([
    ALPACA_THESIS_TRADING.description,
    ...(ALPACA_THESIS_TRADING.helmsmanHints ?? []),
    ...(ALPACA_THESIS_TRADING.memorySeed ?? []).map((doc) => String(doc.content)),
  ]);
  const machineRules = skills.reduce(
    (sum, s) =>
      sum + s.derivedFrom + s.conditionals + s.validators + s.decideRules + s.campaignRules,
    0,
  );
  const proseTotal = bundleProseRules + skills.reduce((sum, s) => sum + s.proseRules, 0);
  return {
    skills,
    bundleProseRules,
    machineRules,
    proseRules: proseTotal,
    total: machineRules + proseTotal,
  };
}
