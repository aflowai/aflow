import { describe, expect, it } from 'vitest';
import { deriveRequiredCapabilities } from '@aflow/cybernetic-runtime';
import {
  CODE_REPO_CAPABILITY_ID,
  SPACE_POLICY_OPERATION_PREFIXES,
  isLaneCapabilityToken,
  type SkillBundle,
} from '@aflow/schemas';
import { getSkillBundleEntry, listSkillBundles } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';

// Tokens the post-install manifest CAN surface for a bundle:
//   - the bundle's (and its prerequisites') declared API/MCP definitions +
//     binding templates → fill_credentials / fill_mcp_credentials rows.
const GITHUB_CAPABILITY_ID = 'github';

function templateBackedTokens(bundle: SkillBundle, seen = new Set<string>()): Set<string> {
  const tokens = new Set<string>();
  if (seen.has(bundle.bundleId)) return tokens;
  seen.add(bundle.bundleId);

  for (const d of bundle.apiDefinitions ?? []) tokens.add(d.apiId);
  for (const t of bundle.apiBindingTemplates ?? []) {
    tokens.add(t.apiId);
    tokens.add(t.bindingId);
  }
  for (const d of bundle.mcpDefinitions ?? []) tokens.add(d.serverId);
  for (const t of bundle.mcpBindingTemplates ?? []) {
    tokens.add(t.serverId);
    tokens.add(t.bindingId);
  }
  // Prerequisite bundles are install-validated to be present, so their
  // bindings satisfy the capabilities a dependent bundle's skills inherit.
  for (const prereqId of bundle.prerequisiteBundleIds ?? []) {
    const prereq = getSkillBundleEntry(prereqId);
    if (prereq) for (const tok of templateBackedTokens(prereq, seen)) tokens.add(tok);
  }
  return tokens;
}

describe('skill-bundle catalog — derived readiness is surfaceable (Plan 225 guard)', () => {
  // Every required capability a visible bundle's skills derive must be one the
  // post-install manifest can surface: a template-backed credential row, the
  // `designate_repo` row (`code_repo`/`github`), or a space-policy capability
  // toggled outside the bundle (`compute`). A new bundle that silently requires
  // anything else fails here — forcing a decision instead of a false "ready".
  it('no visible bundle requires a capability the manifest cannot surface', () => {
    const visible = listSkillBundles();
    expect(visible.length).toBeGreaterThan(0);

    for (const bundle of visible) {
      const required = new Set<string>();
      for (const id of bundle.skillCatalogIds) {
        const entry = getSkillCatalogEntry(id);
        if (!entry) continue;
        for (const cap of deriveRequiredCapabilities(entry.bundle)) required.add(cap);
      }

      const surfaceable = templateBackedTokens(bundle);
      // `github` is surfaceable only transitively — the `designate_repo` row
      // subsumes it — so it is exempt ONLY when this bundle also derives
      // `code_repo`. A github-only bundle (requires github, no repo) must still
      // fail, since the manifest would surface nothing for it.
      const githubSubsumed = required.has(CODE_REPO_CAPABILITY_ID);
      const leftover = [...required].filter(
        (cap) =>
          !surfaceable.has(cap) &&
          cap !== CODE_REPO_CAPABILITY_ID &&
          // Lane-credential tokens are surfaced by the `connect_provider`
          // post-install row.
          !isLaneCapabilityToken(cap) &&
          !(cap === GITHUB_CAPABILITY_ID && githubSubsumed) &&
          !SPACE_POLICY_OPERATION_PREFIXES.has(cap),
      );
      expect(leftover, bundle.bundleId).toEqual([]);
    }
  });

  // Non-vacuous: the coding bundle genuinely derives `code_repo` (so the
  // `designate_repo` allowance above is doing real work, not masking nothing).
  it('the coding bundle derives code_repo (guard is not vacuous)', () => {
    const coding = getSkillBundleEntry('coding-pr-loop');
    if (!coding) throw new Error('coding-pr-loop bundle must exist');
    const required = new Set<string>();
    for (const id of coding.skillCatalogIds) {
      const entry = getSkillCatalogEntry(id);
      if (entry) for (const cap of deriveRequiredCapabilities(entry.bundle)) required.add(cap);
    }
    expect(required.has(CODE_REPO_CAPABILITY_ID)).toBe(true);
  });
});
