import { describe, it, expect } from 'vitest';
import { builtInModels } from './catalogModels.js';
import { REASONING_EFFORT_LADDER } from './types.js';

/**
 * Pins the two halves of the reasoning declaration to each other.
 *
 * `capabilities.reasoning` decides whether the client forwards reasoning params
 * at all; `reasoning.supported` decides which ones survive the clamp. Declaring
 * one without the other produces a model that either takes config it cannot use
 * or carries config that silently never applies — the second is how Kimi K2.6
 * kept paying for thinking tokens it was configured to turn off.
 */
describe('model reasoning profile ↔ capability contract', () => {
  const chatModels = builtInModels.filter((m) => m.capabilities.chat);

  it('every chat model that declares reasoning carries a profile', () => {
    for (const model of chatModels) {
      if (model.capabilities.reasoning !== true) continue;
      expect(model.reasoning, `${model.id} declares reasoning but has no profile`).toBeDefined();
      expect(
        model.reasoning?.supported.length,
        `${model.id} has an empty supported set`,
      ).toBeGreaterThan(0);
    }
  });

  it('no non-chat model carries a profile', () => {
    // The effort ladder is a text-generation control. An image model may think
    // internally, but nothing on its path sends a rung, so a profile there
    // would be a promise no code keeps.
    for (const model of builtInModels) {
      if (model.capabilities.chat) continue;
      expect(
        model.reasoning,
        `${model.id} is not chat-capable but carries a profile`,
      ).toBeUndefined();
    }
  });

  it('no model carries a profile the client would never forward', () => {
    for (const model of builtInModels) {
      if (!model.reasoning) continue;
      expect(
        model.capabilities.reasoning,
        `${model.id} has a reasoning profile but does not declare capabilities.reasoning, ` +
          `so the client drops it and the profile is dead config`,
      ).toBe(true);
    }
  });

  it('every declared rung is a real rung, listed once', () => {
    for (const model of builtInModels) {
      const supported = model.reasoning?.supported;
      if (!supported) continue;
      for (const effort of supported) {
        expect(REASONING_EFFORT_LADDER, `${model.id} lists unknown effort ${effort}`).toContain(
          effort,
        );
      }
      expect(new Set(supported).size, `${model.id} lists a duplicate rung`).toBe(supported.length);
    }
  });

  it('a declared default is one the model actually accepts', () => {
    for (const model of builtInModels) {
      const profile = model.reasoning;
      if (!profile?.default) continue;
      expect(
        profile.supported,
        `${model.id} defaults to ${profile.default}, which is not in its supported set`,
      ).toContain(profile.default);
    }
  });
});
