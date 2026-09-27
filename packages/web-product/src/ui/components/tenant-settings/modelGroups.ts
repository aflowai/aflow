/**
 * Ordering and grouping for the tenant model picker.
 *
 * Split out of the page so the ordering rule is testable: `apps/web` runs its
 * suites in a node environment with no renderer, so logic only reachable
 * through JSX is logic nothing can assert.
 */
export interface CatalogModel {
  modelId: string;
  provider: string;
  displayName: string;
  description?: string;
  contextWindow: number;
  deprecated?: boolean;
  aliases?: string[];
  traits?: { outputType?: string; intelligence?: number; speed?: number };
  pricing: { promptPer1M: number; completionPer1M: number; currency: string };
  capabilities: { chat: boolean; reasoning?: boolean; vision?: boolean };
  reasoning?: { supported: string[]; default?: string };
}

export const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  fireworks: 'Fireworks',
  openrouter: 'OpenRouter',
  local: 'Local',
};

/** Providers in the order the groups read; anything unlisted follows, alphabetically. */
const PROVIDER_ORDER = ['anthropic', 'openai', 'xai', 'google', 'fireworks', 'openrouter', 'local'];

function providerRank(provider: string): number {
  const at = PROVIDER_ORDER.indexOf(provider);
  return at === -1 ? PROVIDER_ORDER.length : at;
}

/**
 * What 1M tokens in and 1M out would cost together — one number to rank a
 * provider's models by. Ranking on the input rate alone puts two models with
 * the same input price in arbitrary order however far apart their output
 * rates are, and output is where agent turns actually spend.
 */
export function blendedRate(model: CatalogModel): number {
  return model.pricing.promptPer1M + model.pricing.completionPer1M;
}

/** Per-1M rates read better than raw floats at these magnitudes. */
export function formatRate(value: number): string {
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

/** Everything a space could assign, in group order and then cheapest-first. */
export function sortAssignableModels(models: readonly CatalogModel[]): CatalogModel[] {
  return models
    .filter((m) => !m.deprecated && m.traits?.outputType !== 'embedding')
    .sort(
      (a, b) =>
        providerRank(a.provider) - providerRank(b.provider) ||
        a.provider.localeCompare(b.provider) ||
        blendedRate(a) - blendedRate(b) ||
        a.displayName.localeCompare(b.displayName),
    );
}

export function matchesQuery(model: CatalogModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    model.displayName.toLowerCase().includes(q) ||
    model.modelId.toLowerCase().includes(q) ||
    model.provider.includes(q)
  );
}

/**
 * Split an already-sorted list into provider groups. Insertion order carries
 * the sort through, so groups appear in provider order and each group stays
 * cheapest-first without re-sorting.
 */
export function groupByProvider(
  models: readonly CatalogModel[],
): Array<[provider: string, models: CatalogModel[]]> {
  const byProvider = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const bucket = byProvider.get(model.provider);
    if (bucket) bucket.push(model);
    else byProvider.set(model.provider, [model]);
  }
  return [...byProvider.entries()];
}

/** Flip one provider's group, leaving the rest of the collapsed set alone. */
export function toggleCollapsed(
  collapsed: ReadonlySet<string>,
  provider: string,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (!next.delete(provider)) next.add(provider);
  return next;
}

/**
 * A filter that matched inside a collapsed group would report hits the reader
 * cannot see, so an active search opens every group it kept.
 */
export function isGroupOpen(
  provider: string,
  collapsed: ReadonlySet<string>,
  searching: boolean,
): boolean {
  return searching || !collapsed.has(provider);
}
