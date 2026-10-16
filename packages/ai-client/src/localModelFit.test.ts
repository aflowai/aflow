import { describe, expect, it } from 'vitest';
import { createAIClient } from './client.js';
import { localModelFit } from './localModelFit.js';

const GB = 1e9;
const GEMMA = { weightsBytes: 16_180_670_828, kvBytesPerToken: 120_000 };
const M3_24GB = {
  totalMemoryBytes: 25_769_803_776,
  gpuWorkingSetBytes: 19_069_665_280,
  unifiedMemory: true,
};
const MAC_64GB = {
  totalMemoryBytes: 68_719_476_736,
  gpuWorkingSetBytes: 51_539_607_552,
  unifiedMemory: true,
};

describe('localModelFit', () => {
  it('never sizes below the window the platform’s agents need, and says the model will spill', () => {
    // The 24 GB machine fits 16K, and Helmsman's first prompt alone is ~18K.
    const fit = localModelFit({
      footprint: GEMMA,
      machine: M3_24GB,
      catalogWindow: 262_144,
      parallel: 1,
    });
    expect(fit).toMatchObject({
      window: 32_768,
      status: 'does_not_fit',
      largestFittingWindow: 16_384,
    });
  });

  it('calls a window inside the GPU working set but crowding the machine’s memory tight', () => {
    const fit = localModelFit({
      footprint: GEMMA,
      machine: M3_24GB,
      catalogWindow: 262_144,
      parallel: 1,
      window: 16_384,
    });
    expect(fit).toMatchObject({ status: 'tight', window: 16_384 });
    expect(fit.bytesAtWindow).toBeLessThan(M3_24GB.gpuWorkingSetBytes);
  });

  it('gives a large machine the model’s whole window', () => {
    const fit = localModelFit({
      footprint: GEMMA,
      machine: MAC_64GB,
      catalogWindow: 262_144,
      parallel: 1,
    });
    expect(fit).toMatchObject({ window: 262_144, status: 'fits' });
  });

  it('sizes for every request served at once, since each holds a window', () => {
    const one = localModelFit({
      footprint: GEMMA,
      machine: MAC_64GB,
      catalogWindow: 262_144,
      parallel: 1,
    });
    const four = localModelFit({
      footprint: GEMMA,
      machine: MAC_64GB,
      catalogWindow: 262_144,
      parallel: 4,
    });
    expect(four.window).toBeLessThan(one.window);
  });

  it('reports a configured window that spills as not fitting, and keeps it', () => {
    const fit = localModelFit({
      footprint: GEMMA,
      machine: M3_24GB,
      catalogWindow: 262_144,
      parallel: 1,
      window: 32_768,
    });
    expect(fit).toMatchObject({
      window: 32_768,
      status: 'does_not_fit',
      largestFittingWindow: 16_384,
    });
  });

  it('reports a model whose weights alone fill the GPU as not fitting at any window', () => {
    const fit = localModelFit({
      footprint: { weightsBytes: 65 * GB, kvBytesPerToken: 120_000 },
      machine: M3_24GB,
      catalogWindow: 131_072,
      parallel: 1,
    });
    expect(fit.status).toBe('does_not_fit');
  });

  it('does not call a discrete GPU tight for the memory the operating system uses', () => {
    const rtx = {
      totalMemoryBytes: 32 * GB,
      gpuWorkingSetBytes: 24 * 1024 ** 3,
      unifiedMemory: false,
    };
    expect(
      localModelFit({ footprint: GEMMA, machine: rtx, catalogWindow: 262_144, parallel: 1 }).status,
    ).toBe('fits');
  });

  it('says it does not know when the machine has not been read', () => {
    expect(
      localModelFit({ footprint: GEMMA, machine: undefined, catalogWindow: 262_144, parallel: 1 })
        .status,
    ).toBe('unknown');
  });
});

describe('the window a request is sent with', () => {
  it('is the largest that fits when the connection sets none', () => {
    const client = createAIClient({
      providers: { ollama: { machine: MAC_64GB } },
      defaultProvider: 'ollama',
    });
    expect(client.contextWindowFor('gemma-local')).toBe(262_144);
  });

  it('is the agents’ floor on a machine that fits less', () => {
    const client = createAIClient({
      providers: { ollama: { machine: M3_24GB } },
      defaultProvider: 'ollama',
    });
    expect(client.contextWindowFor('gemma-local')).toBe(32_768);
  });

  it('is the operator’s when the connection sets one, fitting or not', () => {
    const client = createAIClient({
      providers: { ollama: { machine: M3_24GB, contextTokens: 65_536 } },
      defaultProvider: 'ollama',
    });
    expect(client.contextWindowFor('gemma-local')).toBe(65_536);
  });

  it('is a conservative 32K when the machine is unknown', () => {
    const client = createAIClient({ providers: { ollama: {} }, defaultProvider: 'ollama' });
    expect(client.contextWindowFor('gemma-local')).toBe(32_768);
  });
});
