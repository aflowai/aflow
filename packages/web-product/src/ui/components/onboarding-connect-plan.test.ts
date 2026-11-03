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
import { planAfterModelStep, readyNote, type ReadyStanding } from './onboarding-connect-plan.js';
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

  it('marks the space runnable and skips the step only for a space that can run', () => {
    expect(planAfterModelStep([], BASE)).toEqual({
      step: 'ready',
      standing: { kind: 'runnable' },
    });
  });

  it('says readiness is unread, not that a key is missing, on a space it cannot read', () => {
    expect(planAfterModelStep([], null)).toEqual({ step: 'ready', standing: { kind: 'unread' } });
  });

  it('names a dropped model ahead of the runtime, where no key entry can fix either', () => {
    const plan = planAfterModelStep([], {
      ...BASE,
      ready: false,
      unknownModelRoles: [{ role: 'default', model: 'gone-model' }],
      missingProviders: [{ providerId: 'ollama', roles: ['runner'] }],
    });
    expect(plan).toEqual({
      step: 'ready',
      standing: {
        kind: 'unknown_models',
        roles: [{ role: 'default', model: 'gone-model' }],
      },
    });
  });

  it('sends an error on this computer to its own page, with its cause and remedy', () => {
    const plan = planAfterModelStep([], {
      ...BASE,
      ready: false,
      localIssues: [
        {
          code: 'window_tight',
          severity: 'warning',
          cause: 'The machine will swap.',
          remedy: { kind: 'instruction', text: 'Close other apps.' },
        },
        {
          code: 'runtime_unreachable',
          severity: 'error',
          cause: 'Ollama does not answer.',
          remedy: { kind: 'instruction', text: 'Start Ollama.' },
        },
      ],
    });
    expect(plan).toEqual({
      step: 'ready',
      standing: { kind: 'local_runtime', message: 'Ollama does not answer. Start Ollama.' },
    });
  });

  it('reports an unconnected runtime on this computer as the runtime, not a key', () => {
    const plan = planAfterModelStep([], {
      ...BASE,
      ready: false,
      missingProviders: [{ providerId: 'ollama', roles: ['default'] }],
    });
    expect(plan).toMatchObject({ step: 'ready', standing: { kind: 'local_runtime' } });
  });

  it('does not mark runnable a space that is not ready for a reason readiness does not name', () => {
    expect(planAfterModelStep([], { ...BASE, ready: false })).toEqual({
      step: 'ready',
      standing: { kind: 'not_ready' },
    });
  });

  it('keeps the connect step for a recommended model, where readiness shows it covered', () => {
    expect(planAfterModelStep(['google'], BASE)).toEqual({
      step: 'connect',
      providers: ['google'],
    });
  });
});

describe("the ready step's note", () => {
  it('says nothing for a space that can run', () => {
    expect(readyNote({ kind: 'runnable' })).toBeNull();
  });

  it('names a missing key only where the operator skipped one', () => {
    const noted = (
      [
        { kind: 'unknown_models', roles: [{ role: 'default', model: 'gone-model' }] },
        { kind: 'local_runtime', message: 'Ollama does not answer. Start Ollama.' },
        { kind: 'not_ready' },
        { kind: 'unread' },
      ] satisfies ReadyStanding[]
    ).map((standing) => readyNote(standing)?.text ?? '');
    for (const text of noted) expect(text).not.toMatch(/key/i);
    expect(readyNote({ kind: 'no_key' })?.text).toMatch(/No key connected/);
  });

  it('sends a dropped model to the model choice, naming the model and its roles', () => {
    expect(
      readyNote({
        kind: 'unknown_models',
        roles: [
          { role: 'default', model: 'gone-model' },
          { role: 'coach', model: 'gone-model' },
        ],
      }),
    ).toEqual({
      text: 'The model gone-model is no longer available. Choose another model for default, coach before your agents can run.',
      action: 'choose_model',
    });
  });

  it("sends the runtime on this computer to its own page, in readiness's words", () => {
    expect(readyNote({ kind: 'local_runtime', message: 'Ollama does not answer.' })).toEqual({
      text: 'Ollama does not answer.',
      action: 'open_computer',
    });
  });
});
