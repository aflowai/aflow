'use client';

import { useMemo } from 'react';
import { CLERK_MODEL_CANDIDATES, type DirectiveReasoningEffort } from '@aflow/schemas';
import { useApiQuery } from './useApiQuery.js';

export interface ModelOption {
  id: string;
  /**
   * The ref to persist when an operator picks this model — its alias where it
   * has one, otherwise the catalog id.
   *
   * An alias names a tier (`glm-pro`), a catalog id names one version of it
   * (`accounts/fireworks/models/glm-5p3`). Storing the id pins an assignment to
   * a version that a later catalog refresh retires, leaving the space holding a
   * ref that names nothing; storing the alias keeps it on the tier the operator
   * actually chose. Every gate resolves both spellings, so this only decides
   * which one survives a generation.
   */
  ref: string;
  displayName: string;
  aliases: string[];
  /**
   * Ids that named this model before their own entry retired into it. Matched
   * when normalizing a stored ref so a space still holding one selects the
   * model that now answers for it, rather than rendering blank against a value
   * no option carries.
   */
  retiredRefs: string[];
  /**
   * Credential provider behind this model. Carried from the catalog rather
   * than looked up in the recommended registry, which knows only the curated
   * refs and would leave every tenant-enabled model without a provider — and
   * so without the "Needs key — connect" action when its key is missing.
   */
  provider: string;
  /**
   * Reasoning efforts this model accepts, empty when it takes no reasoning
   * config. Offering a rung outside this set lets an operator save a
   * combination the provider rejects on the next run.
   */
  reasoningEfforts: DirectiveReasoningEffort[];
  /**
   * False when this model is only listed because a space still holds it — the
   * tenant no longer permits assigning it, and the picker must say so rather
   * than offering it as an ordinary choice.
   */
  allowed: boolean;
}

export interface ModelOptionsState {
  modelOptions: ModelOption[];
  /**
   * What the Clerk may be assigned explicitly: the agent options plus the
   * curated economical models, which are deliberately absent from the
   * agent-role shortlist. That shortlist is a chat-tier recommendation and was
   * never a ceiling on background upkeep — but where a tenant named its own
   * set, that set IS a ceiling and narrows these too.
   */
  clerkModelOptions: ModelOption[];
  modelOptionsLoading: boolean;
  modelOptionsError: string | null;
}

interface CatalogModel {
  modelId: string;
  provider: string;
  displayName: string;
  aliases?: string[];
  retiredRefs?: string[];
  deprecated?: boolean;
  traits?: { outputType?: string };
  reasoning?: { supported: DirectiveReasoningEffort[]; default?: DirectiveReasoningEffort };
}

/**
 * The models a role picker may offer: the chat catalog, narrowed to what this
 * tenant allows.
 *
 * Two queries rather than one filtered endpoint, because the catalog is global
 * and public while the allowlist is tenant state — folding them server-side
 * would make an unauthenticated route answer a tenant question. Both are
 * cached, and the write path enforces the same set, so a stale list here
 * refuses rather than misapplies.
 *
 * Shared by the cybernetic settings page and the in-composer quick-settings
 * popover.
 */
export function useChatModelOptions(keepRefs: readonly string[] = []): ModelOptionsState {
  const catalog = useApiQuery<{ models: CatalogModel[] }>({
    key: ['catalog', 'models', 'chat'],
    path: '/catalog/models?capability=chat',
    staleTime: 300_000,
  });

  const policy = useApiQuery<{ modelIds: string[]; source: 'tenant' | 'platform' }>({
    key: ['tenant', 'agent-models'],
    path: '/tenant/agent-models',
    staleTime: 60_000,
  });

  const keepKey = [...keepRefs].sort().join('\u0000');

  const modelOptions = useMemo<ModelOption[]>(() => {
    const allowed = policy.data?.modelIds;
    if (!allowed) return [];
    const allowedSet = new Set(allowed);
    const keepSet = new Set(keepKey ? keepKey.split('\u0000') : []);
    // A retired id counts as naming this model, so a space still holding one
    // keeps its own assignment listed rather than dropping to a blank select.
    const matches = (m: CatalogModel, refs: ReadonlySet<string>): boolean =>
      refs.has(m.modelId) ||
      (m.aliases ?? []).some((a) => refs.has(a)) ||
      (m.retiredRefs ?? []).some((r) => refs.has(r));

    return (
      (catalog.data?.models ?? [])
        .filter((m) => !m.deprecated && m.traits?.outputType !== 'embedding')
        // A model the tenant has since excluded stays listed while a space still
        // holds it: narrowing the set blocks new assignments but leaves existing
        // ones running, and dropping the option would render that space's own
        // model as a blank select nobody could read or deliberately change.
        .filter((m) => matches(m, allowedSet) || matches(m, keepSet))
        .map((m) => ({
          id: m.modelId,
          ref: m.aliases?.[0] ?? m.modelId,
          provider: m.provider,
          displayName: m.displayName,
          aliases: m.aliases ?? [],
          retiredRefs: m.retiredRefs ?? [],
          reasoningEfforts: m.reasoning?.supported ?? [],
          allowed: matches(m, allowedSet),
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    );
  }, [catalog.data, policy.data, keepKey]);

  const clerkModelOptions = useMemo<ModelOption[]>(() => {
    const allowed = policy.data?.modelIds;
    if (!allowed) return [];
    const tenantChose = policy.data?.source === 'tenant';
    const allowedSet = new Set(allowed);
    const candidateRefs = new Set(Object.values(CLERK_MODEL_CANDIDATES).flat());

    // Both sides matched through the catalog's own spellings. The curated list
    // names `glm-flash` while a tenant allowlist stores
    // `accounts/fireworks/models/glm-5p3-flash`; comparing them as strings
    // hides a model the tenant permitted behind a name it did not use.
    const matchesRefs = (m: CatalogModel, refs: ReadonlySet<string>): boolean =>
      refs.has(m.modelId) ||
      (m.aliases ?? []).some((a) => refs.has(a)) ||
      (m.retiredRefs ?? []).some((r) => refs.has(r));

    const extra = (catalog.data?.models ?? [])
      .filter((m) => !m.deprecated && m.traits?.outputType !== 'embedding')
      .filter((m) => matchesRefs(m, candidateRefs))
      // A tenant that named its own set named a ceiling; one following the
      // platform recommendation did not, and the agent-tier shortlist was
      // never meant to be read as one for background upkeep.
      .filter((m) => !tenantChose || matchesRefs(m, allowedSet))
      .filter((m) => !modelOptions.some((o) => o.id === m.modelId))
      .map((m) => ({
        id: m.modelId,
        ref: m.aliases?.[0] ?? m.modelId,
        provider: m.provider,
        displayName: m.displayName,
        aliases: m.aliases ?? [],
        retiredRefs: m.retiredRefs ?? [],
        reasoningEfforts: m.reasoning?.supported ?? [],
        allowed: true,
      }));

    return [...modelOptions, ...extra].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [catalog.data, policy.data, modelOptions]);

  const error = catalog.error ?? policy.error;
  return {
    modelOptions,
    clerkModelOptions,
    modelOptionsLoading: catalog.isLoading || policy.isLoading,
    modelOptionsError: error ? error.message : null,
  };
}
