import { describe, it, expect } from 'vitest';
import { builtInModels, retiredModels } from './catalogModels.js';
import { createDefaultModelCatalog } from './catalog.js';

describe('model retirement', () => {
  const liveIds = new Set(builtInModels.map((m) => m.id));
  const liveAliases = new Set(builtInModels.flatMap((m) => m.aliases ?? []));

  it('names a live successor for every retired model', () => {
    for (const [retired, successor] of Object.entries(retiredModels)) {
      expect(liveIds.has(successor), `${retired} → ${successor} names no live model`).toBe(true);
    }
  });

  it('keeps retired ids out of the live lineup', () => {
    // A retirement shadowing a live id or alias would be read as the dead entry
    // on one surface and the live one on another.
    for (const retired of Object.keys(retiredModels)) {
      expect(liveIds.has(retired), `${retired} is retired and live`).toBe(false);
      expect(liveAliases.has(retired), `${retired} is retired and an alias`).toBe(false);
    }
  });

  it('resolves a retired ref to its successor', () => {
    const catalog = createDefaultModelCatalog();
    for (const [retired, successor] of Object.entries(retiredModels)) {
      expect(catalog.getModel(retired)?.id).toBe(successor);
    }
  });

  it('leaves a model that never existed unresolved', () => {
    expect(
      createDefaultModelCatalog().getModel('accounts/fireworks/models/not-a-model'),
    ).toBeUndefined();
  });

  it('does not offer retired models for selection', () => {
    const listed = new Set(
      createDefaultModelCatalog()
        .listModels()
        .map((m) => m.id),
    );
    for (const retired of Object.keys(retiredModels)) {
      expect(listed.has(retired)).toBe(false);
    }
  });
});
