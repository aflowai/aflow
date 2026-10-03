import { describe, it, expect } from 'vitest';
import {
  allowedModelIds,
  canonicalModelId,
  isModelIdAllowed,
  tenantDefaultModelId,
  withTenantDefaultModels,
} from './agentModelPolicy.js';
import { offListAgentModelRefs } from '../routes/spacesShared.js';

const GLM_ID = 'accounts/fireworks/models/glm-5p3';

describe('canonical comparison', () => {
  it('resolves an alias and an id to the same model', () => {
    expect(canonicalModelId('luna')).toBe('gpt-6-luna');
    expect(canonicalModelId('gpt-6-luna')).toBe('gpt-6-luna');
    expect(canonicalModelId('glm-pro')).toBe(GLM_ID);
  });

  it('admits a directive alias against an allowlist stored as ids', () => {
    // The gate's original bug: default directives hold `glm-pro`, the Settings
    // page saves catalog ids, and comparing the strings refused the same model.
    const allowed = allowedModelIds([GLM_ID]);
    expect(isModelIdAllowed('glm-pro', allowed)).toBe(true);
    expect(isModelIdAllowed(GLM_ID, allowed)).toBe(true);
  });

  it('admits an id against an allowlist stored as an alias', () => {
    const allowed = allowedModelIds(['luna']);
    expect(isModelIdAllowed('gpt-6-luna', allowed)).toBe(true);
  });

  it('still refuses a model the tenant did not enable', () => {
    expect(isModelIdAllowed('claude-sonnet-5-5', allowedModelIds(['luna']))).toBe(false);
  });

  it('refuses a ref that names no model', () => {
    expect(isModelIdAllowed('not-a-model', allowedModelIds(['luna']))).toBe(false);
  });

  it('falls back to the platform recommendations when the tenant never chose', () => {
    expect(isModelIdAllowed('claude-sonnet-5-5', allowedModelIds(null))).toBe(true);
  });
});

describe('tenantDefaultModelId', () => {
  it('keeps the platform default when the tenant allows it', () => {
    expect(tenantDefaultModelId(allowedModelIds([GLM_ID, 'gpt-6-luna']))).toBe(GLM_ID);
  });

  it('picks one the tenant does allow when the platform default is excluded', () => {
    expect(tenantDefaultModelId(allowedModelIds(['gpt-6-luna']))).toBe('gpt-6-luna');
  });
});

describe('withTenantDefaultModels', () => {
  const NONE: ReadonlySet<string> = new Set();

  it('rehomes a default the caller never named', () => {
    // Space creation carries `glm-pro` from a Zod default even when the caller
    // never named a model; without this every create would 400 for a tenant
    // that excludes GLM.
    const allowed = allowedModelIds(['gemini-3.8-flash']);
    const out = withTenantDefaultModels({ modelDefaults: { default: 'glm-pro' } }, allowed, NONE);
    expect(out.modelDefaults?.['default']).toBe('gemini-3.8-flash');
  });

  it('leaves an explicitly requested model alone, even the platform default', () => {
    // Substituting here would hand the caller a space running a model they did
    // not choose; the gate refuses the request instead.
    const allowed = allowedModelIds(['gemini-3.8-flash']);
    const out = withTenantDefaultModels(
      { modelDefaults: { default: 'glm-pro' } },
      allowed,
      new Set(['default']),
    );
    expect(out.modelDefaults?.['default']).toBe('glm-pro');
  });

  it('leaves a deliberately chosen other model alone for the gate to refuse', () => {
    const allowed = allowedModelIds(['gemini-3.8-flash']);
    const out = withTenantDefaultModels(
      { modelDefaults: { default: 'claude-sonnet-5-5' } },
      allowed,
      new Set(['default']),
    );
    expect(out.modelDefaults?.['default']).toBe('claude-sonnet-5-5');
  });

  it('leaves an allowed default untouched', () => {
    const allowed = allowedModelIds([GLM_ID]);
    const out = withTenantDefaultModels({ modelDefaults: { default: 'glm-pro' } }, allowed, NONE);
    expect(out.modelDefaults?.['default']).toBe('glm-pro');
  });

  it('rehomes only the roles the caller left unnamed', () => {
    const allowed = allowedModelIds(['gpt-6-luna']);
    const out = withTenantDefaultModels(
      { modelDefaults: { default: 'glm-pro', runner: 'glm-pro', coach: 'gpt-6-luna' } },
      allowed,
      new Set(['runner']),
    );
    expect(out.modelDefaults).toEqual({
      default: 'gpt-6-luna',
      runner: 'glm-pro',
      coach: 'gpt-6-luna',
    });
  });
});

describe('the Clerk against the same gate', () => {
  const recommended = { ids: allowedModelIds(null), explicit: false };

  it('lets every value its picker can produce be saved', () => {
    // Each of these was refused before the gate learned the role: the two
    // modes resolve to no model at all, and the small models the Clerk exists
    // to use are absent from the foreground lineup. What survived was only the
    // expensive models the role exists to avoid.
    for (const value of ['auto', 'space_default', 'glm-flash', 'haiku', 'gpt-mini']) {
      expect(offListAgentModelRefs({ modelDefaults: { clerk: value } }, recommended)).toEqual([]);
    }
  });

  it('still holds the Clerk to a tenant that named its own set', () => {
    const strict = { ids: allowedModelIds(['sonnet']), explicit: true };
    expect(offListAgentModelRefs({ modelDefaults: { clerk: 'glm-flash' } }, strict)).toEqual([
      'glm-flash',
    ]);
    // The modes stay assignable: they name no model, so there is nothing for
    // an allowlist to refuse. Resolution honours the same set at run time and
    // reports that it found nothing permitted.
    expect(offListAgentModelRefs({ modelDefaults: { clerk: 'auto' } }, strict)).toEqual([]);
  });

  it('does not widen any other role', () => {
    expect(
      offListAgentModelRefs({ modelDefaults: { helmsman: 'glm-flash' } }, recommended),
    ).toEqual(['glm-flash']);
  });

  it('leaves a Clerk mode alone when filling tenant defaults', () => {
    // The filler runs before the gate. Reading `auto` as an unassignable ref
    // replaces the operator's "pick one for me" with a pinned foreground model.
    const allowed = allowedModelIds([GLM_ID]);
    const filled = withTenantDefaultModels(
      { modelDefaults: { clerk: 'auto', helmsman: 'some-retired-model' } },
      allowed,
      new Set<string>(),
    );
    expect(filled.modelDefaults).toEqual({
      clerk: 'auto',
      helmsman: tenantDefaultModelId(allowed),
    });
  });
});
