import { describe, expect, it } from 'vitest';
import type { HostExchangeConnections, HostRuntimeRequest } from '@aflow/redis';
import { startSpaceLocalRuntime } from '../start.js';
import type { SpaceLocalRuntime } from '../runtime.js';

function runtime(overrides: Partial<SpaceLocalRuntime> = {}): SpaceLocalRuntime {
  return {
    config: {},
    client: {} as SpaceLocalRuntime['client'],
    runtimeId: 'this-machine:11434',
    credential: { id: 'c', scope: 'user', scopeId: 'u' },
    hostMachine: undefined,
    hostname: 'studio',
    ...overrides,
  };
}

/** An executor that answers each request with `answer`, or that nobody runs. */
function machine(answer: unknown | 'nobody') {
  const asked: Array<{ channel: string; request: HostRuntimeRequest }> = [];
  let deliver: ((channel: string, message: string) => void) | undefined;
  let answerChannel = '';
  const connections: HostExchangeConnections = {
    publish: async (channel, message) => {
      if (answer === 'nobody') return 0;
      asked.push({ channel, request: JSON.parse(message) as HostRuntimeRequest });
      queueMicrotask(() => deliver?.(answerChannel, JSON.stringify(answer)));
      return 1;
    },
    subscriber: () => ({
      on: (_event, listener) => {
        deliver = listener;
      },
      subscribe: async (channel) => {
        answerChannel = channel;
      },
      disconnect: () => undefined,
    }),
  };
  return { connections, asked };
}

describe('starting the runtime from the workspace', () => {
  it('asks the executor of the machine it runs on, for the port the connection names', async () => {
    const { connections, asked } = machine({ kind: 'started', message: 'Opened the Ollama app.' });

    const outcome = await startSpaceLocalRuntime(
      runtime({ runtimeId: 'this-machine:11500' }),
      connections,
    );

    expect(outcome).toEqual({ ok: true, message: 'Opened the Ollama app.' });
    expect(asked[0]?.channel).toBe('aflow:pubsub:host-runtime:studio');
    expect(asked[0]?.request).toMatchObject({ kind: 'start', hostname: 'studio', port: 11500 });
  });

  it('carries the executor’s refusal in its own words', async () => {
    const { connections } = machine({ kind: 'refused', message: 'Ollama is not installed.' });

    expect(await startSpaceLocalRuntime(runtime(), connections)).toEqual({
      ok: false,
      reason: 'runtime',
      message: 'Ollama is not installed.',
    });
  });

  it('says no executor is listening rather than waiting for an answer that cannot come', async () => {
    const { connections } = machine('nobody');

    expect(await startSpaceLocalRuntime(runtime(), connections)).toMatchObject({
      ok: false,
      reason: 'host',
    });
  });

  it('refuses a runtime on another machine, or one with no executor paired here', async () => {
    const { connections, asked } = machine({ kind: 'started', message: '' });

    for (const elsewhere of [
      runtime({ runtimeId: 'gpu-box.lan:11434' }),
      runtime({ hostname: undefined }),
    ]) {
      expect(await startSpaceLocalRuntime(elsewhere, connections)).toMatchObject({
        ok: false,
        reason: 'not_here',
      });
    }
    expect(asked).toHaveLength(0);
  });
});
