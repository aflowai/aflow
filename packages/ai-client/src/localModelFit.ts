/**
 * Whether a model on the operator's machine fits it, and the largest window
 * that does (Plan 323 D8).
 *
 * A model costs its weights plus a constant per context token, and on the MLX
 * runner a loaded model's cache climbs to its whole window and stays there
 * until it unloads (§9 G6) — so fit is computed for the full window, never for
 * the prompt in hand. The ceiling is the GPU working set: past it the model
 * does not fail, it spills, and every request slows with the machine.
 */
import { OLLAMA_DEFAULT_CONTEXT_TOKENS } from '@aflow/schemas';
import type { LocalModelFootprint } from './types.js';

/** What the machine the runtime runs on offers a model. */
export interface LocalMachine {
  totalMemoryBytes: number;
  /** Metal's working set on Apple silicon; VRAM on a discrete GPU. Absent when it could not be read. */
  gpuWorkingSetBytes?: number | undefined;
  /** The GPU shares the machine's memory (Apple silicon), so a model competes with everything else for it. */
  unifiedMemory: boolean;
}

/** Windows are offered in these steps, so a figure an operator reads is a familiar one. */
export const WINDOW_STEP_TOKENS = 4096;
/**
 * The smallest window the platform's own agents run in. Helmsman's first
 * prompt, before a word of conversation, is about 18K tokens of instructions
 * and tool definitions (§9, P1 on the dev stack), so a smaller window refuses
 * it outright. A machine that fits less gets this window and is told the model
 * will spill: slow is better than refused.
 */
export const MIN_USEFUL_WINDOW_TOKENS = OLLAMA_DEFAULT_CONTEXT_TOKENS;
/** Held back by the runtime for itself (Ollama's `minimum` in its GPU memory report). */
export const RUNTIME_GPU_RESERVE_BYTES = 512 * 1024 ** 2;
/**
 * What the operating system, the stack and a browser take beside the model on
 * unified memory: on the 24 GB machine, with Postgres, Redis, the services and
 * a browser running, a 16 GB model left 80 MB free and 6.6 GB in swap (§9 G5).
 */
export const SYSTEM_RESERVE_BYTES = 8 * 1024 ** 3;

export type LocalModelFitStatus = 'fits' | 'tight' | 'does_not_fit' | 'unknown';

export interface LocalModelFit {
  status: LocalModelFitStatus;
  /** The largest window, in steps, that stays inside the GPU working set; absent when unknown. */
  largestFittingWindow?: number;
  /** The model's cost at `window`, for the operator to read; absent when unknown. */
  bytesAtWindow?: number;
  /** The window the answer is about. */
  window: number;
}

export function footprintBytes(
  footprint: LocalModelFootprint,
  window: number,
  parallel: number,
): number {
  return footprint.weightsBytes + footprint.kvBytesPerToken * window * parallel;
}

/**
 * The fit of a model at `window` (or, when none is given, at the largest
 * window that fits), capped by the model's own window.
 */
export function localModelFit(input: {
  footprint: LocalModelFootprint | undefined;
  machine: LocalMachine | undefined;
  catalogWindow: number;
  parallel: number;
  window?: number | undefined;
}): LocalModelFit {
  const { footprint, machine, catalogWindow, parallel } = input;
  if (!footprint || !machine?.gpuWorkingSetBytes) {
    return { status: 'unknown', window: input.window ?? catalogWindow };
  }
  const budget = machine.gpuWorkingSetBytes - RUNTIME_GPU_RESERVE_BYTES;
  const tokens = Math.floor(
    (budget - footprint.weightsBytes) / (footprint.kvBytesPerToken * parallel),
  );
  const largest = Math.min(
    catalogWindow,
    Math.floor(tokens / WINDOW_STEP_TOKENS) * WINDOW_STEP_TOKENS,
  );
  const window = input.window ?? Math.max(largest, MIN_USEFUL_WINDOW_TOKENS);
  const bytes = footprintBytes(footprint, window, parallel);
  const status: LocalModelFitStatus =
    bytes > budget
      ? 'does_not_fit'
      : machine.unifiedMemory && bytes > machine.totalMemoryBytes - SYSTEM_RESERVE_BYTES
        ? 'tight'
        : 'fits';
  return {
    status,
    window,
    bytesAtWindow: bytes,
    ...(largest > 0 ? { largestFittingWindow: largest } : {}),
  };
}
