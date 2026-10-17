import { describe, expect, it } from 'vitest';
import type { LocalRuntimeDiagnostics } from '@aflow/schemas';
import { localRuntimeChangeRequest } from '../proposal.js';

const GEMMA = 'ollama-gemma4-26b';

function diagnostics(loadedBytes: number | null): LocalRuntimeDiagnostics {
  return {
    runtime: { baseUrl: 'http://127.0.0.1:11434', reachable: true, version: '0.40.5' },
    machine: { totalMemoryBytes: 24e9, gpuWorkingSetBytes: 19.07e9, freeDiskBytes: 195e9 },
    connection: { contextTokens: null, keepAlive: null, parallel: 1 },
    models: [
      {
        model: GEMMA,
        ref: 'gemma-local',
        tag: 'gemma4:26b',
        displayName: 'Gemma 4 26B (this computer)',
        installed: true,
        downloadBytes: 16.1e9,
        roles: ['default', 'helmsman'],
        fit: {
          status: 'does_not_fit',
          window: 32_768,
          largestFittingWindow: 16_384,
          bytesAtWindow: 20.1e9,
        },
        loaded:
          loadedBytes === null
            ? null
            : {
                sizeBytes: loadedBytes,
                gpuBytes: loadedBytes,
                contextLength: 32_768,
                expiresAt: null,
              },
        build: 'verified',
        pull: null,
      },
    ],
    issues: [],
  };
}

const unload = (inFlightRequests: number, loadedBytes: number | null = 22.7e9) =>
  localRuntimeChangeRequest({
    operationId: 'model.runtime.change',
    change: { action: 'unload', model: GEMMA },
    diagnostics: diagnostics(loadedBytes),
    inFlightRequests,
    askingModel: GEMMA,
  });

describe('a proposed change to the model runtime', () => {
  it('names the requests an unload ends and that this conversation loads the model again', () => {
    const request = unload(2);
    expect(request.modelName).toBe('Gemma 4 26B (this computer)');
    expect(request.impact).toEqual({
      inFlightRequests: 2,
      ownConversationReloads: true,
      notes: ['Frees 22.7 GB and every conversation it holds.'],
    });
  });

  it('asks again when what it reaches has moved since the card was shown', () => {
    const elsewhere = localRuntimeChangeRequest({
      operationId: 'model.runtime.change',
      change: { action: 'unload', model: GEMMA },
      diagnostics: diagnostics(22.7e9),
      inFlightRequests: 0,
      askingModel: undefined,
    });
    expect(elsewhere.requestHash).not.toBe(unload(0).requestHash);
  });

  it('keeps one request across figures that move by the second', () => {
    expect(unload(1).requestHash).toBe(unload(0).requestHash);
    expect(unload(0, 18e9).requestHash).toBe(unload(0).requestHash);
  });

  it('counts no ended requests for a change that ends none', () => {
    const request = localRuntimeChangeRequest({
      operationId: 'model.runtime.change',
      change: { action: 'pull', model: GEMMA },
      diagnostics: diagnostics(null),
      inFlightRequests: 3,
      askingModel: GEMMA,
    });
    expect(request.impact.inFlightRequests).toBe(0);
    expect(request.impact.ownConversationReloads).toBe(false);
    expect(request.impact.notes[0]).toBe('Downloads 16.1 GB of the 195.0 GB free on disk.');
  });
});
