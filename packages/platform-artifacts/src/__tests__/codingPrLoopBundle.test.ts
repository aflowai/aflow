import { describe, expect, it } from 'vitest';
import { deriveRequiredCapabilities } from '@aflow/cybernetic-runtime';
import { CODE_REPO_CAPABILITY_ID } from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';

const BUNDLE_ID = 'coding-pr-loop';

describe('coding-pr-loop bundle', () => {
  const bundle = getSkillBundleEntry(BUNDLE_ID);
  if (!bundle) throw new Error(`bundle "${BUNDLE_ID}" not found`);

  it('installs the three coding-loop skills, and each resolves in the skill catalog', () => {
    expect(bundle.skillCatalogIds).toEqual([
      'open-pr-from-request',
      'review-pull-request',
      'pr-shepherd',
    ]);
    for (const id of bundle.skillCatalogIds) {
      expect(getSkillCatalogEntry(id), `skill "${id}" must resolve`).not.toBeNull();
    }
  });

  it('ships the GitHub API definition with the endpoints the skills call', () => {
    const github = bundle.apiDefinitions.find((d) => d.apiId === 'github');
    expect(github).toBeDefined();
    const endpointIds = (github?.definition.endpoints ?? []).map((e) => e.endpointId);
    // The union the three skills use (create/fix, review, shepherd).
    for (const id of [
      'createPullRequest',
      'getPullRequest',
      'listPullRequestFiles',
      'createIssueComment',
      'mergePullRequest',
    ]) {
      expect(endpointIds, id).toContain(id);
    }
  });

  it('ships NO pre-shipped GitHub binding — the connection is ensured at repo designation (Plan 222 P3)', () => {
    // The GitHub connection is created when the operator designates the repo
    // (bootstrap from a PAT, or link an existing connection); the skills resolve
    // it from the designation. A pre-shipped placeholder binding would only
    // collide with that bootstrap, and no skill names a fixed GitHub account.
    expect(bundle.apiBindingTemplates).toEqual([]);
  });

  it('every binding-template apiId resolves to a shipped API definition', () => {
    const apiIds = new Set(bundle.apiDefinitions.map((d) => d.apiId));
    for (const tpl of bundle.apiBindingTemplates) {
      expect(apiIds.has(tpl.apiId), tpl.bindingId).toBe(true);
    }
  });

  it("the github definition's suggested egress allows every endpoint method (incl. PUT for merge)", () => {
    // A binding seeded from this definition inherits suggestedEgressPolicy.allowedMethods;
    // if it omitted an endpoint's method the call is egress-blocked at run time
    // (mergePullRequest is PUT — the founding incident: merge blocked by GET/POST-only egress).
    const github = bundle.apiDefinitions.find((d) => d.apiId === 'github');
    if (!github) throw new Error('github definition must ship');
    const allowed = new Set(github.definition.suggestedEgressPolicy?.allowedMethods ?? []);
    for (const ep of github.definition.endpoints) {
      expect(allowed.has(ep.method), `${ep.endpointId} (${ep.method})`).toBe(true);
    }
    expect(allowed.has('PUT')).toBe(true);
  });

  it('requires a coding repo by DERIVATION — every coding skill resolves code_repo', () => {
    // The repo requirement is no longer prose in helmsmanHints; it is derived
    // from the installed skills' real capability state. Each coding skill's
    // bundle must derive `code_repo`, so generateUnmetCapabilityEntries emits a
    // `designate_repo` post-install task while the space has no ready repo.
    for (const id of bundle.skillCatalogIds) {
      const entry = getSkillCatalogEntry(id);
      if (!entry) throw new Error(`skill "${id}" must resolve`);
      expect(deriveRequiredCapabilities(entry.bundle), id).toContain(CODE_REPO_CAPABILITY_ID);
    }
  });

  it('no longer carries repo-setup prose in helmsmanHints (now derived)', () => {
    const hints = bundle.helmsmanHints.join('\n').toLowerCase();
    expect(hints).not.toContain('add your repository');
    expect(hints).not.toContain('paste a github token');
    expect(hints).not.toContain('designate');
  });
});
