/**
 * Contract: how many coding agents a machine runs at once is the operator's
 * number, written to the machine's policy only when chosen and read back with
 * the default otherwise — by the executor's limit and by `host.binding.inspect`.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HOST_HARNESS_CONCURRENCY_DEFAULT, HostBindingInspectOutputSchema } from '@aflow/schemas';

import { HostPolicySchema, loadHostPolicy } from '../bindings.js';
import {
  CLEAR_HARNESS_CONCURRENCY,
  describeHarnessConcurrency,
  withHarnessConcurrency,
} from '../harnessConcurrency.js';
import { createHostHandler } from '../handlers/hostHandler.js';
import { serializePolicy, writePolicyAtomically } from '../policyFile.js';
import { noPushApprovals } from './fixtures/pushApprovals.js';

const FOLDER = {
  id: 'hb_app',
  root: '/tmp/app',
  mode: 'readwrite',
  allowsExecution: true,
  spaceId: 'space-a',
};

const NEVER_CHOSE = HostPolicySchema.parse({ version: 1, bindings: [FOLDER] });

async function policyFile(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'harness-concurrency-'));
  return join(base, 'host-policy.json');
}

function inspectContext(captured: { output?: unknown }): never {
  return {
    operationId: 'host.binding.inspect',
    spaceId: 'space-a',
    runId: 'run-a',
    stepExecutionId: 'step-1',
    job: { inputRef: 'inline:x' },
    signal: new AbortController().signal,
    log: { error: () => undefined, warn: () => undefined, info: () => undefined },
    readPayload: () => Promise.resolve({ bindingId: FOLDER.id }),
    writePayload: (_kind: string, data: unknown) => {
      captured.output = data;
      return Promise.resolve('inline:out');
    },
  } as never;
}

describe('harness concurrency — what the policy holds', () => {
  it('writes nothing for a machine that never chose, and reads the default back', async () => {
    const path = await policyFile();
    await writePolicyAtomically(path, serializePolicy(NEVER_CHOSE));

    expect(await readFile(path, 'utf8')).not.toContain('maxConcurrentHarnessRuns');
    expect((await loadHostPolicy(path)).maxConcurrentHarnessRuns).toBe(
      HOST_HARNESS_CONCURRENCY_DEFAULT,
    );
  });

  it('writes the number the operator chose, and reads it back', async () => {
    const path = await policyFile();
    await writePolicyAtomically(path, serializePolicy(withHarnessConcurrency(NEVER_CHOSE, '3')));

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ maxConcurrentHarnessRuns: 3 });
    expect((await loadHostPolicy(path)).maxConcurrentHarnessRuns).toBe(3);
  });

  it('forgets the number on --clear, so the default reaches the machine again', () => {
    const chosen = withHarnessConcurrency(NEVER_CHOSE, '4');
    const cleared = withHarnessConcurrency(chosen, CLEAR_HARNESS_CONCURRENCY);

    expect('maxConcurrentHarnessRuns' in cleared).toBe(false);
    expect(cleared.bindings).toEqual(chosen.bindings);
  });

  it('refuses anything but a whole number of at least one, naming what it was given', () => {
    for (const requested of ['0', 'two', '1.5', '-1', '', '3 ']) {
      expect(() => withHarnessConcurrency(NEVER_CHOSE, requested)).toThrow(
        `\`${requested}\` is not a number of coding agents`,
      );
    }
  });

  it('refuses a policy file holding a number no limit can take', () => {
    for (const maxConcurrentHarnessRuns of [0, 1.5, 'two']) {
      expect(
        HostPolicySchema.safeParse({ version: 1, bindings: [], maxConcurrentHarnessRuns }).success,
      ).toBe(false);
    }
  });

  it('says in one line how many run, and whether that is the default', () => {
    expect(describeHarnessConcurrency(NEVER_CHOSE)).toBe(
      `runs ${String(HOST_HARNESS_CONCURRENCY_DEFAULT)} coding agents at once, the default; a run past that waits for one to end`,
    );
    expect(describeHarnessConcurrency(withHarnessConcurrency(NEVER_CHOSE, '1'))).toBe(
      'runs one coding agent at once; a run past that waits for one to end',
    );
  });
});

describe('harness concurrency — as host.binding.inspect shows it', () => {
  it('shows the default for a machine that never chose', async () => {
    const path = await policyFile();
    await writeFile(path, serializePolicy(NEVER_CHOSE));
    const captured: { output?: unknown } = {};

    const result = await createHostHandler(path, noPushApprovals).execute(inspectContext(captured));

    expect(result.status).toBe('SUCCEEDED');
    expect(HostBindingInspectOutputSchema.parse(captured.output).maxConcurrentHarnessRuns).toBe(
      HOST_HARNESS_CONCURRENCY_DEFAULT,
    );
  });

  it('shows the number the operator chose', async () => {
    const path = await policyFile();
    await writeFile(path, serializePolicy(withHarnessConcurrency(NEVER_CHOSE, '5')));
    const captured: { output?: unknown } = {};

    await createHostHandler(path, noPushApprovals).execute(inspectContext(captured));

    expect(HostBindingInspectOutputSchema.parse(captured.output).maxConcurrentHarnessRuns).toBe(5);
  });
});
