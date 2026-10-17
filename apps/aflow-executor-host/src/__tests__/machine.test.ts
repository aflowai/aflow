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
      freeDisk: async () => undefined,
    };

    const first = createMachineReader(options);
    expect(await first.current()).toEqual({ totalMemoryBytes: 24 * GIB, unifiedMemory: true });
    await first.start();
    expect((await first.current()).gpuWorkingSetBytes).toBe(19_069_665_280);

    const second = createMachineReader(options);
    await second.start();
    expect((await second.current()).gpuWorkingSetBytes).toBe(19_069_665_280);
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
      freeDisk: async () => undefined,
    });
    await nvidia.start();
    expect(await nvidia.current()).toEqual({
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
      freeDisk: async () => undefined,
    });
    await none.start();
    expect((await none.current()).gpuWorkingSetBytes).toBeUndefined();
  });

  it('reads the free disk under the model store at every read, since downloads change it', async () => {
    let free = 100 * GIB;
    const paths: string[] = [];
    const reader = createMachineReader({
      hostDir: await hostDir(),
      platform: 'linux',
      arch: 'x64',
      totalMemoryBytes: 16 * GIB,
      osRelease: '6.8',
      run: async () => '',
      modelStore: '/models',
      freeDisk: async (path) => {
        paths.push(path);
        return free;
      },
    });

    expect((await reader.current()).freeDiskBytes).toBe(100 * GIB);
    free = 84 * GIB;
    expect((await reader.current()).freeDiskBytes).toBe(84 * GIB);
    expect(paths).toEqual(['/models', '/models']);
  });
});
