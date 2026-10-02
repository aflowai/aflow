/**
 * Contract: a streaming host job is reaped for silence, never for taking the
 * time its own ceiling allows. Everything else keeps the executor's flat clock.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HOST_CHECKS_TIMEOUT_DEFAULT_MS } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import {
  HOST_CHECK_CHECKOUT_MARGIN_MS,
  HOST_OUTER_TIMEOUT_MARGIN_MS,
  HOST_STREAM_IDLE_MS,
  resolveHostTimeout,
} from '../handlers/hostTimeout.js';

function ctxFor(
  operationId: string,
  input: Record<string, unknown>,
  stepTimeoutMs?: number,
): ExecutorContext {
  return {
    operationId,
    job: { inputRef: 'inline:x' },
    readPayload: async () => input,
    ...(stepTimeoutMs === undefined
      ? {}
      : { stepDefinition: { timeout: { executionTimeoutMs: stepTimeoutMs } } }),
  } as unknown as ExecutorContext;
}

/** No policy at all: every lane but the check's reads none. */
const NO_POLICY = join(tmpdir(), 'aflow-host-timeout-no-policy', 'host-policy.json');

async function resolveFor(ctx: ExecutorContext, policyPath = NO_POLICY) {
  return await resolveHostTimeout(ctx, policyPath);
}

describe('resolveHostTimeout', () => {
  it('gives a harness run an idle deadline under its own ceiling', async () => {
    const spec = await resolveFor(
      ctxFor('host.harness.run', { bindingId: 'b', task: 't', timeoutMs: 1_800_000 }),
    );
    expect(spec).toEqual({
      idleMs: HOST_STREAM_IDLE_MS,
      maxMs: 1_800_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
    });
  });

  it('never lets the idle deadline outlive the ceiling', async () => {
    const spec = await resolveFor(
      ctxFor('host.harness.run', { bindingId: 'b', task: 't', timeoutMs: 60_000 }),
    );
    expect(spec).toEqual({
      idleMs: 60_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
      maxMs: 60_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
    });
  });

  it('treats a foreground command the same way, and a detached one as instant', async () => {
    const running = await resolveFor(
      ctxFor('host.process.exec', {
        bindingId: 'b',
        command: ['yarn', 'test'],
        timeoutMs: 600_000,
      }),
    );
    expect(running).toEqual({
      idleMs: Math.min(HOST_STREAM_IDLE_MS, 600_000 + HOST_OUTER_TIMEOUT_MARGIN_MS),
      maxMs: 600_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
    });
    const detached = await resolveFor(
      ctxFor('host.process.exec', { bindingId: 'b', command: ['yarn', 'dev'], detach: true }),
    );
    expect(detached).toBeUndefined();
  });

  it('leaves the flat clock to a file read, an unreadable input, and an operator-set step timeout', async () => {
    expect(
      await resolveFor(ctxFor('host.file.get', { bindingId: 'b', path: 'x' })),
    ).toBeUndefined();
    expect(
      await resolveFor(ctxFor('host.harness.run', { nonsense: true })),
    ).toBeUndefined();
    expect(
      await resolveFor(ctxFor('host.harness.run', { bindingId: 'b', task: 't' }, 120_000)),
    ).toBeUndefined();
  });
});

describe('resolveHostTimeout for a check', () => {
  const SHA = 'c'.repeat(40);
  const BASE = 'a'.repeat(40);

  async function policyWith(branchPolicy: Record<string, unknown> | undefined): Promise<string> {
    const policyPath = join(await mkdtemp(join(tmpdir(), 'host-timeout-check-')), 'host-policy.json');
    await writeFile(
      policyPath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            id: 'hb_app',
            root: '/tmp/app',
            mode: 'readwrite',
            allowsExecution: true,
            spaceId: 'space-a',
            ...(branchPolicy !== undefined ? { branchPolicy } : {}),
          },
        ],
      }),
    );
    return policyPath;
  }

  const checkCtx = () => ctxFor('host.commit.check', { bindingId: 'hb_app', sha: SHA, base: BASE });

  it("gives a check the folder's own time, with room for its checkout, and no caller a say in it", async () => {
    const policyPath = await policyWith({
      branchPrefix: 'aflow/',
      checks: ['node', 'check.mjs'],
      checksTimeoutMs: 600_000,
    });
    const maxMs = 600_000 + HOST_CHECK_CHECKOUT_MARGIN_MS + HOST_OUTER_TIMEOUT_MARGIN_MS;
    expect(await resolveFor(checkCtx(), policyPath)).toEqual({
      idleMs: Math.min(HOST_STREAM_IDLE_MS, maxMs),
      maxMs,
    });
  });

  it('gives checks with no time chosen the default', async () => {
    const policyPath = await policyWith({ branchPrefix: 'aflow/', checks: ['node', 'check.mjs'] });
    expect((await resolveFor(checkCtx(), policyPath))?.maxMs).toBe(
      HOST_CHECKS_TIMEOUT_DEFAULT_MS + HOST_CHECK_CHECKOUT_MARGIN_MS + HOST_OUTER_TIMEOUT_MARGIN_MS,
    );
  });

  it('leaves the flat clock to a folder with no checks, one it cannot find, and no policy', async () => {
    expect(await resolveFor(checkCtx(), await policyWith({ branchPrefix: 'aflow/' }))).toBeUndefined();
    expect(await resolveFor(checkCtx(), await policyWith(undefined))).toBeUndefined();
    expect(
      await resolveFor(
        ctxFor('host.commit.check', { bindingId: 'hb_other', sha: SHA, base: BASE }),
        await policyWith({ branchPrefix: 'aflow/', checks: ['node'] }),
      ),
    ).toBeUndefined();
    expect(await resolveFor(checkCtx())).toBeUndefined();
  });
});
