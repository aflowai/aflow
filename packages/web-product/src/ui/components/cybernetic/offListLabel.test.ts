/**
 * Whose set left a held model out, as the operator reads it in the picker.
 *
 * A tenant that never named an allowlist follows the platform recommendation.
 * A model the platform stopped recommending is then not one the tenant
 * restricted, and the label must not blame the tenant for it. The mapping runs
 * through two places — the policy source onto `ModelOption.offListBy`, then
 * `offListBy` onto the words — so these cases go through both.
 */
import { describe, expect, it } from 'vitest';
import { offListSuffix } from './ModelDefaultsEditor.js';
import { agentModelOptions, type CatalogModel } from '../../hooks/useChatModelOptions.js';

const GLM_PRO: CatalogModel = {
  modelId: 'accounts/fireworks/models/glm-5p3',
  provider: 'fireworks',
  displayName: 'GLM 5.3',
  aliases: ['glm-pro', 'glm-5.3'],
};
const GLM_FLASH: CatalogModel = {
  modelId: 'accounts/fireworks/models/glm-5p3-flash',
  provider: 'fireworks',
  displayName: 'GLM 5.3 Flash',
  aliases: ['glm-flash', 'glm-5.3-flash'],
};

/** The label of the model a space holds outside the set, under one policy source. */
function heldLabel(source: 'tenant' | 'platform'): string {
  const options = agentModelOptions(
    [GLM_PRO, GLM_FLASH],
    { modelIds: [GLM_FLASH.modelId], source },
    ['glm-pro'],
  );
  const held = options.find((o) => o.id === GLM_PRO.modelId);
  if (!held) throw new Error('the held model is not listed');
  return offListSuffix(held);
}

describe('the label on a held model outside the assignable set', () => {
  it('reads "no longer recommended" when the platform recommendation dropped it', () => {
    expect(heldLabel('platform')).toBe(' — no longer recommended');
  });

  it('reads "no longer permitted" when a tenant custom set left it out', () => {
    expect(heldLabel('tenant')).toBe(' — no longer permitted');
  });

  it('records the policy source on the option, so the two sources cannot trade places', () => {
    const [platform, tenant] = (['platform', 'tenant'] as const).map((source) =>
      agentModelOptions([GLM_PRO], { modelIds: [], source }, ['glm-pro']),
    );
    expect(platform?.[0]).toMatchObject({ allowed: false, offListBy: 'platform' });
    expect(tenant?.[0]).toMatchObject({ allowed: false, offListBy: 'tenant' });
  });

  it('carries no label on a model the set still holds', () => {
    for (const source of ['platform', 'tenant'] as const) {
      const [option] = agentModelOptions([GLM_FLASH], { modelIds: ['glm-flash'], source }, []);
      expect(option).toMatchObject({ allowed: true, offListBy: null });
      expect(option && offListSuffix(option)).toBe('');
    }
  });
});
