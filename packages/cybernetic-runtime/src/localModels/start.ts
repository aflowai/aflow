/**
 * Starting the space's runtime from the workspace (Plan 323 D15), which only
 * this machine's paired executor can do: the server may run in a container
 * that reaches the machine's Ollama but cannot start a program there.
 */
import {
  askHost,
  hostRuntimeAnswerChannel,
  hostRuntimeRequestChannel,
  HostRuntimeAnswerSchema,
  newHostAnswerId,
  type HostExchangeConnections,
  type HostRuntimeRequest,
} from '@aflow/redis';
import { localRuntimeStartable } from './diagnose.js';
import type { LocalModelActionOutcome } from './actions.js';
import type { SpaceLocalRuntime } from './runtime.js';

/** Past the executor's own wait for the runtime to answer, so its answer arrives first. */
export const RUNTIME_START_ANSWER_TIMEOUT_MS = 40_000;

export async function startSpaceLocalRuntime(
  runtime: SpaceLocalRuntime,
  connections: HostExchangeConnections | undefined,
): Promise<LocalModelActionOutcome> {
  const hostname = runtime.hostname;
  if (!localRuntimeStartable(runtime) || hostname === undefined || connections === undefined) {
    return {
      ok: false,
      reason: 'not_here',
      message:
        'Only a runtime on this computer, with its executor paired, can be started from here. Start Ollama on the machine it runs on.',
    };
  }
  const answerId = newHostAnswerId();
  const request: HostRuntimeRequest = {
    kind: 'start',
    hostname,
    answerId,
    port: Number(runtime.runtimeId.split(':').at(-1)),
  };
  const exchanged = await askHost(connections, {
    requestChannel: hostRuntimeRequestChannel(hostname),
    answerChannel: hostRuntimeAnswerChannel(answerId),
    request,
    parse: (value) => HostRuntimeAnswerSchema.safeParse(value).data,
    timeoutMs: RUNTIME_START_ANSWER_TIMEOUT_MS,
  });
  if (exchanged.status === 'not_listening') {
    return {
      ok: false,
      reason: 'host',
      message: `No executor on ${hostname} is listening. Restart it there, or start Ollama yourself.`,
    };
  }
  if (exchanged.status === 'no_answer') {
    return {
      ok: false,
      reason: 'host',
      message: `The executor on ${hostname} took the request and has not answered after ${RUNTIME_START_ANSWER_TIMEOUT_MS / 1000} seconds. Its log says whether Ollama started.`,
    };
  }
  const { answer } = exchanged;
  return answer.kind === 'started'
    ? { ok: true, message: answer.message }
    : { ok: false, reason: 'runtime', message: answer.message };
}
