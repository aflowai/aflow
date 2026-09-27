import { describe, expect, it } from 'vitest';
import {
  MEDIA_ROUTE_CAPABILITIES,
  mediaRouteCapability,
  mediaRouteReferenceLimits,
} from '@aflow/schemas';
import { builtInModels } from './catalogModels.js';

/**
 * The route descriptors are what an authoring surface reads; the model
 * catalog is what the executor gates on. A model whose declared reference
 * limits disagree with its descriptor means one of the two surfaces is
 * telling a caller something the other will refuse at dispatch.
 */
describe('model catalog agrees with the route capability descriptors', () => {
  it('declares the reference limits its descriptor declares, and no others', () => {
    for (const model of builtInModels) {
      const routeKey = [model.id, ...(model.aliases ?? [])].find(
        (key) => mediaRouteCapability(key) !== undefined,
      );
      if (routeKey === undefined) {
        expect(model.capabilities.imageReferences, model.id).toBeUndefined();
        continue;
      }
      expect(model.capabilities.imageReferences, model.id).toEqual(
        mediaRouteReferenceLimits(routeKey),
      );
    }
  });

  it('names a catalog model for every wired route', () => {
    const known = new Set(builtInModels.flatMap((model) => [model.id, ...(model.aliases ?? [])]));
    for (const route of MEDIA_ROUTE_CAPABILITIES) {
      expect(known.has(route.routeKey), route.routeKey).toBe(true);
    }
  });
});
