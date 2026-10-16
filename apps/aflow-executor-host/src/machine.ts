/**
 * What this machine offers a model runtime on it (Plan 323 D8), for the
 * inventory.
 *
 * The figure that decides fit is the GPU working set, and nothing cheap
 * reports it: on Apple silicon it is Metal's `recommendedMaxWorkingSetSize`,
 * which no `sysctl` carries and Ollama logs but does not serve. Reading it
 * through Metal compiles a one-line Swift program, which takes seconds to
 * minutes, so it is read once in the background and cached beside the policy
 * file, keyed by the machine's memory and OS release so an upgrade reads it
 * again. Until it is read — or where it cannot be — it is absent, and fit
 * says it does not know rather than guessing.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { HostMachine } from '@aflow/redis';

const CACHE_FILE = 'machine.json';
/** A first `swift` run compiles its toolchain's caches; minutes, not seconds. */
const PROBE_TIMEOUT_MS = 300_000;
const METAL_PROBE =
  'import Metal; print(MTLCreateSystemDefaultDevice()?.recommendedMaxWorkingSetSize ?? 0)';

interface CachedReading {
  totalMemoryBytes: number;
  osRelease: string;
  gpuWorkingSetBytes: number;
}

export type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const runCommand: RunCommand = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error(`${file} failed: ${error.message}`, { cause: error }));
      else resolve(stdout);
    });
  });

function positive(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function readGpuWorkingSet(platform: string, run: RunCommand): Promise<number | undefined> {
  if (platform === 'darwin') {
    return positive(await run('swift', ['-e', METAL_PROBE], PROBE_TIMEOUT_MS));
  }
  // A discrete GPU's memory is the device's own; the largest one is what a
  // model that does not split across devices can use.
  const out = await run(
    'nvidia-smi',
    ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
    PROBE_TIMEOUT_MS,
  );
  const mib = out
    .split('\n')
    .map(positive)
    .filter((v): v is number => v !== undefined);
  return mib.length > 0 ? Math.max(...mib) * 1024 ** 2 : undefined;
}

export interface MachineReader {
  /** The machine as read so far; the GPU figure arrives once the probe has run. */
  current(): HostMachine;
  /** Reads the GPU figure, from the cache when it still describes this machine. */
  start(): Promise<void>;
}

export function createMachineReader(options: {
  hostDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemoryBytes?: number;
  osRelease?: string;
  run?: RunCommand;
}): MachineReader {
  const platform = options.platform ?? process.platform;
  const totalMemoryBytes = options.totalMemoryBytes ?? os.totalmem();
  const osRelease = options.osRelease ?? os.release();
  const run = options.run ?? runCommand;
  const cachePath = join(options.hostDir, CACHE_FILE);
  const machine: HostMachine = {
    totalMemoryBytes,
    unifiedMemory: platform === 'darwin' && (options.arch ?? process.arch) === 'arm64',
  };

  return {
    current: () => ({ ...machine }),
    async start() {
      const cached = await readFile(cachePath, 'utf8')
        .then((text) => JSON.parse(text) as CachedReading)
        .catch(() => undefined);
      if (
        cached?.totalMemoryBytes === totalMemoryBytes &&
        cached.osRelease === osRelease &&
        cached.gpuWorkingSetBytes > 0
      ) {
        machine.gpuWorkingSetBytes = cached.gpuWorkingSetBytes;
        return;
      }
      const gpu = await readGpuWorkingSet(platform, run).catch(() => undefined);
      if (gpu === undefined) return;
      machine.gpuWorkingSetBytes = gpu;
      const reading: CachedReading = { totalMemoryBytes, osRelease, gpuWorkingSetBytes: gpu };
      await writeFile(cachePath, `${JSON.stringify(reading)}\n`).catch(() => undefined);
    },
  };
}
