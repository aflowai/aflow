/**
 * Contract: Yarn in a confined workload reaches the registry through the
 * sandbox's proxy, which it does not read from the environment.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildBaseEnv, createWorkloadDirs, WORKLOAD_YARNRC } from '../baseEnv.js';

describe('Yarn in a workload uses the sandbox proxy', () => {
  it('finds a configuration in its home naming the proxies the adapter sets', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aflow-yarnrc-'));
    try {
      await createWorkloadDirs(scratch);
      const home = buildBaseEnv(scratch, [], {})['HOME']!;
      const written = await readFile(join(home, '.yarnrc.yml'), 'utf8');
      expect(written).toBe(WORKLOAD_YARNRC);
      // Interpolated by Yarn when it starts, empty where no proxy is set.
      expect(written.split('\n')).toEqual([
        "httpProxy: '${HTTP_PROXY:-}'",
        "httpsProxy: '${HTTPS_PROXY:-}'",
        '',
      ]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
