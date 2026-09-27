/**
 * Guard: every site that resolves a running step's policies goes through
 * `resolveAgentPoliciesFromConfig`.
 *
 * The same three fields were read out of `stepDef.config` in three places —
 * turn assembly, decision application, invalid-decision recovery. They agreed
 * until a fourth input arrived: `unattended` was added to assembly alone, so a
 * scheduled assistant was told not to ask and then judged by the standing
 * policy as though it could, and parked on a question nobody would read.
 *
 * A copy is cheap to make and silent when it drifts, so the rule is mechanical:
 * `resolveAgentPolicies` — the primitive that knows nothing about where config
 * lives — is called only by the shared resolver.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';

import { describe, it, expect } from 'vitest';

const orchestratorSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('agent policy resolution consolidation', () => {
  it('no orchestrator module calls resolveAgentPolicies directly', async () => {
    const offenders: string[] = [];
    for await (const file of glob('**/*.ts', { cwd: orchestratorSrc })) {
      if (file.includes('__tests__') || file.endsWith('.test.ts')) continue;
      const src = await readFile(join(orchestratorSrc, file), 'utf-8');
      // The shared resolver is the only caller; everything else asks it.
      if (/\bresolveAgentPolicies\s*\(/.test(src)) {
        offenders.push(relative(orchestratorSrc, join(orchestratorSrc, file)));
      }
    }
    expect(offenders).toEqual([]);
  });
});
