import { describe, expect, it } from 'vitest';
import {
  PLANE_ONLY_ENDPOINT_FIELDS,
  overlayPlaneOnlyEndpointFields,
} from '../stagedChange/apiWriteHelpers.js';

const stored = {
  endpointId: 'createDeployment',
  name: 'Create deployment',
  method: 'POST',
  pathTemplate: '/v13/deployments',
  writeRiskTier: 'high',
  responseTransformPresetId: 'preset-1',
};

describe('overlayPlaneOnlyEndpointFields', () => {
  it('derives the plane-only field set (never hand-listed) and includes writeRiskTier', () => {
    expect(PLANE_ONLY_ENDPOINT_FIELDS).toContain('writeRiskTier');
    expect(PLANE_ONLY_ENDPOINT_FIELDS).toContain('responseTransformPresetId');
  });

  it('preserves stored plane-only fields on a same-id replacement', () => {
    const next = {
      endpointId: 'createDeployment',
      name: 'Create deployment v2',
      method: 'POST',
      pathTemplate: '/v14/deployments',
    };
    const [result] = overlayPlaneOnlyEndpointFields([stored], [next]);
    expect(result).toMatchObject({
      pathTemplate: '/v14/deployments',
      writeRiskTier: 'high',
      responseTransformPresetId: 'preset-1',
    });
  });

  it('passes endpoints without a stored counterpart through untouched', () => {
    const next = { endpointId: 'newOne', name: 'n', method: 'GET', pathTemplate: '/x' };
    const [result] = overlayPlaneOnlyEndpointFields([stored], [next]);
    expect(result).toEqual(next);
  });
});
