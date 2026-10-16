import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMachineReader } from '../machine.js';

const GIB = 1024 ** 3;

async function hostDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aflow-machine-'));
}

describe('createMachineReader', () => {
  it('reads Metal’s working set on Apple silicon once and keeps it for the next start', async () => {
    const dir = await hostDir();
    const run = vi.fn(async () => '19069665280\n');
    const options = {
      hostDir: dir,
      platform: 'darwin' as const,
      arch: 'arm64',
      totalMemoryBytes: 24 * GIB,
      osRelease: '25.3.0',
      run,
    };

    const first = createMachineReader(options);
    expect(first.current()).toEqual({ totalMemoryBytes: 24 * GIB, unifiedMemory: true });
    await first.start();
    expect(first.current().gpuWorkingSetBytes).toBe(19_069_665_280);

    const second = createMachineReader(options);
    await second.start();
    expect(second.current().gpuWorkingSetBytes).toBe(19_069_665_280);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reads it again once the machine or its OS has changed', async () => {
    const dir = await hostDir();
    await writeFile(
      join(dir, 'machine.json'),
      JSON.stringify({ totalMemoryBytes: 24 * GIB, osRelease: '25.2.0', gpuWorkingSetBytes: 1 }),
    );
    const run = vi.fn(async () => '19069665280');
    const reader = createMachineReader({
      hostDir: dir,
      platform: 'darwin',
      arch: 'arm64',
      totalMemoryBytes: 24 * GIB,
      osRelease: '25.3.0',
      run,
    });
    await reader.start();
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(dir, 'machine.json'), 'utf8'))).toMatchObject({
      osRelease: '25.3.0',
    });
  });

  it('takes the largest NVIDIA device, and leaves the figure out where no probe answers', async () => {
    const nvidia = createMachineReader({
      hostDir: await hostDir(),
      platform: 'linux',
      arch: 'x64',
      totalMemoryBytes: 64 * GIB,
      osRelease: '6.8',
      run: async () => '24576\n49152\n',
    });
    await nvidia.start();
    expect(nvidia.current()).toEqual({
      totalMemoryBytes: 64 * GIB,
      unifiedMemory: false,
      gpuWorkingSetBytes: 49152 * 1024 ** 2,
    });

    const none = createMachineReader({
      hostDir: await hostDir(),
      platform: 'linux',
      arch: 'x64',
      totalMemoryBytes: 16 * GIB,
      osRelease: '6.8',
      run: async () => {
        throw new Error('nvidia-smi: command not found');
      },
    });
    await none.start();
    expect(none.current().gpuWorkingSetBytes).toBeUndefined();
  });
});
