/**
 * Where onboarding goes after the model step.
 *
 * A resumed flow opens on a space that cannot run. One still holding a model
 * the recommendation dropped (`glm-pro`) names no provider through the
 * selection, and once read as a key-free model on this computer. The flow
 * then skipped the connect step and marked keys connected on a space that
 * still could not answer.
 */
import { describe, expect, it } from 'vitest';
import { planAfterModelStep } from './onboarding-connect-plan';
import type { SpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';

const BASE: SpaceLlmReadiness = {
  ready: true,
  roles: {},
  clerk: {
    mode: 'auto',
    model: null,
    modelId: null,
    providerId: null,
    credentialResolved: false,
    unavailableReason: null,
  },
  missingProviders: [],
  erroredProviders: [],
  unknownModelRoles: [],
  unverifiedProviders: [],
  hasConfiguredProvider: false,
  localIssues: [],
};

/** A space on `glm-pro` with no Fireworks key, as readiness answers for it. */
const GLM_PRO_WITHOUT_KEY: SpaceLlmReadiness = {
  ...BASE,
  ready: false,
  missingProviders: [{ providerId: 'fireworks', roles: ['default'] }],
};

describe('the step after the model step', () => {
  it('sends a space on a dropped model its keys cannot serve through the connect step', () => {
    expect(planAfterModelStep([], GLM_PRO_WITHOUT_KEY)).toEqual({
      step: 'connect',
      providers: ['fireworks'],
    });
  });

  it('asks for a key that failed its check, and for one nothing has tried', () => {
    const plan = planAfterModelStep([], {
      ...BASE,
      ready: false,
      erroredProviders: [{ providerId: 'anthropic', roles: ['coach'], lastErrorCode: '401' }],
      unverifiedProviders: [{ providerId: 'fireworks', roles: ['default'] }],
    });
    expect(plan).toEqual({ step: 'connect', providers: ['anthropic', 'fireworks'] });
  });

  it('names each provider once, the selection first', () => {
    expect(planAfterModelStep(['fireworks'], GLM_PRO_WITHOUT_KEY)).toEqual({
      step: 'connect',
      providers: ['fireworks'],
    });
  });

  it('marks keys connected and skips the step only for a space that can run', () => {
    expect(planAfterModelStep([], BASE)).toEqual({ step: 'ready', keysConnected: true });
  });

  it('does not mark keys connected on a space it cannot read', () => {
    expect(planAfterModelStep([], null)).toEqual({ step: 'ready', keysConnected: false });
  });

  it('does not mark keys connected on a space no key entry can fix', () => {
    const plan = planAfterModelStep([], {
      ...BASE,
      ready: false,
      unknownModelRoles: [{ role: 'default', model: 'gone-model' }],
      missingProviders: [{ providerId: 'ollama', roles: ['runner'] }],
    });
    expect(plan).toEqual({ step: 'ready', keysConnected: false });
  });

  it('keeps the connect step for a recommended model, where readiness shows it covered', () => {
    expect(planAfterModelStep(['google'], BASE)).toEqual({
      step: 'connect',
      providers: ['google'],
    });
  });
});
