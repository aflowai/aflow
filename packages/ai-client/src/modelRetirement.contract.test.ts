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

  it('resolves a model-line alias to the current model of that line', () => {
    // An alias that is a model's name follows the name across generations, so
    // a stored `sol` is never served by a model called something else.
    const catalog = createDefaultModelCatalog();
    expect(catalog.getModel('sol')?.id).toBe('gpt-6.1-sol');
    expect(catalog.getModel('gpt-5.6-sol')?.id).toBe('gpt-6.1-sol');
    expect(catalog.getModel('astra')?.id).toBe('gpt-6-astra');
    expect(catalog.getModel('gpt')?.id).toBe('gpt-6.1-sol');
    expect(catalog.getModel('luna')?.id).toBe('gpt-6-luna');
    expect(catalog.getModel('sonnet')?.id).toBe('claude-sonnet-5-5');
    expect(catalog.getModel('opus')?.id).toBe('claude-opus-5-5');
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
