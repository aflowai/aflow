/**
 * Contract: what streams live is the workload talking.
 *
 * A harness step's deltas land in a session as if the agent were saying them,
 * and standard error is the sandbox's debug channel as much as the workload's —
 * the proxy narrating its sockets, the restrictions it applied, the whole task
 * quoted back on the command line. All of it is kept as diagnostics on the
 * result; none of it is narrated.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostBindingSchema } from '../bindings.js';
import { OUTPUT_CAP_BYTES, runSandboxed, sandboxAvailable } from '../sandboxedRun.js';

let root: string;
let scratch: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aflow-stream-'));
  scratch = await mkdtemp(join(tmpdir(), 'aflow-stream-scr-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe('the live stream', () => {
  it.runIf(sandboxAvailable())(
    'carries standard output and keeps standard error as diagnostics',
    async () => {
      const deltas: string[] = [];
      const result = await runSandboxed({
        binding: HostBindingSchema.parse({
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: true,
        }),
        argv: ['/bin/sh', '-c', 'echo the-harness-speaking; echo the-diagnostics 1>&2'],
        cwd: root,
        env: {},
        // The debug channel this lane sets so the proxy will name what it
        // refused. Its cost is that everything else it says lands there too.
        trustedEnv: { SRT_DEBUG: '1' },
        timeoutMs: 60_000,
        scratchDir: scratch,
        idPrefix: 'ls',
        ownerRunId: 'probe',
        closeStdin: true,
        signal: new AbortController().signal,
        onDelta: (text) => deltas.push(text),
      });

      const streamed = deltas.join('');
      expect(streamed).toContain('the-harness-speaking');
      expect(streamed).not.toContain('the-diagnostics');
      expect(streamed).not.toContain('SandboxDebug');
      expect(streamed).not.toContain('Applied restrictions');

      // Kept, not discarded: a run that failed says why here.
      expect(result.stdout).toContain('the-harness-speaking');
      expect(result.stderr).toContain('the-diagnostics');
      expect(result.stderr).toContain('[SandboxDebug]');
    },
    120_000,
  );

  it.runIf(sandboxAvailable())(
    'reports output on either stream, and streams standard error only when asked',
    async () => {
      const deltas: string[] = [];
      let outputs = 0;
      const run = async (liveStderr: boolean): Promise<string> => {
        deltas.length = 0;
        const result = await runSandboxed({
          binding: HostBindingSchema.parse({
            id: 'hb',
            root,
            mode: 'readwrite',
            allowsExecution: true,
          }),
          argv: ['/bin/sh', '-c', 'echo the-progress-report 1>&2'],
          cwd: root,
          env: {},
          timeoutMs: 60_000,
          scratchDir: scratch,
          idPrefix: 'ls',
          ownerRunId: 'probe',
          closeStdin: true,
          liveStderr,
          signal: new AbortController().signal,
          onDelta: (text) => deltas.push(text),
          onOutput: () => {
            outputs += 1;
          },
        });
        expect(result.stderr).toContain('the-progress-report');
        return deltas.join('');
      };

      // Nothing was narrated, and the step must still be able to tell the
      // difference between a quiet workload and a dead one.
      expect(await run(false)).not.toContain('the-progress-report');
      expect(outputs).toBeGreaterThan(0);

      expect(await run(true)).toContain('the-progress-report');
    },
    120_000,
  );

  it.runIf(sandboxAvailable())(
    'keeps streaming past the stored-output budget, and says the stored copy is short',
    async () => {
      // The budget bounds the payload, not the feed. Enforced on the live path
      // it silenced a working harness at the cap: the deltas are parsed as they
      // arrive, so the run's final event never reached the reader and the step
      // ended with a raw line where its answer should have been.
      const lines = Math.ceil((OUTPUT_CAP_BYTES * 1.5) / 1000);
      const deltas: string[] = [];
      const result = await runSandboxed({
        binding: HostBindingSchema.parse({
          id: 'hb',
          root,
          mode: 'readwrite',
          allowsExecution: true,
        }),
        argv: [
          '/bin/sh',
          '-c',
          `i=0; while [ $i -lt ${String(lines)} ]; do printf '%0999d\\n' $i; i=$((i+1)); done; echo the-last-word`,
        ],
        cwd: root,
        env: {},
        timeoutMs: 120_000,
        scratchDir: scratch,
        idPrefix: 'ls',
        ownerRunId: 'probe',
        closeStdin: true,
        signal: new AbortController().signal,
        onDelta: (text) => deltas.push(text),
      });

      const streamed = deltas.join('');
      expect(streamed.length).toBeGreaterThan(OUTPUT_CAP_BYTES);
      // The one that matters: what a reader needs to finish is the end.
      expect(streamed).toContain('the-last-word');

      expect(result.stdout.length).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
      expect(result.truncated).toBe(true);
    },
    180_000,
  );
});
