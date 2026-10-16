import { describe, expect, it } from 'vitest';
import { describeLocalFit } from './ModelDefaultsEditor.js';
import { localFitForDraft, type SpaceLlmReadiness } from '../../hooks/useSpaceLlmReadiness.js';

const TIGHT = {
  status: 'tight' as const,
  window: 16_384,
  largestFittingWindow: 16_384,
  bytesAtWindow: 18_146_750_828,
  gpuWorkingSetBytes: 19_069_665_280,
};

describe('describeLocalFit', () => {
  it('names the window and the memory it takes against what the computer has', () => {
    expect(describeLocalFit(TIGHT)).toBe(
      "16K window, 18.1 GB of this computer's 19.1 GB of GPU memory — expect it to slow down while other apps need memory.",
    );
  });

  it('says what the computer fits when the window in use spills, and that the agents need more', () => {
    const text = describeLocalFit({
      ...TIGHT,
      status: 'does_not_fit',
      window: 32_768,
      bytesAtWindow: 20_112_910_828,
    });
    expect(text).toContain('so it will spill and run slowly');
    expect(text).toContain('fits a 16K window, smaller than the platform’s agents need');
  });
});

describe('localFitForDraft', () => {
  const readiness = {
    roles: { default: { model: 'gemma-local', localFit: TIGHT } },
  } as unknown as SpaceLlmReadiness;

  it('describes the model readiness measured', () => {
    expect(localFitForDraft(readiness, { default: 'gemma-local' })('default')).toEqual(TIGHT);
  });

  it('says nothing about a model the draft has just replaced', () => {
    expect(localFitForDraft(readiness, { default: 'sonnet' })('default')).toBeNull();
  });
});
