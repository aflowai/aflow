import { describe, expect, it } from 'vitest';
import { createDefaultModelCatalog } from './catalog.js';
import { diagnoseLocalRuntime, type LocalRuntimeObservation } from './localRuntimeDiagnostics.js';
import type { LoadedLocalModel, InstalledLocalModel } from './providers/ollamaRuntime.js';
import type { ModelDefinition, ProviderConfig } from './types.js';

const GB = 1e9;
const gemma = createDefaultModelCatalog().getModel('ollama-gemma4-26b')!;
const M3_24GB = {
  totalMemoryBytes: 24 * 1024 ** 3,
  gpuWorkingSetBytes: 19_069_665_280,
  unifiedMemory: true,
};
const M4_64GB = {
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuWorkingSetBytes: 48 * 1024 ** 3,
  unifiedMemory: true,
};

const installed: InstalledLocalModel = {
  tag: 'gemma4:26b',
  sizeBytes: 16_146_867_483,
  digest: gemma.local!.digest,
  remoteHost: null,
};

function observe(over: Partial<LocalRuntimeObservation> = {}): LocalRuntimeObservation {
  return {
    baseUrl: 'http://127.0.0.1:11434',
    version: '0.40.5',
    installed: [installed],
    loaded: [],
    ...over,
  };
}

function diagnose(
  connection: ProviderConfig,
  over: Partial<LocalRuntimeObservation> = {},
  models: ModelDefinition[] = [gemma],
  roles: Record<string, string> = { default: gemma.id, helmsman: gemma.id },
) {
  return diagnoseLocalRuntime({ observation: observe(over), connection, models, roles });
}

const codes = (d: ReturnType<typeof diagnose>) => d.issues.map((i) => i.code);

describe('diagnoseLocalRuntime', () => {
  it('says only that the runtime is down when it does not answer, with how to start it', () => {
    const d = diagnose({ machine: M3_24GB }, { version: null, installed: null, loaded: null });
    expect(d.runtime.reachable).toBe(false);
    expect(d.issues).toHaveLength(1);
    expect(d.issues[0]).toMatchObject({ code: 'runtime_unreachable', severity: 'error' });
    expect(d.issues[0]!.remedy).toMatchObject({ kind: 'instruction' });
  });

  it('offers to start the runtime where this machine’s executor can start it', () => {
    const d = diagnoseLocalRuntime({
      observation: observe({ version: null, installed: null, loaded: null }),
      connection: { machine: M3_24GB },
      models: [gemma],
      roles: { default: gemma.id },
      startable: true,
    });
    expect(d.issues[0]!.remedy).toEqual({
      kind: 'action',
      action: { action: 'start_runtime' },
      label: 'Start Ollama',
    });
  });

  it('offers the download, with its size, for a role whose model is not downloaded', () => {
    const d = diagnose({ machine: M4_64GB }, { installed: [] });
    expect(d.issues).toEqual([
      expect.objectContaining({
        code: 'model_not_installed',
        severity: 'error',
        remedy: {
          kind: 'action',
          action: { action: 'pull', model: gemma.id },
          label: 'Download Gemma 4 26B (this computer) (16.1 GB)',
        },
      }),
    ]);
  });

  it('reports nothing wrong on a machine that fits the model at its full window', () => {
    const d = diagnose({ machine: M4_64GB });
    expect(d.issues).toEqual([]);
    expect(d.models[0]).toMatchObject({
      installed: true,
      build: 'verified',
      roles: ['default', 'helmsman'],
    });
    expect(d.models[0]!.fit.status).toBe('fits');
  });

  it('says the 24 GB machine spills at the agents’ window, with nothing in Aflow to fix it', () => {
    const d = diagnose({ machine: M3_24GB });
    expect(codes(d)).toEqual(['window_does_not_fit']);
    expect(d.issues[0]!.remedy.kind).toBe('instruction');
  });

  it('hands a configured window larger than the machine fits back to the machine', () => {
    const fits90k = {
      totalMemoryBytes: 36 * 1024 ** 3,
      gpuWorkingSetBytes: 28 * GB,
      unifiedMemory: true,
    };
    const d = diagnose({ machine: fits90k, contextTokens: 262_144 });
    expect(d.issues[0]).toMatchObject({
      code: 'window_does_not_fit',
      remedy: { kind: 'action', action: { action: 'set_context', contextTokens: null } },
    });
  });

  it('replaces the estimate with what is loaded: a model past the GPU is spilling, and unloading frees it', () => {
    const loaded: LoadedLocalModel = {
      tag: 'gemma4:26b',
      sizeBytes: 22.7 * GB,
      gpuBytes: 22.7 * GB,
      contextLength: 32_768,
      expiresAt: null,
      runner: 'mlx',
    };
    const d = diagnose({ machine: M3_24GB }, { loaded: [loaded] });
    expect(codes(d)).toEqual(['model_spilling']);
    expect(d.issues[0]!.remedy).toMatchObject({ action: { action: 'unload', model: gemma.id } });
  });

  it('names the part of a loaded model on the CPU', () => {
    const loaded: LoadedLocalModel = {
      tag: 'gemma4:26b',
      sizeBytes: 30 * GB,
      gpuBytes: 20 * GB,
      contextLength: 131_072,
      expiresAt: null,
      runner: 'llamacpp',
    };
    const d = diagnose({ machine: M4_64GB, contextTokens: 131_072 }, { loaded: [loaded] });
    expect(d.issues[0]).toMatchObject({ code: 'model_partly_on_cpu' });
    expect(d.issues[0]!.cause).toContain('10.0 GB of');
    expect(d.issues[0]!.cause).toContain('128K window');
  });

  it('marks a downloaded build other than the measured one as unverified', () => {
    const d = diagnose({ machine: M4_64GB }, { installed: [{ ...installed, digest: 'other' }] });
    expect(d.models[0]!.build).toBe('unverified');
    expect(codes(d)).toEqual(['build_unverified']);
  });

  it('offers one model for every role when roles use two, naming what each switch costs', () => {
    const other: ModelDefinition = {
      ...gemma,
      id: 'ollama-other',
      providerModelId: 'other:7b',
      displayName: 'Other',
      local: { ...gemma.local!, runtimeTag: 'other:7b' },
    };
    const d = diagnose(
      { machine: M4_64GB },
      { installed: [installed, { ...installed, tag: 'other:7b' }] },
      [gemma, other],
      { default: gemma.id, helmsman: gemma.id, judge: other.id },
    );
    const mixed = d.issues.find((i) => i.code === 'mixed_local_models');
    expect(mixed?.remedy).toMatchObject({
      action: { action: 'use_for_every_role', model: gemma.id },
    });
    expect(mixed?.cause).toContain('each switch between them loads a model');
  });
});
