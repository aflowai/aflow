/**
 * What a resumed flow starts the model step from.
 *
 * The step writes the whole `modelDefaults` object back, so whatever it starts
 * from is what the workspace ends up with. Starting from the recommendation
 * would replace a configured default and delete every role override the moment
 * the operator pressed Continue — on a workspace they were sent to set up, and
 * without showing them either change.
 */
import { describe, expect, it } from 'vitest';
import { selectionFromDirectives } from './onboarding-flow';

describe('the selection a resumed workspace starts from', () => {
  it('is the one the workspace already holds', () => {
    expect(
      selectionFromDirectives({
        modelDefaults: { default: 'glm-pro', coach: 'claude-sonnet-5' },
      }),
    ).toEqual({ defaultRef: 'glm-pro', roleOverrides: { coach: 'claude-sonnet-5' } });
  });

  /** The workspace is running on it, whatever the recommendation set says. */
  it('keeps a default the recommendations do not contain', () => {
    expect(selectionFromDirectives({ modelDefaults: { default: 'some-private-model' } })).toEqual({
      defaultRef: 'some-private-model',
      roleOverrides: {},
    });
  });

  it('carries every role override, not just the first', () => {
    const { roleOverrides } = selectionFromDirectives({
      modelDefaults: { default: 'a', helmsman: 'b', runner: 'c', coach: 'd', judge: 'e' },
    });
    expect(roleOverrides).toEqual({ helmsman: 'b', runner: 'c', coach: 'd', judge: 'e' });
  });

  it('ignores keys that are not roles', () => {
    const { roleOverrides } = selectionFromDirectives({
      modelDefaults: { default: 'a', notARole: 'b' },
    });
    expect(roleOverrides).toEqual({});
  });

  it('reads an unconfigured workspace as no choice yet, so the recommendation stands', () => {
    for (const directives of [null, {}, { modelDefaults: {} }]) {
      expect(selectionFromDirectives(directives)).toEqual({ defaultRef: '', roleOverrides: {} });
    }
  });
});
