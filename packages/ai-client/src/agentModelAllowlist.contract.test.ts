import { describe, it, expect } from 'vitest';
import {
  RECOMMENDED_AGENT_MODELS,
  isRecommendedAgentModelRef,
  DEFAULT_CYBERNETIC_MODEL,
  CLERK_MODEL_CANDIDATES,
} from '@aflow/schemas';
import { MODEL_SELECTIONS } from '@aflow/lib';
import { createDefaultModelCatalog } from './catalog.js';

/**
 * Pins the curated agent allowlist (Plan 227 D2) to the live catalog so the
 * two can never drift silently: every allowlisted ref must resolve to a
 * non-deprecated, chat-capable catalog model on the matching provider.
 */
describe('agent model allowlist ↔ catalog contract', () => {
  const catalog = createDefaultModelCatalog();

  it('every allowlist entry resolves to a live catalog model', () => {
    for (const entry of RECOMMENDED_AGENT_MODELS) {
      const model = catalog.getModel(entry.modelId);
      expect(model, `modelId ${entry.modelId} missing from catalog`).toBeDefined();
      expect(model?.deprecated ?? false, `${entry.modelId} is deprecated`).toBe(false);
      expect(model?.capabilities.chat, `${entry.modelId} is not chat-capable`).toBe(true);
      expect(model?.provider, `${entry.modelId} provider mismatch`).toBe(
        entry.credentialProviderId,
      );
    }
  });

  it('every allowlist alias resolves to the same model as its modelId', () => {
    for (const entry of RECOMMENDED_AGENT_MODELS) {
      if (!entry.alias) continue;
      const viaAlias = catalog.getModel(entry.alias);
      expect(viaAlias?.id, `alias ${entry.alias} does not resolve to ${entry.modelId}`).toBe(
        entry.modelId,
      );
    }
  });

  it('agrees with the catalog on the alias every surface persists', () => {
    // Two surfaces persist an operator's model choice and derive the ref
    // independently: the role picker takes the catalog's `aliases[0]`, while
    // onboarding takes `RECOMMENDED_AGENT_MODELS[].alias ?? modelId` — the
    // registry lives in @aflow/schemas and cannot reach the catalog to ask.
    // They agree only if the registry names the same alias, so this asserts it
    // in both directions. Skipping entries that name none let the two diverge
    // silently: Gemini Pro led with `pro` in the catalog and named nothing
    // here, so onboarding pinned the preview id the picker had moved off.
    for (const entry of RECOMMENDED_AGENT_MODELS) {
      const primary = catalog.getModel(entry.modelId)?.aliases?.[0];
      expect(
        entry.alias,
        primary === undefined
          ? `${entry.modelId} has no catalog alias, so the registry must name none`
          : `${entry.modelId} leads with '${primary}' — the registry must name it`,
      ).toBe(primary);
    }
  });

  it('the platform default cybernetic model is allowlisted', () => {
    expect(isRecommendedAgentModelRef(DEFAULT_CYBERNETIC_MODEL)).toBe(true);
  });

  it('every Clerk candidate is a live model on the provider that lists it', () => {
    for (const [providerId, refs] of Object.entries(CLERK_MODEL_CANDIDATES)) {
      expect(refs.length, `${providerId} lists no Clerk candidate`).toBeGreaterThan(0);
      for (const ref of refs) {
        const model = catalog.getModel(ref);
        expect(model, `Clerk candidate ${ref} missing from catalog`).toBeDefined();
        expect(model?.deprecated ?? false, `Clerk candidate ${ref} is deprecated`).toBe(false);
        expect(model?.provider, `Clerk candidate ${ref} is not a ${providerId} model`).toBe(
          providerId,
        );
      }
    }
  });

  it('every Clerk candidate can return structured output', () => {
    // The generation contract is a JSON schema, and `generateJson` refuses a
    // model that supports neither structured outputs nor JSON mode — so a
    // candidate without one fails every conversation it is picked for, and
    // fails it in the background where nobody is watching.
    for (const refs of Object.values(CLERK_MODEL_CANDIDATES)) {
      for (const ref of refs) {
        const caps = catalog.getModel(ref)?.capabilities;
        expect(
          caps?.structuredOutputs === true || caps?.jsonMode === true,
          `Clerk candidate ${ref} cannot produce structured output`,
        ).toBe(true);
      }
    }
  });

  it('curated op-schema selections still resolve after catalog refreshes', () => {
    for (const ref of MODEL_SELECTIONS.text) {
      expect(catalog.getModel(ref), `MODEL_SELECTIONS.text ref ${ref} unresolvable`).toBeDefined();
    }
  });
});
